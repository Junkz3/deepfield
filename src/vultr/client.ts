import type { ClassifyInput, DocMeta, ModelDriver, SufficiencyVerdict } from '../agent/driver';
import type { Diagnosis, Page, PlanAction, ScoredPage } from '../agent/types';

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

// Fetch a page image (site asset) and inline it as a data URL for Vultr payloads.
async function toDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) return imageUrl;
  const res = await fetch(imageUrl);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

export class VultrDriver implements ModelDriver {
  constructor(private t: Transport) {}

  async plan(q: { device: string; symptom: string; hasPhoto: boolean; userInput?: string }): Promise<PlanAction> {
    // The find-video action arrives as a raw token: turn it into real intent.
    const userInput = q.userInput === 'find-video'
      ? 'Show the video walkthrough for this repair. Phrase the retrieval query as: video walkthrough <device> <faulty component> replacement.'
      : q.userInput;
    const text = await chatText(this.t, MODELS.kimi,
      `You are a repair agent planning evidence retrieval from a knowledge base that holds PAGINATED MANUAL PAGES and TIMESTAMPED VIDEO WALKTHROUGH SEGMENTS.\nDevice: ${q.device}\nSymptom: ${q.symptom}\nUser input: ${userInput ?? 'none'}\nReturn STRICT JSON: {"goal": string, "queries": [string]} - one focused retrieval query (error code table / troubleshooting first; start the query with "video walkthrough" when the user wants a demonstration). The retrieval query MUST be written in English (the corpus language) regardless of the user's language; write the goal in ${AGENT_LANG}.`, 8000);
    return extractJson<PlanAction>(text, { goal: `Diagnose ${q.symptom}`, queries: [`${q.device} ${q.symptom}`] });
  }

  async retrieve(query: string, candidates: Page[]): Promise<ScoredPage[]> {
    // Video intent: frames carry weak visual signal against dense manual
    // pages (measured), but chapter TITLES rerank fast and precisely. So a
    // walkthrough query searches the video segments by title, text-only.
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
    const budget = [...candidates]
      .map((p, i) => ({ p, i, sc: lex(p) }))
      .sort((a, b) => b.sc - a.sc || a.i - b.i)
      .slice(0, BUDGET)
      .map((x) => x.p);

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
    const listing = found.map((f) => `p.${f.page.page} kind=${f.page.kind} score=${f.score.toFixed(1)}${f.page.text ? ` text="${f.page.text.slice(0, 100)}"` : ''}`).join('\n');
    const text = await chatText(this.t, MODELS.kimi,
      `Repair diagnosis for ${q.device} - ${q.symptom}. Evidence so far:\n${listing}\nTo point at a component you need BOTH the fault identification AND the wiring/schematic page. Return STRICT JSON: {"sufficient": boolean, "reason": string, "followupQuery": string|null} - reason written in ${AGENT_LANG}; followupQuery always in English.`, 8000);
    const v = extractJson(text, { sufficient: true, reason: 'assessment unavailable', followupQuery: null as string | null });
    return { sufficient: v.sufficient, reason: v.reason, followupQuery: v.followupQuery ?? undefined };
  }

  async diagnose(q: { device: string; symptom: string }, evidence: Page[], techPhoto?: string): Promise<Diagnosis> {
    const parts: unknown[] = [{ type: 'text', text: `You are a repair diagnosis agent. Device: ${q.device}. Symptom: ${q.symptom}.\nGround yourself ONLY in the attached manual pages${techPhoto ? ' and the technician photo (last image)' : ''}. Return STRICT JSON: {"component": string, "cause": string, "checks": [string, string, string], "instruction": string, "componentKey": "heater"|"thermistor"|"sensor"|"pump"|"motor"|"board"|"wiring"|"other"} - checks must be concrete ACTIONS the technician performs (measure X, inspect Y), ordered, with measurable values when the pages give them; instruction = ONE natural sentence guiding the technician to the first action, varied phrasing, no boilerplate prefix. Write component/cause/checks in ${AGENT_LANG}; keep part numbers and error codes verbatim. If the pages do not support a diagnosis, set component to "insufficient evidence". Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.` }];
    for (const p of evidence.slice(0, 4)) parts.push({ type: 'image_url', image_url: { url: await toDataUrl(p.imageUrl) } });
    if (techPhoto) parts.push({ type: 'image_url', image_url: { url: techPhoto } });
    const text = await chatText(this.t, MODELS.omni, parts, 8000);
    return extractJson<Diagnosis>(text, { component: 'insufficient evidence', cause: 'Model response unparseable', checks: ['Retry the diagnosis'] });
  }

  async classify(input: ClassifyInput): Promise<DocMeta> {
    const parts: unknown[] = [{ type: 'text', text: `Classify this repair document (filename: ${input.filename}). First pages attached. Return STRICT JSON: {"category": string (lowercase generic device type, e.g. "dishwasher"), "brand": string, "model": string, "docType": "service"|"user"|"schematic"|"parts", "pageKinds": []} Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.` }];
    for (const img of input.pageImages.slice(0, 3)) parts.push({ type: 'image_url', image_url: { url: img } });
    const text = await chatText(this.t, MODELS.omni, parts, 6000);
    const meta = extractJson<DocMeta>(text, { category: 'uncategorized', brand: 'Unknown', model: 'Unknown', docType: 'user', pageKinds: [] });
    meta.pageKinds = input.pageImages.map(() => 'other');
    return meta;
  }
}
