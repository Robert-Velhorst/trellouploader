import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { getDriveAuth, uploadCsvBackup } from '../drive-backup.js';

const environment = { GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-test-only',
  GOOGLE_REDIRECT_URI: 'https://backup.example.test/callback', GOOGLE_TOKEN_JSON: JSON.stringify({ access_token: 'synthetic-token', expiry_date: Date.now() + 3_600_000 }), GOOGLE_FOLDER_ID: 'synthetic-folder' };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'backup-unit-'));
  t.after(async () => { assert.deepEqual(await readdir(root), []); await rmdir(root); });
  return root;
}

test('OAuth construction preserves explicit credentials without a provider call', () => {
  const auth = getDriveAuth(environment);
  assert.equal(auth.credentials.access_token, 'synthetic-token');
  assert.throws(() => getDriveAuth({}), /GOOGLE_TOKEN_JSON missing/);
});

test('CSV export uses a private owned temporary directory and retains the Drive request contract', async t => {
  const tempRoot = await fixture(t);
  let requests = 0;
  const url = await uploadCsvBackup([{ board_name: 'Synthetic, board', card_name: 'Synthetic Unicode \u20ac', desc: 'line one\nline two' }], {
    environment, tempRoot, date: new Date('2026-10-23T12:00:00Z'),
    createDrive: auth => {
      assert.equal(auth.credentials.access_token, 'synthetic-token');
      return { files: { create: async request => {
        requests++;
        assert.deepEqual(request.requestBody, { name: 'trello_export_2026-10-23.csv', mimeType: 'text/csv', parents: ['synthetic-folder'] });
        assert.equal(request.media.mimeType, 'text/csv');
        let contents = ''; for await (const chunk of request.media.body) contents += chunk.toString('utf8');
        assert.match(contents, /"Synthetic, board"/); assert.match(contents, /Synthetic Unicode \u20ac/);
        assert.match(contents, /line one\nline two/);
        return { data: { id: 'synthetic-file_123' } };
      } } };
    },
  });
  assert.equal(url, 'https://drive.google.com/file/d/synthetic-file_123');
  assert.equal(requests, 1); assert.deepEqual(await readdir(tempRoot), []);
});

test('failed or invalid uploads close the stream and remove only the owned export', async t => {
  const tempRoot = await fixture(t);
  for (const failure of ['provider', 'response']) {
    await assert.rejects(uploadCsvBackup([{ card_name: 'synthetic' }], {
      environment, tempRoot, createDrive: () => ({ files: { create: async () => {
        if (failure === 'provider') throw new Error('synthetic upload failure');
        return { data: { id: '../unsupported' } };
      } } }),
    }), failure === 'provider' ? /synthetic upload failure/ : /Invalid Drive response/);
    assert.deepEqual(await readdir(tempRoot), []);
  }
});

test('missing credentials or folder fail before an export directory is created', async t => {
  const tempRoot = await fixture(t);
  await assert.rejects(uploadCsvBackup([], { environment: {}, tempRoot }), /GOOGLE_TOKEN_JSON missing/);
  await assert.rejects(uploadCsvBackup([], { environment: { ...environment, GOOGLE_FOLDER_ID: '' }, tempRoot }), /GOOGLE_FOLDER_ID missing/);
  assert.deepEqual(await readdir(tempRoot), []);
});

test('googleapis 188 serializes the multipart Drive v3 request through an isolated adapter', async () => {
  const requests = [];
  const adapter = async config => {
    requests.push(config);
    const url = new URL(config.url);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, '/upload/drive/v3/files');
    assert.equal(url.searchParams.get('uploadType'), 'multipart');
    assert.equal(new Headers(config.headers).get('authorization'), 'Bearer synthetic-token');
    let body = ''; for await (const chunk of config.data) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    assert.match(body, /synthetic-folder/); assert.match(body, /synthetic,value/);
    return { data: { id: 'synthetic-sdk-result' }, status: 200, statusText: 'OK', headers: new Headers(), config };
  };
  const auth = new google.auth.OAuth2({ clientId: 'synthetic-client', transporterOptions: { adapter } });
  auth.setCredentials({ access_token: 'synthetic-token', expiry_date: Date.now() + 3_600_000 });
  const drive = google.drive({ version: 'v3', auth });
  const response = await drive.files.create({ requestBody: { name: 'synthetic.csv', mimeType: 'text/csv', parents: ['synthetic-folder'] },
    media: { mimeType: 'text/csv', body: Readable.from(['synthetic,value\n']) } }, { adapter });
  assert.equal(response.data.id, 'synthetic-sdk-result'); assert.equal(requests.length, 1);
});
