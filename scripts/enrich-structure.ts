// Structure enrichment pass: nemoretriever-parse reads every corpus page
// image and writes a structuredText markdown layer (reading-order text with
// # / ## heading markers) next to the raw pdftotext layer. Section headings
// made explicit are what fixes the exclusions-polarity failure
// (bench/README.md): Nemotron-Omni answers the characterized case correctly
// the moment "## What is not covered" precedes the continued list.
// Build-time only: the NVIDIA key never reaches a browser.
//
// Usage: set -a; source .env; set +a
//        CORPUS_DIR=corpus-insurance npx tsx scripts/enrich-structure.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CORPUS = process.env.CORPUS_DIR ?? 'corpus-insurance';
const KEY = process.env.NVIDIA_API_KEY;
const CONCURRENCY = 4;

interface ParseBlock { bbox: Record<string, number>; text?: string; type?: string }
interface EnrichedPage { page: number; imageUrl: string; structuredText?: string; [k: string]: unknown }
interface EnrichedDoc { id: string; pages: EnrichedPage[]; [k: string]: unknown }

function toMarkdown(blocks: ParseBlock[]): string {
  return blocks.map((b) => {
    const t = (b.text ?? '').trim();
    if (!t) return null;
    if (b.type === 'Title') return `# ${t}`;
    if (b.type === 'Section-header') return `## ${t}`;
    if (b.type === 'Page-header' || b.type === 'Page-footer') return null;
    return t;
  }).filter(Boolean).join('\n');
}

async function parsePage(imagePath: string): Promise<string | null> {
  const b64 = readFileSync(imagePath).toString('base64');
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'nvidia/nemoretriever-parse',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }],
      max_tokens: 3072,
    }),
  });
  if (!res.ok) return null;
  const j = await res.json() as { choices?: { message?: { tool_calls?: { function: { arguments: string } }[] } }[] };
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;
  try {
    const pages = JSON.parse(call.function.arguments) as ParseBlock[][];
    const md = toMarkdown(pages[0] ?? []);
    return md.length > 40 ? md : null; // an empty or near-empty parse adds nothing
  } catch { return null; }
}

async function main() {
  if (!KEY) {
    console.error('Set NVIDIA_API_KEY (set -a; source .env; set +a)');
    process.exit(1);
  }
  const docsPath = join('public', CORPUS, 'docs.json');
  const docs = JSON.parse(readFileSync(docsPath, 'utf8')) as EnrichedDoc[];
  const jobs: { doc: EnrichedDoc; page: EnrichedPage }[] = [];
  for (const d of docs) for (const p of d.pages) if (!p.structuredText && p.imageUrl) jobs.push({ doc: d, page: p });
  console.log(`${CORPUS}: ${jobs.length} page(s) to parse`);

  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const md = await parsePage(join('public', job.page.imageUrl)).catch(() => null);
      if (md) job.page.structuredText = md; else failed++;
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${jobs.length} (${failed} without structure)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync(docsPath, JSON.stringify(docs));
  console.log(`done: ${done - failed}/${jobs.length} pages structured, wrote ${docsPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
