interface Env { VULTR_INFERENCE_API_KEY: string; VULTR_BASE_URL?: string; DEMO_TOKEN?: string }

const ALLOWED = new Set(['/chat/completions', '/rerank']);
let calls: number[] = []; // per-isolate naive rate limit

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const now = Date.now();
  calls = calls.filter((t) => now - t < 60_000);
  if (calls.length >= 60) return json({ error: 'rate limited' }, 429);
  calls.push(now);

  let payload: { path?: string; body?: unknown; token?: string };
  try { payload = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!payload.path || !ALLOWED.has(payload.path)) return json({ error: 'path not allowed' }, 403);
  if (env.DEMO_TOKEN && payload.token !== env.DEMO_TOKEN) return json({ error: 'bad token' }, 401);

  const base = env.VULTR_BASE_URL ?? 'https://api.vultrinference.com/v1';
  const res = await fetch(base + payload.path, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.VULTR_INFERENCE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload.body),
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
};

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
