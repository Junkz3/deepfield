import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';

/** Dev-only stand-in for the production proxy (functions/api/agent.ts):
 *  lets `npm run dev` AND `vite preview` hit Vultr live without wrangler.
 *  Same allowlist. Preview matters: the demo video is captured against the
 *  built app on the preview server, live inference included. */
function devAgentProxy(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res) => {
    const env = loadEnv('development', process.cwd(), '');
    const key = env.VULTR_INFERENCE_API_KEY;
    const base = env.VULTR_BASE_URL ?? 'https://api.vultrinference.com/v1';
    const ALLOWED = new Set(['/chat/completions', '/rerank']);
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(raw) as { path?: string; body?: unknown };
        if (!payload.path || !ALLOWED.has(payload.path)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'path not allowed' }));
          return;
        }
        if (!key) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'VULTR_INFERENCE_API_KEY missing in app/.env' }));
          return;
        }
        const upstream = await fetch(base + payload.path, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload.body),
        });
        res.statusCode = upstream.status;
        res.setHeader('content-type', 'application/json');
        res.end(await upstream.text());
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  };
  return {
    name: 'dev-agent-proxy',
    configureServer(server) {
      server.middlewares.use('/api/agent', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/agent', handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), devAgentProxy()],
  test: { include: ['src/**/*.test.{ts,tsx}'] },
} as any);
