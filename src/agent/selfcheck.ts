// Workspace self-check: the agent audits itself on the user's own documents.
// The model writes verifiable probe questions from fact-dense pages, then the
// REAL agent loop answers them over the WHOLE corpus - if retrieval or
// grounding were broken, the probes would fail. This is the bench methodology
// that hardened the engine, shipped as a product feature.
import type { ModelDriver } from './driver';
import type { Citation, Conversation, Document, Page } from './types';
import { runStep } from './loop';

export interface ProbeSpec { question: string; mustContain: string[] }

export interface SelfCheckItem {
  docId: string;
  page: number;
  question: string;
  mustContain: string[];
  answer: string;
  factFound: boolean;
  pageCited: boolean;
  passed: boolean;
  citations: Citation[];
}

export interface SelfCheckResult { items: SelfCheckItem[]; passed: number; total: number }

/** Fact-dense pages make verifiable probes: amounts, ratios, units, part
 *  numbers. Covers and TOC pages are excluded (they match every query and
 *  hold no answers - measured the hard way). One page per document first:
 *  breadth proves more than depth. */
export function pickFactPages(docs: Document[], count = 3): Page[] {
  const scored: { p: Page; s: number }[] = [];
  for (const d of docs) {
    for (const p of d.pages) {
      const t = p.text ?? '';
      if (t.length < 150 || p.page <= 2 || p.kind === 'video-segment') continue;
      const digits = (t.match(/\d/g) ?? []).length;
      const values = (t.match(/[$£€]\s?\d|\d+(?:[.,]\d+)?\s?(?:%|mm|cm|v|a|w|kg|years?|days?|months?)\b|\d+\s?:\s?\d+/gi) ?? []).length;
      scored.push({ p, s: values * 3 + Math.min(digits, 40) / 10 + (p.kind !== 'other' ? 3 : 0) });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  const out: Page[] = [];
  const seenDocs = new Set<string>();
  for (const { p } of scored) {
    if (out.length >= count) break;
    if (seenDocs.has(p.docId)) continue;
    seenDocs.add(p.docId);
    out.push(p);
  }
  for (const { p } of scored) {
    if (out.length >= count) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** A probe passes when the answer quotes at least one literal expected value
 *  AND cites the source page (±1: facts straddle page boundaries). */
export function scoreProbe(
  answer: string,
  citations: Citation[],
  probe: ProbeSpec,
  source: { docId: string; page: number },
): { factFound: boolean; pageCited: boolean; passed: boolean } {
  const hay = answer.toLowerCase();
  const factFound = probe.mustContain.some((k) => hay.includes(k.toLowerCase()));
  const pageCited = citations.some((c) => c.docId === source.docId && Math.abs(c.page - source.page) <= 1);
  return { factFound, pageCited, passed: factFound && pageCited };
}

export async function runSelfCheck(
  docs: Document[],
  driver: ModelDriver,
  opts?: { count?: number; onItem?: (item: SelfCheckItem) => void; probeDocIds?: string[] },
): Promise<SelfCheckResult> {
  if (!driver.generateProbe) return { items: [], passed: 0, total: 0 };
  // Probes come from the target docs (freshly dropped ones); the agent still
  // searches the WHOLE workspace to answer them.
  const probePool = opts?.probeDocIds?.length ? docs.filter((d) => opts.probeDocIds!.includes(d.id)) : docs;
  const pages = pickFactPages(probePool, opts?.count ?? 3);
  const items: SelfCheckItem[] = [];

  await Promise.all(pages.map(async (page) => {
    const doc = docs.find((d) => d.id === page.docId);
    if (!doc) return;
    const probe = await driver.generateProbe!({ page: page.page, text: page.text ?? '' });
    if (!probe) return;
    // The probe was written FROM one page; the agent must FIND it in the
    // whole corpus. Device = the doc identity, same scoping as a real ask.
    const conversation: Conversation = {
      id: `selfcheck-${page.docId}-${page.page}`,
      device: `${doc.brand} ${doc.model} ${doc.category}`.trim(),
      symptom: probe.question,
      steps: [], attachments: [], userInputs: [], status: 'active',
    } as Conversation;
    const gen = runStep({ conversation, docs, userInput: undefined }, driver);
    let step;
    while (true) {
      const n = await gen.next();
      if (n.done) { step = n.value; break; }
    }
    const answerText = step.answer ?? `${step.instruction} ${step.diagnosis?.cause ?? ''}`;
    const verdict = scoreProbe(answerText, step.citations, probe, { docId: page.docId, page: page.page });
    const item: SelfCheckItem = {
      docId: page.docId, page: page.page,
      question: probe.question, mustContain: probe.mustContain,
      answer: answerText, citations: step.citations,
      ...verdict,
    };
    items.push(item);
    opts?.onItem?.(item);
  }));

  return { items, passed: items.filter((i) => i.passed).length, total: items.length };
}
