// Production server for a plain VM: serves the static build and proxies the
// agent API to Vultr Serverless Inference. Zero npm dependencies.
// The API key stays on the server; the browser only ever talks to /api/agent.
//
//   VULTR_INFERENCE_API_KEY=... VULTR_BASE_URL=https://api.vultrinference.com/v1 \
//   node deploy/server.mjs   (PORT=8080 by default, serves ./dist)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AuthStore, clearSessionCookie, parseCookies, sessionCookie } from './auth.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = process.env.DIST ?? 'dist';
const KEY = process.env.VULTR_INFERENCE_API_KEY;
const BASE = process.env.VULTR_BASE_URL ?? 'https://api.vultrinference.com/v1';
// Optional private-demo lock: when set, inference requires the access key
// (the app forwards ?key=<token> from its URL). Static pages stay public,
// credits do not.
const DEMO_TOKEN = process.env.DEMO_TOKEN;
// Multi-user mode: AUTH_ENABLED=1 turns on signup/login, per-user stores
// and per-account daily inference quotas. Anyone can register and test,
// nobody can drain the Vultr credits.
const AUTH_ENABLED = process.env.AUTH_ENABLED === '1';
const auth = AUTH_ENABLED
  ? new AuthStore(process.env.DATA_DIR ?? './data', {
    userDailyLimit: Number(process.env.USER_DAILY_LIMIT ?? 150),
    globalDailyLimit: Number(process.env.GLOBAL_DAILY_LIMIT ?? 5000),
  })
  : null;
if (!KEY) { console.error('VULTR_INFERENCE_API_KEY is required'); process.exit(1); }

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const ALLOWED_PATHS = new Set(['/chat/completions', '/rerank']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

// Fixed-window rate limit per IP, mirrors functions/api/agent.ts.
const WINDOW_MS = 60_000, MAX_PER_WINDOW = 60;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip) ?? { start: now, n: 0 };
  if (now - h.start > WINDOW_MS) { h.start = now; h.n = 0; }
  h.n += 1;
  hits.set(ip, h);
  return h.n > MAX_PER_WINDOW;
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const ip = req.socket.remoteAddress ?? 'unknown';
    const sessionUser = auth ? auth.verifySession(parseCookies(req.headers.cookie).rc_session) : null;

    // --- accounts (only when AUTH_ENABLED=1) ---
    if (auth && url.pathname.startsWith('/api/auth/') && req.method === 'POST') {
      if (limited(ip)) { json(res, 429, { error: 'rate limited' }); return; }
      let payload = {};
      try { payload = JSON.parse(await readBody(req, 64 * 1024)); } catch { /* empty body is fine for logout */ }
      if (url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login') {
        const r = url.pathname === '/api/auth/signup'
          ? auth.signup(payload.email, payload.password)
          : auth.login(payload.email, payload.password);
        if (!r.ok) { json(res, r.code, { error: r.error }); return; }
        json(res, 200, { email: String(payload.email).trim().toLowerCase() }, {
          'set-cookie': sessionCookie(auth.issueSession(r.userId), req.headers['x-forwarded-proto'] === 'https'),
        });
        return;
      }
      if (url.pathname === '/api/auth/logout') {
        json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie });
        return;
      }
      json(res, 404, { error: 'unknown auth endpoint' });
      return;
    }

    if (url.pathname === '/api/me' && req.method === 'GET') {
      if (!auth) { json(res, 200, { auth: false }); return; }
      if (!sessionUser) { json(res, 401, { auth: true }); return; }
      json(res, 200, { auth: true, email: auth.emailOf(sessionUser), quota: auth.usageOf(sessionUser) });
      return;
    }

    if (auth && url.pathname === '/api/me/store') {
      if (!sessionUser) { json(res, 401, { error: 'sign in first' }); return; }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(auth.readStore(sessionUser));
        return;
      }
      if (req.method === 'PUT') {
        const r = auth.writeStore(sessionUser, await readBody(req, 2 * 1024 * 1024 + 1024));
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/agent') {
      if (limited(ip)) { res.writeHead(429).end('rate limited'); return; }
      const { path, body, token } = JSON.parse(await readBody(req));
      if (auth) {
        // Signed-in users only, inside their daily budget.
        if (!sessionUser) { json(res, 401, { error: 'sign in to use the agent' }); return; }
        const q = auth.consume(sessionUser);
        if (!q.allowed) { json(res, 429, { error: q.reason }); return; }
      } else if (DEMO_TOKEN && token !== DEMO_TOKEN) {
        json(res, 401, { error: 'access key required: open the app with ?key=<your access key>' });
        return;
      }
      if (!ALLOWED_PATHS.has(path)) { res.writeHead(400).end('path not allowed'); return; }
      const upstream = await fetch(BASE + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Static files with SPA fallback.
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(normalize(DIST))) { res.writeHead(403).end(); return; }
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(DIST, 'index.html');
    }
    const data = await readFile(file);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400',
    };
    // Full-corpus docs.json is tens of MB of text: gzip compressible types.
    const compressible = /json|javascript|text|svg/.test(type);
    if (compressible && (req.headers['accept-encoding'] ?? '').includes('gzip')) {
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
      res.end(gzipSync(data));
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (e) {
    res.writeHead(500).end(`server error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
});

server.listen(PORT, () => console.log(`RepairCenter serving ${DIST} on :${PORT}`));
