import type { ClassifyInput, DocMeta, ModelDriver, SufficiencyVerdict } from '../agent/driver';
import type { Diagnosis, Page, PlanAction, ScoredPage } from '../agent/types';
import { workflowProfile } from '../agent/workflow';

export type Transport = (path: string, body: unknown) => Promise<any>;

export function directTransport(baseUrl: string, apiKey: string): Transport {
  return async (path, body) => {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Vultr ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
}

export function proxyTransport(demoToken?: string): Transport {
  return async (path, body) => {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, body, token: demoToken }),
    });
    if (!res.ok) throw new Error(`proxy ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
}

/** Language the agent answers in (set from the UI language selector). */
let AGENT_LANG = 'English';
export function setAgentLanguage(name: string) { AGENT_LANG = name; }

export const MODELS = {
  rerank: 'vultr/VultronRetrieverPrime-Qwen3.5-8B',
  omni: 'nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16',
  kimi: 'moonshotai/Kimi-K2.6',
} as const;

async function chatText(t: Transport, model: string, content: unknown, maxTokens = 8000): Promise<string> {
  const r = await t('/chat/completions', { model, messages: [{ role: 'user', content }], max_tokens: maxTokens });
  return r.choices?.[0]?.message?.content ?? '';
}

function extractJson<T>(text: string, fallback: T): T {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try { return JSON.parse(m[0]) as T; } catch { return fallback; }
}

// Fetch a page image (site asset) and inline it as a data URL for Vultr
// payloads. Cached: the same pages are re-sent across rounds and steps, and
// re-encoding 24 images per round was pure waste (bounded, ~figures 50MB).
const dataUrlCache = new Map<string, string>();
async function toDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) return imageUrl;
  const hit = dataUrlCache.get(imageUrl);
  if (hit) return hit;
  const res = await fetch(imageUrl);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const out = `data:image/png;base64,${btoa(bin)}`;
  if (dataUrlCache.size > 120) dataUrlCache.delete(dataUrlCache.keys().next().value!);
  dataUrlCache.set(imageUrl, out);
  return out;
}

export class VultrDriver implements ModelDriver {
  constructor(private t: Transport) {}
  private scopeHasSchematic = true; // updated on every retrieve


  async plan(q: { device: string; symptom: string; hasPhoto: boolean; userInput?: string }): Promise<PlanAction> {
    // The find-video action arrives as a raw token: turn it into real intent.
    const userInput = q.userInput === 'find-video'
      ? 'Show the video walkthrough for this repair. Phrase the retrieval query as: video walkthrough <device> <faulty component> replacement.'
      : q.userInput;
    const text = await chatText(this.t, MODELS.omni,
      `You are ${workflowProfile().agentRole} planning evidence retrieval from a knowledge base that holds PAGINATED DOCUMENT PAGES and TIMESTAMPED VIDEO WALKTHROUGH SEGMENTS.\n${workflowProfile().subjectNoun}: ${q.device}\n${workflowProfile().issueNoun}: ${q.symptom}\nUser input: ${userInput ?? 'none'}\nThis is quick planning, not analysis: keep any internal reasoning under 30 words. Return STRICT JSON: {"goal": string, "queries": [string], "intent": "diagnose"|"question"} - intent is "diagnose" for faults/symptoms to troubleshoot, "question" for how-to, maintenance, specs or informational asks; one focused retrieval query (${workflowProfile().retrievalHint}; start the query with "video walkthrough" when the user wants a demonstration). The retrieval query MUST be written in English (the corpus language) regardless of the user's language; write the goal in ${AGENT_LANG}.`, 8000);
    return extractJson<PlanAction>(text, { goal: `Diagnose ${q.symptom}`, queries: [`${q.device} ${q.symptom}`] });
  }

  async answer(question: string, evidence: Page[], mode: 'qa' | 'deep'): Promise<string> {
    const depth = mode === 'deep'
      ? 'Give the COMPLETE picture: explain the reasoning, the relevant values, the alternatives and the pitfalls the pages mention. Use short markdown sections. Aim for thorough - several paragraphs are welcome.'
      : 'Answer fully but stay on the question. Use short paragraphs or a list when the pages give steps.';
    const shown = evidence.slice(0, 4);
    const pageList = shown.map((pg) => `p.${pg.page}`).join(', ');
    const parts: unknown[] = [{ type: 'text', text: `You are a technical assistant answering from the attached manual pages ONLY. Question: ${question}
Attached pages, in this order: ${pageList}.
${depth} Answer in ${AGENT_LANG}; keep part numbers, codes, units and torque values EXACTLY as printed; cite pages by their REAL numbers from the list above, like (${shown[0] ? `p.${shown[0].page}` : 'p.12'}), after each fact. If the pages do not contain the answer, say exactly what is missing. Keep any internal reasoning under 60 words, then write the answer.` }];
    for (const p of shown) parts.push({ type: 'image_url', image_url: { url: await toDataUrl(p.imageUrl) } });
    // Same two-regime retry as diagnose: brevity directive first (rumination
    // burns the cap on sparse evidence), then shed pages (density burns it).
    for (const [i, take] of [4, 4, 2, 1].entries()) {
      const head = i === 0 ? parts[0]
        : { type: 'text', text: `YOUR PREVIOUS ATTEMPT WAS CUT BY THE TOKEN CAP BEFORE ANY OUTPUT. Do NOT deliberate: at most 20 words of internal reasoning, then write the answer immediately.\n${(parts[0] as { text: string }).text}` };
      const attempt = [head, ...parts.slice(1, 1 + take)];
      const text = (await chatText(this.t, MODELS.omni, attempt, 8000)).trim();
      if (text) return text;
    }
    return 'The pages could not be read into an answer - try rephrasing the question.';
  }

  async retrieve(query: string, candidates: Page[]): Promise<ScoredPage[]> {
    // Video intent: frames carry weak visual signal against dense manual
    // pages (measured), but chapter TITLES rerank fast and precisely. So a
    // walkthrough query searches the video segments by title, text-only.
    this.scopeHasSchematic = candidates.some((p) => p.kind === 'schematic');
    const wantsVideo = /video|walkthrough|demonstrat|tutorial/i.test(query);
    const segments = candidates.filter((p) => p.kind === 'video-segment');
    if (wantsVideo && segments.length > 0) {
      const documents = segments.map((p) => `Video segment at ${p.timestamp}s: ${p.text ?? ''}`);
      const r = await this.t('/rerank', { model: MODELS.rerank, query, documents, top_n: documents.length });
      return (r.results as { index: number; relevance_score: number }[])
        .map((res) => ({ page: segments[res.index], score: res.relevance_score }))
        .sort((a, b) => b.score - a.score);
    }

    // Two-stage retrieval: a fast lexical prefilter narrows the taxonomy scope
    // to a visual-rerank budget (base64 page images are heavy on the wire),
    // then VultronRetriever scores the actual page IMAGES against the query.
    const BUDGET = 24;
    const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const lex = (p: Page): number => {
      let sc = 0;
      const hay = `${p.text ?? ''} ${p.title ?? ''} ${p.kind}`.toLowerCase();
      for (const w of terms) if (hay.includes(w)) sc += 1;
      if (p.kind !== 'other') sc += 0.5; // curated key pages float up
      return sc;
    };
    // Per-document quota (round-robin): the lexical prefilter is English-only,
    // so a Chinese or Spanish manual would never win a global top-24 on text
    // score alone - but the visual rerank IS cross-lingual. Every doc in
    // scope sends its best pages forward; no single manual hogs the budget.
    const scored = candidates.map((p, i) => ({ p, i, sc: lex(p) }));
    const byDoc = new Map<string, typeof scored>();
    for (const s of scored) {
      if (!byDoc.has(s.p.docId)) byDoc.set(s.p.docId, []);
      byDoc.get(s.p.docId)!.push(s);
    }
    for (const [docId, list] of byDoc) {
      list.sort((a, b) => b.sc - a.sc || a.i - b.i);
      // Zero-score pages (non-English text, or a symptom the words miss) get
      // sampled UNIFORMLY across the doc instead of "first pages win" - the
      // visual rerank then sees a cross-section of the whole manual, not
      // three covers and a table of contents.
      const nz = list.filter((x) => x.sc > 0);
      const z = list.filter((x) => x.sc <= 0);
      if (z.length > 6) {
        const stride = Math.ceil(z.length / 8);
        byDoc.set(docId, [...nz, ...z.filter((_, idx) => idx % stride === 0)]);
      }
    }
    const docLists = [...byDoc.values()].sort((a, b) => (b[0]?.sc ?? 0) - (a[0]?.sc ?? 0));
    const budget: Page[] = [];
    for (let k = 0; budget.length < BUDGET; k++) {
      let took = false;
      for (const list of docLists) {
        if (k < list.length && budget.length < BUDGET) { budget.push(list[k].p); took = true; }
      }
      if (!took) break;
    }

    // VERIFIED shape (docs/reference/vultr-api.md): documents = list of str | {content:[ONE part]}; top_n MUST be set.
    const documents = await Promise.all(budget.map(async (p) =>
      p.imageUrl ? { content: [{ type: 'image_url', image_url: { url: await toDataUrl(p.imageUrl) } }] } : (p.text ?? ''),
    ));
    const r = await this.t('/rerank', { model: MODELS.rerank, query, documents, top_n: documents.length });
    return (r.results as { index: number; relevance_score: number }[])
      .map((res) => ({ page: budget[res.index], score: res.relevance_score }))
      .sort((a, b) => b.score - a.score);
  }

  async assessSufficiency(q: { device: string; symptom: string }, found: ScoredPage[]): Promise<SufficiencyVerdict> {
    const listing = found.map((f) =>
      `p.${f.page.page} [${f.page.kind}]${f.page.title ? ` "${f.page.title}"` : ''} score=${f.score.toFixed(1)}${f.page.text ? `\n  text: "${f.page.text.slice(0, 400).replace(/\n+/g, ' ')}"` : ''}`,
    ).join('\n');
    const text = await chatText(this.t, MODELS.omni,
      `You are ${workflowProfile().agentRole}. Task: ${q.device} - ${q.symptom}. Evidence retained so far:\n${listing}\nIMPORTANT: retrieval scored the page IMAGES; a page holds more than its text snippet. A page tagged [error-table] almost certainly contains the full error-code table even if the snippet cuts off before the code; a page tagged [schematic] IS a wiring/schematic page. ${this.scopeHasSchematic ? 'To point at a component you need BOTH the fault identification AND a wiring/schematic page.' : 'The scope contains NO schematic pages at all (user-guide material): a troubleshooting or diagnostic-procedure page is then SUFFICIENT - never demand a wiring diagram that does not exist here.'} This is a quick check, not analysis: keep any internal reasoning under 30 words. Return STRICT JSON: {"sufficient": boolean, "reason": string, "followupQuery": string|null, "keyPages": [int]} - reason written in ${AGENT_LANG}; followupQuery = 3-8 plain English search KEYWORDS (e.g. "heating circuit wiring diagram"), NEVER a sentence or an instruction; keyPages = the page NUMBERS from the listing above most likely to hold the literal answer (value tables, procedures, fault tables) - EXCLUDE covers, tables of contents and spec summaries.`, 8000);
    const v = extractJson(text, { sufficient: true, reason: 'assessment unavailable', followupQuery: null as string | null, keyPages: [] as number[] });
    const keyPages = Array.isArray(v.keyPages) ? v.keyPages.map(Number).filter(Number.isFinite) : [];
    return { sufficient: v.sufficient, reason: v.reason, followupQuery: v.followupQuery ?? undefined, keyPages: keyPages.length > 0 ? keyPages : undefined };
  }

  async diagnose(q: { device: string; symptom: string }, evidence: Page[], techPhoto?: string): Promise<Diagnosis> {
    const parts: unknown[] = [{ type: 'text', text: `You are ${workflowProfile().agentRole} producing a grounded verdict. ${workflowProfile().subjectNoun}: ${q.device}. ${workflowProfile().issueNoun}: ${q.symptom}.\nGround yourself ONLY in the attached manual pages${techPhoto ? ' and the technician photo (last image)' : ''}. Return STRICT JSON: {"component": string, "cause": string, "checks": [string, string, string], "instruction": string, "componentKey": "heater"|"thermistor"|"sensor"|"pump"|"motor"|"board"|"wiring"|"other"} - checks must be concrete ACTIONS the technician performs (measure X, inspect Y), ordered, with measurable values when the pages give them; instruction = one or two sentences guiding the technician: the FIRST concrete action with its expected measurable value from the pages, then what the result decides next; varied phrasing, no boilerplate prefix. Write component/cause/checks in ${AGENT_LANG}; keep part numbers and error codes verbatim. If a page gives a STEP-BY-STEP troubleshooting procedure with several candidate causes for this exact malfunction, that IS a valid diagnosis: component = the target of the procedure's first step, cause = the malfunction line as printed, checks = the procedure's first steps in their printed order (cite the paragraph numbers). Only set component to "insufficient evidence" when no retained page addresses the symptom at all. Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.` }];
    for (const p of evidence.slice(0, 4)) parts.push({ type: 'image_url', image_url: { url: await toDataUrl(p.imageUrl) } });
    const fallback: Diagnosis = {
      component: 'insufficient evidence',
      cause: 'The retrieved pages did not yield a grounded diagnosis.',
      checks: ['Describe the symptom more specifically', 'Open the cited pages and check them manually'],
    };
    // Two failure regimes burn the ~4000-token server cap before any JSON:
    // DENSE pages (three military-TM pages: cap burned, zero content; one
    // page: 7s, perfect) and RUMINATION on sparse evidence (measured: the
    // SAME sewing case answers in 16s with 4 pages, burns the cap with 1-2 -
    // less context means MORE deliberation). So retry first with a hard
    // brevity directive at full context, then shed pages for density.
    for (const [i, take] of [4, 4, 2, 1].entries()) {
      const head = i === 0 ? parts[0]
        : { type: 'text', text: `YOUR PREVIOUS ATTEMPT WAS CUT BY THE TOKEN CAP BEFORE ANY OUTPUT. Do NOT deliberate: at most 20 words of internal reasoning, then the JSON object immediately.\n${(parts[0] as { text: string }).text}` };
      const attempt = [head, ...parts.slice(1, 1 + Math.min(take, evidence.length))];
      if (techPhoto) attempt.push({ type: 'image_url', image_url: { url: techPhoto } });
      const text = await chatText(this.t, MODELS.omni, attempt, 8000);
      const d = extractJson<Diagnosis>(text, fallback);
      if (d !== fallback) return d;
    }
    return fallback;
  }

  async classify(input: ClassifyInput): Promise<DocMeta> {
    const parts: unknown[] = [{ type: 'text', text: `Classify this document (filename: ${input.filename}). First pages attached. ${workflowProfile().classifyHint}. Return STRICT JSON: {"category": string (lowercase), "brand": string, "model": string, "docType": "service"|"user"|"schematic"|"parts", "pageKinds": []} Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.` }];
    for (const img of input.pageImages.slice(0, 3)) parts.push({ type: 'image_url', image_url: { url: img } });
    const text = await chatText(this.t, MODELS.omni, parts, 6000);
    const meta = extractJson<DocMeta>(text, { category: 'uncategorized', brand: 'Unknown', model: 'Unknown', docType: 'user', pageKinds: [] });
    meta.pageKinds = input.pageImages.map(() => 'other');
    return meta;
  }
}
