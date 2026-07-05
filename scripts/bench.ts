// Live benchmark harness: runs the REAL agent loop (runStep + VultrDriver)
// over the versioned gold set (bench/goldset.json) and scores every answer
// automatically. This is the measured-performance side of the self-check
// feature: same loop, same driver, same scoring rules, but against
// hand-verified facts instead of model-written probes.
//
// Usage: set -a; source .env; set +a
//        npx tsx scripts/bench.ts [--only id1,id2] [--group g1,g2] [--concurrency 2] [--label run1]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStep } from '../src/agent/loop';
import { scoreProbe } from '../src/agent/selfcheck';
import { setWorkflowProfile, setWorkflowTeam } from '../src/agent/workflow';
import { VultrDriver, directTransport, setAgentLanguage } from '../src/vultr/client';
import { FREEFORM_SYMPTOM } from '../src/agent/types';
import type { Conversation, Document, GuidedStep } from '../src/agent/types';

interface BenchItem {
  id: string;
  group: string;
  type: 'qa' | 'diagnose' | 'no-evidence' | 'video' | 'scope' | 'judgment';
  corpus: 'repair' | 'insurance';
  profile?: string;
  lang?: string;
  freeform?: boolean;
  device: string;
  symptom: string;
  userInput?: string;
  mustContain: string[];
  expectDocId?: string;
  sourcePage?: number;
  note?: string;
}

interface BenchResult {
  id: string;
  group: string;
  type: string;
  pass: boolean;
  status: string;
  factFound: boolean;
  docCited: boolean | null;
  pageCited: boolean | null;
  videoCited: boolean;
  confidence: number;
  retrieveRounds: number;
  durationMs: number;
  phaseMs: Record<string, number>;
  citations: string[];
  answer: string;
  timeline: string[];
  error?: string;
}

const ITEM_TIMEOUT_MS = 300_000;

// The driver fetches page images by their site-relative URL (/corpus/...).
// In Node there is no origin: serve those straight from public/ on disk.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('/')) return new Response(readFileSync(join('public', url)));
  return realFetch(input, init);
}) as typeof fetch;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    only: get('--only')?.split(',').map((s) => s.trim()).filter(Boolean),
    group: get('--group')?.split(',').map((s) => s.trim()).filter(Boolean),
    concurrency: Number(get('--concurrency') ?? 2),
    label: get('--label') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function verdict(item: BenchItem, step: GuidedStep): Omit<BenchResult, 'id' | 'group' | 'type' | 'durationMs' | 'phaseMs' | 'retrieveRounds' | 'citations' | 'answer' | 'timeline'> {
  const d = step.diagnosis;
  const answerText = [step.answer, step.instruction, d?.component, d?.cause, ...(d?.checks ?? [])]
    .filter(Boolean).join(' ');
  const probe = scoreProbe(
    answerText, step.citations,
    { question: '', mustContain: item.mustContain },
    { docId: item.expectDocId ?? '', page: item.sourcePage ?? -999 },
  );
  const factFound = item.mustContain.length > 0 ? probe.factFound : true;
  const docCited = item.expectDocId ? step.citations.some((c) => c.docId === item.expectDocId) : null;
  const pageCited = item.sourcePage != null ? probe.pageCited : null;
  const videoCited = step.citations.some((c) => typeof c.timestamp === 'number');
  let pass: boolean;
  switch (item.type) {
    case 'qa':
    case 'diagnose':
      pass = factFound && docCited !== false && step.status === 'ok';
      break;
    case 'no-evidence':
      // The honest refusal is the pass; an answer that ADMITS the mismatch
      // (mustContain markers) also counts. Confident invention fails.
      pass = step.status === 'no-evidence' || (item.mustContain.length > 0 && factFound);
      break;
    case 'video':
      pass = videoCited;
      break;
    case 'scope':
      pass = step.status === 'ok' && factFound;
      break;
    case 'judgment':
      pass = factFound;
      break;
  }
  return { pass, status: step.status, factFound, docCited, pageCited, videoCited, confidence: step.confidence };
}

async function runItem(item: BenchItem, docs: Document[], driver: VultrDriver): Promise<BenchResult> {
  const conversation: Conversation = {
    id: `bench-${item.id}`,
    device: item.device,
    symptom: item.freeform ? FREEFORM_SYMPTOM : item.symptom,
    steps: [], attachments: [], userInputs: [], status: 'active',
  };
  const t0 = Date.now();
  const timeline: { phase: string; summary: string; t: number }[] = [];
  let retrieveRounds = 0;

  const exec = async (): Promise<GuidedStep> => {
    const gen = runStep({ conversation, docs, userInput: item.userInput }, driver);
    while (true) {
      const n = await gen.next();
      if (n.done) return n.value;
      timeline.push({ phase: n.value.phase, summary: n.value.summary, t: Date.now() - t0 });
      if (n.value.phase === 'retrieve' && n.value.summary.startsWith('Searching')) retrieveRounds++;
    }
  };

  try {
    const step = await Promise.race([
      exec(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('item timeout')), ITEM_TIMEOUT_MS)),
    ]);
    const durationMs = Date.now() - t0;
    // Coarse per-phase split: time from a phase's first event to the next
    // phase's first event (the last phase runs until the step returns).
    const phaseMs: Record<string, number> = {};
    for (let i = 0; i < timeline.length; i++) {
      const cur = timeline[i];
      if (phaseMs[cur.phase] != null) continue;
      const nextPhase = timeline.slice(i + 1).find((e) => e.phase !== cur.phase);
      phaseMs[cur.phase] = (nextPhase ? nextPhase.t : durationMs) - cur.t;
    }
    const d = step.diagnosis;
    return {
      id: item.id, group: item.group, type: item.type,
      ...verdict(item, step),
      retrieveRounds, durationMs, phaseMs,
      citations: step.citations.map((c) => c.label + (c.timestamp != null ? ` @${c.timestamp}s` : '')),
      answer: (step.answer ?? [d?.component, d?.cause, ...(d?.checks ?? []), step.instruction].filter(Boolean).join(' | ')).slice(0, 1200),
      timeline: timeline.map((e) => `${(e.t / 1000).toFixed(1)}s ${e.phase}: ${e.summary.slice(0, 160)}`),
    };
  } catch (err) {
    return {
      id: item.id, group: item.group, type: item.type,
      pass: false, status: 'error', factFound: false, docCited: null, pageCited: null,
      videoCited: false, confidence: 0, retrieveRounds, durationMs: Date.now() - t0,
      phaseMs: {}, citations: [], answer: '',
      timeline: timeline.map((e) => `${(e.t / 1000).toFixed(1)}s ${e.phase}: ${e.summary.slice(0, 160)}`),
      error: String(err),
    };
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '-' : `${Math.round((n / d) * 100)}%`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const opts = parseArgs();
  const baseUrl = process.env.VULTR_BASE_URL;
  const apiKey = process.env.VULTR_INFERENCE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error('Set VULTR_BASE_URL and VULTR_INFERENCE_API_KEY (set -a; source .env; set +a)');
    process.exit(1);
  }

  const gold = JSON.parse(readFileSync('bench/goldset.json', 'utf8')) as { items: BenchItem[] };
  let items = gold.items;
  if (opts.only) items = items.filter((i) => opts.only!.includes(i.id));
  if (opts.group) items = items.filter((i) => opts.group!.includes(i.group));
  if (items.length === 0) {
    console.error('No gold set items match the filters.');
    process.exit(1);
  }

  const corpora: Record<string, Document[]> = {
    repair: JSON.parse(readFileSync('public/corpus/docs.json', 'utf8')),
    insurance: JSON.parse(readFileSync('public/corpus-insurance/docs.json', 'utf8')),
  };
  const driver = new VultrDriver(directTransport(baseUrl, apiKey));
  setWorkflowTeam([]);

  // Workspace identity (profile, language) is module-singleton state, exactly
  // as in the app: batch items sharing an identity, run batches sequentially.
  const batches = new Map<string, BenchItem[]>();
  for (const item of items) {
    const key = `${item.profile ?? 'repair'}|${item.lang ?? 'English'}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key)!.push(item);
  }

  console.log(`bench: ${items.length} item(s), ${batches.size} identity batch(es), concurrency ${opts.concurrency}\n`);
  const results: BenchResult[] = [];
  for (const [key, batch] of batches) {
    const [profile, lang] = key.split('|');
    setWorkflowProfile(profile);
    setAgentLanguage(lang);
    console.log(`-- batch ${key} (${batch.length} items)`);
    const batchResults = await mapLimit(batch, opts.concurrency, async (item) => {
      const r = await runItem(item, corpora[item.corpus], driver);
      const flags = [
        r.factFound ? 'fact' : (item.mustContain.length ? 'FACT-MISS' : ''),
        r.docCited === false ? 'DOC-MISS' : '',
        r.pageCited === false ? 'page-miss' : '',
        r.error ? `ERR ${r.error.slice(0, 60)}` : '',
      ].filter(Boolean).join(' ');
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${item.id.padEnd(28)} ${(r.durationMs / 1000).toFixed(1)}s r${r.retrieveRounds} ${r.status} conf=${r.confidence.toFixed(2)} ${flags}`);
      return r;
    });
    results.push(...batchResults);
  }

  // Aggregates
  const byGroup = new Map<string, BenchResult[]>();
  for (const r of results) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group)!.push(r);
  }
  console.log('\n=== By group ===');
  for (const [g, rs] of byGroup) {
    const passed = rs.filter((r) => r.pass).length;
    console.log(`${g.padEnd(14)} ${String(passed).padStart(2)}/${rs.length}  (${pct(passed, rs.length)})  p50 ${(median(rs.map((r) => r.durationMs)) / 1000).toFixed(1)}s`);
  }
  const passed = results.filter((r) => r.pass).length;
  const retrievalChecked = results.filter((r) => r.pageCited !== null);
  const docChecked = results.filter((r) => r.docCited !== null);
  console.log('\n=== Overall ===');
  console.log(`pass          ${passed}/${results.length} (${pct(passed, results.length)})`);
  console.log(`doc cited     ${docChecked.filter((r) => r.docCited).length}/${docChecked.length} (${pct(docChecked.filter((r) => r.docCited).length, docChecked.length)})`);
  console.log(`page cited ±1 ${retrievalChecked.filter((r) => r.pageCited).length}/${retrievalChecked.length} (${pct(retrievalChecked.filter((r) => r.pageCited).length, retrievalChecked.length)})`);
  console.log(`latency p50   ${(median(results.map((r) => r.durationMs)) / 1000).toFixed(1)}s`);
  console.log(`errors        ${results.filter((r) => r.error).length}`);

  mkdirSync('bench/results', { recursive: true });
  const outPath = `bench/results/bench-${opts.label}.json`;
  writeFileSync(outPath, JSON.stringify({ label: opts.label, when: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
