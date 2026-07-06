import type { ClassifyInput, DocMeta, ModelDriver, SufficiencyVerdict } from '../agent/driver';
import type { Diagnosis, Page, PageKind, PlanAction, ScoredPage, Turn } from '../agent/types';
import { FREEFORM_SYMPTOM } from '../agent/types';
import { workflowProfile } from '../agent/workflow';
import type { WorkflowProfile } from '../agent/workflow';
import { activeAgents } from '../agent/workflow';
import type { TeamCalibration, TeamCalibrationInput } from '../agent/team';
import { heuristicCalibration, parseTeamCalibration, teamPrompt } from '../agent/team';
import { activeTools, opsPromptSection } from '../agent/tools';
import type { CalibrationInput } from '../agent/calibrate';
import { calibrationPrompt, heuristicProfile, parseProfile } from '../agent/calibrate';

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


  async plan(q: { device: string; symptom: string; hasPhoto: boolean; userInput?: string; history?: Turn[] }): Promise<PlanAction> {
    // The find-video action arrives as a raw token: turn it into real intent.
    const userInput = q.userInput === 'find-video'
      ? 'Show the video walkthrough for this repair. Phrase the retrieval query as: video walkthrough <device> <faulty component> replacement.'
      : q.userInput;
    // Recent turns let a follow-up ("are you sure?", "and page 20?") be
    // planned against the exchange, not read as a fresh standalone request.
    const convo = q.history && q.history.length > 0
      ? `\nRecent conversation (the user input above may be a follow-up to it - resolve any reference against it):\n${q.history.map((t) => `- Q: ${t.question} / A: ${t.answer.slice(0, 200)}`).join('\n')}`
      : '';
    // Multi-agent routing lives INSIDE the plan call: with several active
    // agents the same prompt gains a roster and returns "agentId" - zero
    // extra inference calls, and byte-identical prompt with a solo team.
    const team = activeAgents();
    const routed = team.length > 1;
    const role = routed ? 'the dispatcher of a team of specialized agents' : workflowProfile().agentRole;
    const roster = routed
      ? `\nRoute this request to exactly ONE team agent:\n${team.map((a) => `- agentId "${a.id}" (${a.profile.agentRole}): handles ${a.charter}; evidence focus: ${a.profile.retrievalHint}`).join('\n')}`
      : '';
    const jsonShape = routed
      ? '{"goal": string, "queries": [string], "intent": "diagnose"|"question"|"scope", "agentId": string (the routed agent)}'
      : '{"goal": string, "queries": [string], "intent": "diagnose"|"question"|"scope"}';
    const hint = routed ? "follow the routed agent's evidence focus" : workflowProfile().retrievalHint;
    const text = await chatText(this.t, MODELS.omni,
      `You are ${role} planning evidence retrieval from a knowledge base that holds PAGINATED DOCUMENT PAGES and TIMESTAMPED VIDEO WALKTHROUGH SEGMENTS.\n${q.symptom === FREEFORM_SYMPTOM ? `User request: ${q.device}` : `${workflowProfile().subjectNoun}: ${q.device}\n${workflowProfile().issueNoun}: ${q.symptom}`}\nUser input: ${userInput ?? 'none'}${roster}${convo}\nThis is quick planning, not analysis: keep any internal reasoning under 30 words. Return STRICT JSON: ${jsonShape} - intent is "scope" ONLY when the user asks about the assistant or workspace ITSELF: what it can do, or which documents, topics or categories it holds (e.g. "what can you help with?", "which manuals do you have?", "t'as quoi comme appareils?"). A question about a SPECIFIC subject - whether a particular contract, device, product or document covers, includes, supports, allows or handles something - is NEVER scope even when it uses words like "cover" or "support": classify it "diagnose" for a fault or symptom to troubleshoot, otherwise "question" for how-to, coverage, eligibility, specs or any informational ask about the content. Use one focused retrieval query (${hint}; start the query with "video walkthrough" when the user wants a demonstration). The retrieval query MUST be written in English (the corpus language) regardless of the user's language; write the goal in ${AGENT_LANG}.`, 8000);
    const parsed = extractJson<PlanAction>(text, { goal: `Diagnose ${q.symptom}`, queries: [`${q.device} ${q.symptom}`] });
    // The model sometimes echoes the field label into the query string
    // ("retrieval query: ..."); strip such prefixes deterministically (model
    // JSON is validated, never trusted).
    const cleanQuery = (s: string) => String(s).replace(/^\s*(the\s+)?(retrieval|search)?\s*quer(?:y|ies)\s*[:\-]\s*/i, '').trim();
    const queries = (parsed.queries ?? []).map(cleanQuery).filter(Boolean);
    return { ...parsed, queries: queries.length > 0 ? queries : [`${q.device} ${q.symptom}`] };
  }

  async answer(question: string, evidence: Page[], mode: 'qa' | 'deep', context?: Turn[]): Promise<string> {
    const depth = mode === 'deep'
      ? 'Give the COMPLETE picture: explain the reasoning, the relevant values, the alternatives and the pitfalls the pages mention. Use short markdown sections. Aim for thorough - several paragraphs are welcome.'
      : 'Answer fully but stay on the question. Use short paragraphs or a list when the pages give steps.';
    // A follow-up ("are you sure?", "what about theft?") is resolved against
    // the prior exchange, never read as a fresh standalone question.
    const convo = context && context.length > 0
      ? `This is an ongoing conversation. Earlier exchange(s):\n${context.map((t) => `User asked: ${t.question}\nYou answered: ${t.answer.slice(0, 400)}`).join('\n')}\nThe user's latest message may be a follow-up (e.g. "are you sure?", "and page 20?"): resolve it against that exchange and re-answer the underlying question from the pages below. `
      : '';
    // The coverage/exclusion polarity rule is meaningful only for answer-mode
    // verticals reading real policy/manual pages - never for the synthetic
    // workspace inventory (a scope answer), and never for repair diagnostics.
    // Injecting it elsewhere pollutes the answer ("the pages do not contain a
    // 'what is covered' section").
    const isInventory = evidence.length === 1 && evidence[0]?.docId === 'workspace-index';
    // Answer-mode verticals reading real policy/manual pages get two extras a
    // repair diagnostic or a scope inventory answer must not: the page TEXT
    // alongside its image (a section heading read as reliable tokens, not parsed
    // from pixels) and the exclusion-polarity rule.
    const coverageAware = workflowProfile().decisionMode === 'answer' && !isInventory;
    const coverageDirective = coverageAware
      ? ' Before concluding that something is covered or allowed, locate BOTH the "what is covered" and the "what is not covered" / "exclusions" sections across ALL the attached pages: a numbered list often continues onto the next page, so an item can sit under a heading printed on the PREVIOUS page (a page that begins mid-list at item 2 with no heading is a continuation). If the item in question falls under "what is not covered", an exclusion, an age or time limit, a waiting period or a cap, then it is NOT covered - say it is excluded and quote the clause; never answer affirmatively when an exclusion applies.'
      : '';
    // Read same-document pages in ascending page order so a list or table
    // that continues across a page break (an exclusions list whose heading is
    // on the previous page) is read in its natural sequence. Document order
    // (which manual the ranking put first) is preserved.
    const ranked = evidence.slice(0, 4);
    const docOrder = [...new Set(ranked.map((p) => p.docId))];
    const shown = docOrder.flatMap((id) => ranked.filter((p) => p.docId === id).sort((a, b) => a.page - b.page));
    const pageList = shown.map((pg) => `p.${pg.page}`).join(', ');
    const promptPart = { type: 'text' as const, text: `You are a technical assistant answering from the attached manual pages ONLY. ${convo}Question: ${question}
Attached pages, in this order: ${pageList}.
${depth} Answer in ${AGENT_LANG}; keep part numbers, codes, units and torque values EXACTLY as printed; cite pages by their REAL numbers from the list above, like (${shown[0] ? `p.${shown[0].page}` : 'p.12'}), after each fact.${coverageDirective} If the pages do not contain the answer, say exactly what is missing. Keep any internal reasoning under 60 words, then write the answer.` };
    // One block per page so the retry ladder still sheds whole PAGES. Answer-mode
    // real pages carry BOTH their text (headings, exclusions) and the image; the
    // synthetic inventory rides as text; repair pages stay image-only.
    const pageBlocks: unknown[][] = [];
    for (const p of shown) {
      if (!p.imageUrl) { pageBlocks.push([{ type: 'text', text: `[p.${p.page}] ${p.text ?? ''}` }]); continue; }
      const block: unknown[] = [];
      if (coverageAware && p.text) block.push({ type: 'text', text: `Text of p.${p.page} (read its headings here; the image below is the same page):\n${p.text}` });
      block.push({ type: 'image_url', image_url: { url: await toDataUrl(p.imageUrl) } });
      pageBlocks.push(block);
    }
    // Same two-regime retry as diagnose: brevity directive first (rumination
    // burns the cap on sparse evidence), then shed pages (density burns it).
    for (const [i, take] of [4, 4, 2, 1].entries()) {
      const head = i === 0 ? promptPart
        : { type: 'text' as const, text: `YOUR PREVIOUS ATTEMPT WAS CUT BY THE TOKEN CAP BEFORE ANY OUTPUT. Do NOT deliberate: at most 20 words of internal reasoning, then write the answer immediately.\n${promptPart.text}` };
      const attempt = [head, ...pageBlocks.slice(0, take).flat()];
      let text: string;
      try {
        text = (await chatText(this.t, MODELS.omni, attempt, 8000)).trim();
      } catch {
        continue; // gateway timeout or transient 5xx = a lost attempt, not a dead step: next rung
      }
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
    // The workspace registry rides INSIDE the verdict call: the model reads
    // the available ops and requests the ones its verdict needs - the agent
    // chooses its tools, nothing is hard-wired (and zero extra calls).
    // Footprint matters: a verbose op section mid-prompt degraded the
    // diagnosis fields themselves (component drifted to the symptom, the
    // rumination regime came back). One short sentence at the END, and the
    // shape only gains a defaulted "tools": [].
    // The diagnose path is the ops' only consumer (answer-mode never reaches
    // it), so the gate is the decision mode itself: calibrated diagnostic
    // workspaces get their ops even without the physical-tools flag.
    const ops = workflowProfile().decisionMode === 'diagnosis' ? activeTools() : [];
    // Inline sourcing rides the FIRST attempt only, like the op offer: the
    // model can only cite page numbers it was given, and the fallback rungs
    // must stay the exact prompt the fragile cases passed on.
    const basePrompt = (withOps: boolean, withPages = false) => {
      const opsSection = withOps ? opsPromptSection(ops) : '';
      const pagesLine = withPages && evidence.length > 0
        ? ` Attached pages, in this order: ${evidence.slice(0, 4).map((p) => `p.${p.page}`).join(', ')}. After the cause and after EACH check, cite its source page in parentheses like (p.${evidence[0].page}) - only pages from this list.`
        : '';
      const jsonTools = withOps && ops.length > 0 ? ', "tools": []' : '';
      const jsonFollowups = withPages
        ? ', "followups": [2 SHORT messages the user would naturally send next (a finding to report, a deeper question), first person, in ' + AGENT_LANG + ']'
        : '';
      return `You are ${workflowProfile().agentRole} producing a grounded verdict. ${workflowProfile().subjectNoun}: ${q.device}. ${workflowProfile().issueNoun}: ${q.symptom}.\nGround yourself ONLY in the attached manual pages${techPhoto ? ' and the technician photo (last image)' : ''}. Return STRICT JSON: {"component": string, "cause": string, "checks": [string, string, string], "instruction": string, "componentKey": "heater"|"thermistor"|"sensor"|"pump"|"motor"|"board"|"wiring"|"other"${jsonTools}${jsonFollowups}} - checks must be concrete ACTIONS the technician performs (measure X, inspect Y), ordered, with measurable values when the pages give them; instruction = one or two sentences guiding the technician: the FIRST concrete action with its expected measurable value from the pages, then what the result decides next; varied phrasing, no boilerplate prefix. Write component/cause/checks in ${AGENT_LANG}; keep part numbers and error codes verbatim.${opsSection}${pagesLine} If a page gives a STEP-BY-STEP troubleshooting procedure with several candidate causes for this exact malfunction, that IS a valid diagnosis: component = the target of the procedure's first step, cause = the malfunction line as printed, checks = the procedure's first steps in their printed order (cite the paragraph numbers). Only set component to "insufficient evidence" when no retained page addresses the symptom at all. Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.`;
    };
    const parts: unknown[] = [{ type: 'text', text: basePrompt(true, true) }];
    for (const p of evidence.slice(0, 4)) parts.push({ type: 'image_url', image_url: { url: await toDataUrl(p.imageUrl) } });
    const fallback: Diagnosis = {
      component: 'insufficient evidence',
      cause: 'The retrieved pages did not yield a grounded diagnosis.',
      checks: ['Describe the symptom more specifically', 'Open the cited pages and check them manually'],
    };
    // The server grants HALF the requested max_tokens (measured sweep:
    // 4000->2000, 8000->4000, 16000->8000). Asking 16000 for a real 8000
    // budget DOES work - but a full rumination run then generates for 60s+
    // and dies on the nginx gateway timeout instead (504 measured on the
    // suite). The generation-time ceiling makes ~4000 real tokens the
    // usable budget, so we stay at 8000. Two failure regimes burn it
    // before any JSON: DENSE pages (three military-TM pages: cap burned,
    // zero content; one page: 7s, perfect) and RUMINATION on sparse
    // evidence (measured: the SAME sewing case answers in 16s with 4
    // pages, burns the cap with 1-2 - less context means MORE
    // deliberation). So retry first with a hard brevity directive at full
    // context, then shed pages for density.
    // Attempt ladder. The op offer only rides the FIRST attempt: on sparse
    // evidence it re-feeds the rumination regime (measured: sewing burned
    // the cap 3/3 with ops anywhere in the prompt). Attempt 2 is the exact
    // pre-registry prompt - the setup those cases passed on - then the
    // strict/shedding retries for the two cap-burn regimes.
    const ladder: { withOps: boolean; withPages: boolean; strict: boolean; take: number }[] = [
      { withOps: true, withPages: true, strict: false, take: 4 },
      ...(ops.length > 0 ? [{ withOps: false, withPages: false, strict: false, take: 4 }] : []),
      { withOps: false, withPages: false, strict: true, take: 4 },
      { withOps: false, withPages: false, strict: true, take: 2 },
      { withOps: false, withPages: false, strict: true, take: 1 },
    ];
    for (const step of ladder) {
      const base = basePrompt(step.withOps, step.withPages);
      const head = {
        type: 'text',
        text: step.strict
          ? `YOUR PREVIOUS ATTEMPT WAS CUT BY THE TOKEN CAP BEFORE ANY OUTPUT. Do NOT deliberate: at most 20 words of internal reasoning, then the JSON object immediately.\n${base}`
          : base,
      };
      const attempt = [head, ...parts.slice(1, 1 + Math.min(step.take, evidence.length))];
      if (techPhoto) attempt.push({ type: 'image_url', image_url: { url: techPhoto } });
      let text: string;
      try {
        text = await chatText(this.t, MODELS.omni, attempt, 8000);
      } catch {
        continue; // gateway timeout or transient 5xx = a lost attempt, not a dead step: next rung
      }
      const d = extractJson<Diagnosis>(text, fallback);
      if (d !== fallback) return d;
    }
    return fallback;
  }

  async calibrate(input: CalibrationInput): Promise<WorkflowProfile> {
    // Nemotron writes the agent's own configuration from the corpus signal;
    // any parse failure falls back to the deterministic keyword heuristic.
    const text = await chatText(this.t, MODELS.omni, [{ type: 'text', text: calibrationPrompt(input) }], 4000);
    return parseProfile(text) ?? heuristicProfile(input);
  }

  async generateProbe(page: { page: number; text: string }): Promise<{ question: string; mustContain: string[] } | null> {
    if (page.text.trim().length < 120) return null;
    const basePrompt = `You are auditing a document-grounded assistant. Here is the text of page ${page.page}:\n"${page.text.slice(0, 900)}"\nWrite ONE question a real user of this document would naturally ask, whose answer is verifiably printed in this text. Pick a fact that is UNIQUE and unambiguous on this page - never one row of a large table of similar rows (a reader could grab the neighbouring cell). Do NOT mention the page or the document in the question. Return STRICT JSON: {"question": string (in ${AGENT_LANG}), "mustContain": [2-3 language-neutral LITERAL values copied VERBATIM from the text (amounts, percentages, ratios, codes, product names) - the checker matches them in answers possibly written in ANOTHER language, so NEVER sentences or words of prose]}. Do not deliberate: at most 20 words of internal reasoning, then ONLY the JSON.`;
    for (const strict of [false, true]) {
      const prompt = strict
        ? `YOUR PREVIOUS ATTEMPT WAS CUT BY THE TOKEN CAP BEFORE ANY OUTPUT. Do NOT deliberate: at most 20 words of internal reasoning, then the JSON object immediately.\n${basePrompt}`
        : basePrompt;
      const text = await chatText(this.t, MODELS.omni, prompt, 8000);
      const v = extractJson<{ question: string; mustContain: string[] }>(text, { question: '', mustContain: [] });
      if (v.question && Array.isArray(v.mustContain) && v.mustContain.length > 0) {
        return { question: v.question, mustContain: v.mustContain.map(String) };
      }
    }
    return null;
  }

  async calibrateTeam(input: TeamCalibrationInput): Promise<TeamCalibration> {
    // Nemotron designs the agent team AND its workspace ops from the corpus
    // signal and the user's intent sentence; any parse failure falls back to
    // the keyword heuristic.
    const text = await chatText(this.t, MODELS.omni, [{ type: 'text', text: teamPrompt(input) }], 8000);
    return parseTeamCalibration(text) ?? heuristicCalibration(input);
  }

  async tagPages(pages: { page: number; text?: string }[]): Promise<Record<number, PageKind>> {
    const withText = pages.filter((p) => (p.text ?? '').trim().length > 40);
    if (withText.length === 0) return {};
    const listing = withText.map((p) => `p.${p.page}: "${(p.text ?? '').slice(0, 200).replace(/\n+/g, ' ')}"`).join('\n');
    const text = await chatText(this.t, MODELS.omni,
      `You are ${workflowProfile().agentRole} indexing a document for retrieval. For each page snippet below, pick the page's function.\n${listing}\nAllowed values: "error-table" (fault/error-code listing), "troubleshooting" (symptom-to-fix procedures), "schematic" (wiring/diagrams), "procedure" (step-by-step instructions), "parts" (part lists), "safety" (warnings), "coverage-table" (what is covered/excluded, limits, deductibles), "other" (covers, TOC, prose). Most pages are "other" - only tag a page when its snippet clearly shows the function. Do NOT deliberate: at most 20 words of internal reasoning, then output ONLY a JSON object mapping page numbers to values, e.g. {"12":"error-table","30":"other"}.`, 8000);
    const raw = extractJson<Record<string, string>>(text, {});
    const allowed = new Set(['error-table', 'troubleshooting', 'schematic', 'procedure', 'parts', 'safety', 'coverage-table']);
    const out: Record<number, PageKind> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (allowed.has(v)) out[Number(k)] = v as PageKind;
    }
    return out;
  }

  async classify(input: ClassifyInput): Promise<DocMeta> {
    const basePrompt = `Classify this document (filename: ${input.filename}). First pages attached. ${workflowProfile().classifyHint}. Return STRICT JSON: {"category": string (lowercase), "brand": string, "model": string, "docType": "service"|"user"|"schematic"|"parts", "pageKinds": []} Do not deliberate at length: keep any internal reasoning under 100 words, then output ONLY the JSON object.`;
    const images = input.pageImages.slice(0, 3).map((img) => ({ type: 'image_url', image_url: { url: img } }));
    const fallback: DocMeta = { category: 'uncategorized', brand: 'Unknown', model: 'Unknown', docType: 'user', pageKinds: [] };
    // Same two-regime retry as diagnose: dense legal cover pages make the
    // model ruminate past the token cap (measured: 4 of 6 policy wordings).
    for (const [i, take] of [3, 3, 1].entries()) {
      const head = i === 0 ? basePrompt
        : `YOUR PREVIOUS ATTEMPT WAS CUT BY THE TOKEN CAP BEFORE ANY OUTPUT. Do NOT deliberate: at most 20 words of internal reasoning, then the JSON object immediately.\n${basePrompt}`;
      let text: string;
      try {
        text = await chatText(this.t, MODELS.omni, [{ type: 'text', text: head }, ...images.slice(0, take)], 8000);
      } catch {
        continue; // gateway timeout or transient 5xx = a lost attempt, not a dead step: next rung
      }
      const meta = extractJson<DocMeta>(text, fallback);
      if (meta !== fallback) {
        meta.pageKinds = input.pageImages.map(() => 'other');
        return meta;
      }
    }
    fallback.pageKinds = input.pageImages.map(() => 'other');
    return fallback;
  }
}
