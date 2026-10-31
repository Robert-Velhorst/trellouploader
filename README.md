# trellouploader

An Express API for backing up Trello data to a private Google Drive folder.
Deployment remains targeted at Hetzner; see [DEPLOYMENT_TARGET.md](DEPLOYMENT_TARGET.md).

## Configuration and startup

Use Node 26.12.1 (or supported patched Node 24.22.1+) and npm 12.2.1.
Copy `.env.example` to a private `.env` and configure the required Trello/Google
credentials and folder. Set `APP_PASSWORD` to a fresh private password of at least
12 characters. No default password is supplied. `PUBLIC_URL` must be the exact
HTTPS public origin when a browser client is used. The service binds to loopback
by default; configure `HOST` explicitly for a controlled container/reverse proxy.

Run `npm ci`, `npm run check`, then `npm start`. No frontend is bundled.
TLS must be provided by the deployment proxy: authentication cookies always use
Secure, HttpOnly, SameSite=Strict and a host-only root path.

The historical tracked `config.json` is not read by this service. Do not reuse a
password that has been committed as an active password. This change does not
remove historical Git data or establish whether any old credential was used live.

## API migration

- `POST /api/login` accepts JSON with a `password` string. Successful login sets
  an opaque eight-hour session cookie and returns `authenticated: true` plus a
  session-bound `csrfToken`. Password verification uses salted scrypt (N=32768, r=8, p=3).
  Login attempts are limited to five per minute. Sessions are process-local,
  capped at 20, and invalidated by logout, expiry or restart.
- `POST /api/backup` requires that session, `X-Backup-Request: 1`, and the login response token in `X-CSRF-Token`. Browser
  Origin must match `PUBLIC_URL`; non-browser clients may omit Origin. The legacy
  GET operation returns 405 after authentication and never starts a backup.
- Backup/logout requests share a limit of 30 per minute. Only one backup may run at a time. A competing request returns 409.
- `GET /api/backup/:jobId` returns only the initiating session's job state.
  States are `running`, `completed` and `failed`; completed jobs include the
  private Drive URL. Up to 20 job records remain in memory.
- `POST /api/logout` requires the session, `X-Backup-Request: 1` and `X-CSRF-Token`, revokes the
  session and clears its cookie.

This service retains background execution. Starting work returns HTTP 202 with
`accepted: true`, `status: "running"` and a job ID. Poll that job until completed;
acceptance is not an upload-success claim.

CSV exports use a unique private temporary directory; the stream is closed and
only the owned export/directory are removed after success or failure. Existing
files in the working directory are not overwritten or removed. The existing
Trello collection/retry behavior is otherwise retained; these changes do not
prove that a real provider backup is complete.

## Verification

`npm run check` runs syntax and offline tests. Tests use synthetic records,
loopback HTTP fixtures and an intercepted Google SDK transport adapter; no real
Trello collection, Google OAuth exchange or Drive upload is performed. The tests
cover session rejection/expiry/logout, POST/origin controls, rate limits,
background outcome reporting, temporary-file cleanup and SDK 188 multipart
request serialization. Live OAuth/folder access and deployed TLS still require
operator verification after review.
