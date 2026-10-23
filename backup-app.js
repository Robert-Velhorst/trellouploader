import express from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-trello-backup';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
const digest = value => createHash('sha256').update(value).digest();

export function createBackupApp({ password, publicOrigin, runBackup, background = false,
  now = Date.now, sessionTtlMs = 8 * 60 * 60 * 1000 } = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('APP_PASSWORD must contain at least 12 characters');
  if (typeof runBackup !== 'function') throw new Error('A backup implementation is required');
  const origin = publicOrigin ? new URL(publicOrigin).origin : null;
  if (origin && !origin.startsWith('https://')) throw new Error('PUBLIC_URL must use HTTPS');
  const passwordHash = digest(password);
  const sessions = new Map(), jobs = new Map();
  let active = null;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const sameOrigin = req => !req.get('Origin') || (origin !== null && req.get('Origin') === origin);
  function pruneSessions() {
    for (const [key, expiry] of sessions) if (expiry <= now()) sessions.delete(key);
  }
  function requireAuth(req, res, next) {
    pruneSessions();
    const token = req.cookies?.[SESSION_COOKIE];
    const key = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token).toString('hex') : null;
    if (!key || !sessions.has(key)) return res.status(401).json({ error: 'Authentication required' });
    req.backupSessionKey = key;
    next();
  }
  function requireIntent(req, res, next) {
    if (!sameOrigin(req) || req.get('X-Backup-Request') !== '1') return res.status(403).json({ error: 'Explicit same-origin backup request required' });
    next();
  }
  const loginLimit = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
  app.post('/api/login', loginLimit, (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Origin not permitted' });
    if (typeof req.body?.password !== 'string' || !timingSafeEqual(digest(req.body.password), passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    pruneSessions();
    if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token).toString('hex'), now() + sessionTtlMs);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: sessionTtlMs });
    res.json({ authenticated: true });
  });
  app.post('/api/logout', requireAuth, requireIntent, (req, res) => {
    sessions.delete(req.backupSessionKey);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.sendStatus(204);
  });
  app.get('/api/backup', requireAuth, (_req, res) => res.set('Allow', 'POST').status(405).json({ error: 'Use POST with X-Backup-Request: 1' }));
  app.post('/api/backup', requireAuth, requireIntent, async (req, res) => {
    if (active) return res.status(409).json({ error: 'A backup is already running' });
    while (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
    const id = randomUUID(), job = { owner: req.backupSessionKey, status: 'running' };
    jobs.set(id, job); active = id;
    const task = Promise.resolve().then(runBackup).then(driveUrl => {
      job.status = 'completed'; job.driveUrl = driveUrl;
    }, () => { job.status = 'failed'; job.error = 'Backup failed'; }).finally(() => { active = null; });
    if (background) return res.status(202).json({ accepted: true, status: 'running', jobId: id });
    await task;
    if (job.status === 'failed') return res.status(500).json({ success: false, error: job.error });
    res.json({ success: true, status: 'completed', jobId: id, driveUrl: job.driveUrl });
  });
  app.get('/api/backup/:id', requireAuth, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.owner !== req.backupSessionKey) return res.status(404).json({ error: 'Backup not found' });
    res.json({ jobId: req.params.id, status: job.status, ...(job.driveUrl ? { driveUrl: job.driveUrl } : {}), ...(job.error ? { error: job.error } : {}) });
  });
  app.use((error, _req, res, _next) => {
    const requested = Number(error?.status);
    const status = Number.isInteger(requested) && requested >= 400 && requested < 500 ? requested : 500;
    res.status(status).json({ error: status === 413 ? 'Request too large' : status === 500 ? 'Request failed' : 'Invalid request' });
  });
  return app;
}
