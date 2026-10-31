import fs from 'node:fs';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { google } from 'googleapis';
import { Parser } from '@json2csv/plainjs';

const fields = ['board_name', 'board_url', 'board_closed', 'list_name', 'list_url', 'list_closed',
  'card_name', 'card_url', 'card_pos', 'desc', 'created_at', 'last_activity', 'archived_at', 'unarchived_at',
  'due', 'due_complete', 'closed', 'members', 'labels', 'comments', 'checklists', 'attachments', 'custom_fields'];

export function getDriveAuth(environment = process.env) {
  if (!environment.GOOGLE_TOKEN_JSON) throw new Error('GOOGLE_TOKEN_JSON missing');
  const auth = new google.auth.OAuth2(environment.GOOGLE_CLIENT_ID, environment.GOOGLE_CLIENT_SECRET, environment.GOOGLE_REDIRECT_URI);
  auth.setCredentials(JSON.parse(environment.GOOGLE_TOKEN_JSON));
  return auth;
}

export async function uploadCsvBackup(records, { environment = process.env, tempRoot = tmpdir(),
  createDrive = auth => google.drive({ version: 'v3', auth }), date = new Date() } = {}) {
  const auth = getDriveAuth(environment);
  if (!environment.GOOGLE_FOLDER_ID) throw new Error('GOOGLE_FOLDER_ID missing');
  const drive = createDrive(auth);
  const directory = await mkdtemp(path.join(path.resolve(tempRoot), 'trello-backup-'));
  const filePath = path.join(directory, `trello_export_${date.toISOString().slice(0, 10)}.csv`);
  let body, closed;
  try {
    await writeFile(filePath, new Parser({ fields }).parse(records), { encoding: 'utf8', mode: 0o600 });
    body = fs.createReadStream(filePath);
    closed = finished(body, { cleanup: true }).catch(() => {});
    const response = await drive.files.create({ requestBody: { name: path.basename(filePath),
      mimeType: 'text/csv', parents: [environment.GOOGLE_FOLDER_ID] }, media: { mimeType: 'text/csv', body } });
    if (typeof response.data?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(response.data.id)) throw new Error('Invalid Drive response');
    return `https://drive.google.com/file/d/${response.data.id}`;
  } finally {
    if (body) { body.destroy(); await closed; }
    await unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}
