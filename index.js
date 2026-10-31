import { createBackupApp } from './backup-app.js';
import { uploadCsvBackup } from './drive-backup.js';
import 'dotenv/config';
import axios from 'axios';
import Bottleneck from 'bottleneck';


/* ============================================================
 *  🔹 0. YARDIMCI: SONSUZ RETRY (429 → 10sn bekle)
 * ============================================================ */
async function retryForever(fn, delayMs = 10000) {
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        console.warn(`⏳ 429 alındı. ${delayMs / 1000} saniye bekleniyor...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err; // gerçek hata → yukarı fırlat
    }
  }
}

/* ============================================================
 *  🔹 1. GOOGLE DRIVE AUTH (ENV TOKEN)
 * ============================================================ */
/* ============================================================
 *  🔹 2. TRELLO VERİLERİNİ ÇEK (%0 VERİ KAYBI)
 * ============================================================ */
function getCardCreationDate(cardId) {
  const timestamp = parseInt(cardId.substring(0, 8), 16);
  return new Date(timestamp * 1000).toISOString();
}

function formatCustomFieldValue(item, boardCustomFieldsById) {
  const def = boardCustomFieldsById[item.idCustomField];
  if (!def) return null;

  const name = def.name || def.id;

  if (item.value?.text != null) return `${name}=${item.value.text}`;
  if (item.value?.number != null) return `${name}=${item.value.number}`;
  if (item.value?.date != null) return `${name}=${item.value.date}`;
  if (typeof item.value?.checked !== 'undefined') {
    return `${name}=${item.value.checked ? 'true' : 'false'}`;
  }
  if (item.idValue) {
    const opt = (def.options || []).find(o => o.id === item.idValue);
    const optText = opt?.value?.text || opt?.value?.label || opt?.id || 'option';
    return `${name}=${optText}`;
  }
  return `${name}=[unknown]`;
}

function extractArchiveTimestamps(actions) {
  let archivedAt = '';
  let unarchivedAt = '';

  for (const a of actions) {
    if (a.type === 'updateCard' && a.data?.old && a.data?.card) {
      if (a.data.old.closed === false && a.data.card.closed === true && !archivedAt) {
        archivedAt = a.date;
      }
      if (a.data.old.closed === true && a.data.card.closed === false && !unarchivedAt) {
        unarchivedAt = a.date;
      }
    }
  }
  return { archivedAt, unarchivedAt };
}

async function fetchTrelloData() {
  const { TRELLO_KEY, TRELLO_TOKEN } = process.env;
  const base = `https://api.trello.com/1`;
  const params = `key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;

  console.log('🔄 Trello verileri çekiliyor...');

  const limiter = new Bottleneck({
    minTime: 500,
    maxConcurrent: 1
  });

  const boardsRes = await retryForever(() =>
    limiter.schedule(() =>
      axios.get(`${base}/members/me/boards?filter=all&${params}`)
    )
  );

  const boards = boardsRes.data;
  const allData = [];

  for (const board of boards) {
    const listsRes = await retryForever(() =>
      limiter.schedule(() =>
        axios.get(`${base}/boards/${board.id}/lists?filter=all&${params}`)
      )
    );
    const listsById = new Map(listsRes.data.map(l => [l.id, l]));

    let boardCustomFields = [];
    try {
      const cfRes = await retryForever(() =>
        limiter.schedule(() =>
          axios.get(`${base}/boards/${board.id}/customFields?${params}`)
        )
      );
      boardCustomFields = cfRes.data || [];
    } catch {}

    const boardCustomFieldsById = {};
    for (const def of boardCustomFields) boardCustomFieldsById[def.id] = def;

    const cardsRes = await retryForever(() =>
      limiter.schedule(() =>
        axios.get(`${base}/boards/${board.id}/cards?filter=all&${params}`)
      )
    );

    for (const card of cardsRes.data) {
      console.log(`➡️ Kart işleniyor: ${card.name}`);

      const [
        labelsRes,
        membersRes,
        checklistsRes,
        attachmentsRes,
        commentsRes,
        actionsRes,
        customFieldItemsRes
      ] = await Promise.all([
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/labels?${params}`))),
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/members?${params}`))),
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/checklists?${params}`))),
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/attachments?${params}`))),
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/actions?filter=commentCard&limit=1000&${params}`))),
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/actions?filter=updateCard,createCard,copyCard,moveCardFromBoard,moveCardToBoard&limit=1000&${params}`))),
        retryForever(() => limiter.schedule(() => axios.get(`${base}/cards/${card.id}/customFieldItems?${params}`)))
      ]);

      const list = listsById.get(card.idList);
      const { archivedAt, unarchivedAt } = extractArchiveTimestamps(actionsRes.data || []);

      allData.push({
        board_name: board.name,
        board_url: board.url,
        board_closed: board.closed ? 'true' : 'false',
        list_name: list?.name || '',
        list_url: `https://trello.com/b/${board.shortLink}`,
        list_closed: list?.closed ? 'true' : 'false',
        card_name: card.name,
        card_url: card.shortUrl,
        card_pos: card.pos,
        desc: card.desc,
        created_at: getCardCreationDate(card.id),
        last_activity: card.dateLastActivity || '',
        archived_at: archivedAt,
        unarchived_at: unarchivedAt,
        due: card.due || '',
        due_complete: card.dueComplete ? 'true' : 'false',
        closed: card.closed ? 'true' : 'false',
        members: membersRes.data.map(m => m.fullName).join(', '),
        labels: labelsRes.data.map(l => l.name).join(', '),
        comments: commentsRes.data.map(c => `${c.memberCreator?.fullName}: ${c.data?.text}`).join(' | '),
        checklists: checklistsRes.data.map(chk =>
          `${chk.name}: ${chk.checkItems?.map(i => `${i.name} (${i.state})`).join('; ')}`
        ).join(' | '),
        attachments: attachmentsRes.data.map(a => a.url).join(', '),
        custom_fields: customFieldItemsRes.data
          .map(i => formatCustomFieldValue(i, boardCustomFieldsById))
          .filter(Boolean)
          .join(' | ')
      });
    }
  }

  console.log(`✅ TÜM kartlar eksiksiz çekildi: ${allData.length}`);
  return allData;
}

/* ============================================================
 *  🔹 3. CSV + DRIVE
 * ============================================================ */
const app = createBackupApp({
  password: process.env.APP_PASSWORD,
  publicOrigin: process.env.PUBLIC_URL,
  background: true,
  runBackup: async () => uploadCsvBackup(await fetchTrelloData()),
});
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Backup service listening on ${host}:${port}`));
