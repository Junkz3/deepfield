// Reader shootout on the characterized polarity case (bench/README.md):
// which catalog model actually binds the continued exclusions list to its
// heading? One-shot answer calls, same question, same evidence.
// Measured 2026-07-05: MiMo-V2.5-Pro (vision), Qwen3.5-397B (vision),
// Kimi-K2.6 (text) and DeepSeek-V4-Flash (text, 3.2s) all read it right;
// Nemotron-Omni stays wrong even with the full text layer attached.
// Usage: set -a; source .env; set +a; npx tsx scripts/bench-readers.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.VULTR_BASE_URL!;
const KEY = process.env.VULTR_INFERENCE_API_KEY!;

interface BlockPage { page: number; imageUrl: string; textBlocks?: { text: string }[] }
const docs = JSON.parse(readFileSync('public/corpus-insurance/docs.json', 'utf8')) as { id: string; pages: BlockPage[] }[];
const h = docs.find((d) => d.id === 'hiscox-home-policy')!;
const page = (n: number) => h.pages.find((p) => p.page === n)!;
const img = (n: number) => `data:image/png;base64,${readFileSync(join('public', page(n).imageUrl)).toString('base64')}`;
const fullText = (n: number) => (page(n).textBlocks ?? []).map((b) => b.text).join('\n');

const QUESTION = 'Under home emergency, are repairs to a boiler over 15 years old covered?';
const PROMPT = `You are a technical assistant answering from the attached policy pages ONLY. Question: ${QUESTION}
Attached pages, in this order: p.11, p.12.
Answer fully but stay on the question. Cite pages like (p.11) after each fact. If the pages do not contain the answer, say exactly what is missing. Keep any internal reasoning under 60 words, then write the answer.`;

async function call(model: string, content: unknown): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 8000 }),
  });
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
  const j = await res.json() as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? '(empty)').trim();
}

async function main() {
  if (!BASE || !KEY) {
    console.error('Set VULTR_BASE_URL and VULTR_INFERENCE_API_KEY (set -a; source .env; set +a)');
    process.exit(1);
  }
  const imagesContent = [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: img(11) } },
    { type: 'image_url', image_url: { url: img(12) } },
  ];
  const textContent = `${PROMPT}\n\n[p.11 full text]\n${fullText(11)}\n\n[p.12 full text]\n${fullText(12)}`;
  const hybridContent = [
    { type: 'text', text: `${PROMPT}\n\n[p.11 full text layer]\n${fullText(11)}\n\n[p.12 full text layer]\n${fullText(12)}` },
    { type: 'image_url', image_url: { url: img(11) } },
    { type: 'image_url', image_url: { url: img(12) } },
  ];
  const RUNS: [string, string, unknown][] = [
    ['vision', 'XiaomiMiMo/MiMo-V2.5-Pro', imagesContent],
    ['vision', 'Qwen/Qwen3.5-397B-A17B', imagesContent],
    ['text', 'moonshotai/Kimi-K2.6', textContent],
    ['text', 'deepseek-ai/DeepSeek-V4-Flash', textContent],
    ['hybrid', 'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16', hybridContent],
  ];
  for (const [kind, model, content] of RUNS) {
    const t0 = Date.now();
    const out = await call(model, content);
    console.log(`\n===== [${kind}] ${model} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log(out.slice(0, 400).replace(/\n+/g, ' '));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
