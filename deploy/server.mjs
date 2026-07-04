// Production server for a plain VM: serves the static build and proxies the
// agent API to Vultr Serverless Inference. Zero npm dependencies.
// The API key stays on the server; the browser only ever talks to /api/agent.
//
//   VULTR_INFERENCE_API_KEY=... VULTR_BASE_URL=https://api.vultrinference.com/v1 \
//   node deploy/server.mjs   (PORT=8080 by default, serves ./dist)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = process.env.DIST ?? 'dist';
const KEY = process.env.VULTR_INFERENCE_API_KEY;
const BASE = process.env.VULTR_BASE_URL ?? 'https://api.vultrinference.com/v1';
if (!KEY) { console.error('VULTR_INFERENCE_API_KEY is required'); process.exit(1); }

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

    if (req.method === 'POST' && url.pathname === '/api/agent') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      if (limited(ip)) { res.writeHead(429).end('rate limited'); return; }
      const { path, body } = JSON.parse(await readBody(req));
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
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500).end(`server error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
});

server.listen(PORT, () => console.log(`RepairCenter serving ${DIST} on :${PORT}`));
