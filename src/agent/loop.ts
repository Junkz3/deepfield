import type { Conversation, Diagnosis, Document, GuidedStep, PartLine, PhaseEvent, SafetyInfo, ScoredPage, Turn, WorkOrder } from './types';
import { FREEFORM_SYMPTOM } from './types';
import type { ModelDriver } from './driver';
import { candidatePages, pageTitle, scopeSummary, trimPool } from './taxonomy';
import { activeTools } from './tools';
import { computeConfidence, workOrderConfidence } from './confidence';
import { activeAgents, setWorkflowProfile, workflowProfile } from './workflow';

export interface StepInput { conversation: Conversation; docs: Document[]; userInput?: string }

const toCitation = (s: ScoredPage) => ({
  docId: s.page.docId, page: s.page.page, region: s.page.region,
  quote: s.page.text?.slice(0, 120), timestamp: s.page.timestamp,
  label: `${s.page.docId} p.${s.page.page} (${s.page.kind})`,
  title: pageTitle(s.page),
});

export async function* runStep(input: StepInput, driver: ModelDriver): AsyncGenerator<PhaseEvent, GuidedStep> {
  const { conversation, docs, userInput } = input;
  const q = { device: conversation.device, symptom: conversation.symptom };
  const events: PhaseEvent[] = [];
  const emit = (e: PhaseEvent) => { events.push(e); return e; };

  // Raw action tokens (button clicks) are not user prose: they neither seed
  // the conversation history nor stand in as a follow-up question.
  const ACTION_INPUT = /^(report-measurement:|find-video$|order-part:|show-citation:|compile-work-order$|open-ingest$|explain-deep$)/;
  // Conversation memory (last 2 resolved turns): threaded into plan and answer
  // so a follow-up ("are you sure?", "and page 20?") is understood against the
  // exchange, not read as a fresh standalone request. Vertical-agnostic.
  const originalQuestion = conversation.symptom === FREEFORM_SYMPTOM
    ? conversation.device
    : `${conversation.device}: ${conversation.symptom}`;
  const history: Turn[] = conversation.steps
    .filter((s) => s.answer ?? s.instruction)
    .slice(-2)
    .map((s) => ({
      question: s.userInput && !ACTION_INPUT.test(s.userInput) ? s.userInput : originalQuestion,
      answer: (s.answer ?? s.instruction ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    }));

  // PLAN
  yield emit({ phase: 'plan', summary: 'Planning what evidence is needed' });
  const plan = await driver.plan({ ...q, hasPhoto: conversation.attachments.length > 0, userInput, history });
  yield emit({ phase: 'plan', summary: plan.goal });

  // ROUTE: with a team of active agents, the plan named the specialist for
  // THIS request (same call, no extra inference). Its profile drives every
  // downstream phase of the step - retrieval hints, decision mold, tools.
  const team = activeAgents();
  let agentLabel: string | undefined;
  if (team.length > 0) {
    const routed = team.length > 1
      ? team.find((a) => a.id.toLowerCase() === plan.agentId?.toLowerCase())
      : undefined;
    const chosen = routed ?? team[0];
    setWorkflowProfile(chosen.profile);
    agentLabel = chosen.label;
    if (team.length > 1) yield emit({ phase: 'plan', summary: `Routed to ${chosen.label}` });
  }

  // EXPLICIT PAGE REFERENCE. The user points at a page number ("look at page
  // 20", "a la page 20", "seite 20"): a direct instruction that overrides
  // similarity retrieval - fetch those pages from the in-scope corpus and read
  // them, preferring documents already cited in this conversation. The pattern
  // requires the word "page" (any of a few languages) or a dotted "p."/"pg."
  // so error codes like P0301 are never mistaken for a page number.
  const pageRefs = userInput && !ACTION_INPUT.test(userInput)
    ? [...userInput.matchAll(/(?:\b(?:pages?|páginas?|seiten?|pagine?)\s*\.?\s*|\bp{1,2}g?\.\s*)(\d{1,4})\b/gi)]
        .map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (pageRefs.length > 0 && userInput && driver.answer) {
    const scoped = candidatePages(docs, conversation.device);
    const citedDocs = new Set(conversation.steps.flatMap((s) => s.citations.map((c) => c.docId)));
    const preferred = scoped.filter((p) => pageRefs.includes(p.page) && citedDocs.has(p.docId));
    const pages = (preferred.length > 0 ? preferred : scoped.filter((p) => pageRefs.includes(p.page))).slice(0, 4);
    if (pages.length > 0) {
      yield emit({ phase: 'reason', summary: `Opening the page(s) you pointed to: ${[...new Set(pages.map((p) => p.page))].join(', ')}` });
      const text = await driver.answer(userInput, pages, 'qa', history);
      const citations = pages.map((p) => toCitation({ page: p, score: 0 }));
      const conf = computeConfidence({ exactCodeMatch: false, corroboratingCitations: Math.max(0, new Set(pages.map((p) => p.docId)).size - 1), requiredPageMissing: false });
      yield emit({ phase: 'decide', summary: 'Answer read from the page you cited' });
      return {
        index: conversation.steps.length, phaseEvents: events, agentLabel,
        instruction: text.split('\n')[0].slice(0, 200),
        answer: text,
        citations,
        proposedNext: [
          { label: 'Explain in depth', action: 'explain-deep' },
          { label: 'Compile work order', action: 'compile-work-order' },
        ],
        confidence: conf.value, confidenceReason: conf.reason, status: 'ok',
      };
    }
  }

  // WORKSPACE-SCOPE questions ("what can you help me with?"): the answer is
  // the workspace's own taxonomy, not any manual page. The inventory is
  // deterministic; the model only phrases it in the user's language. The
  // "cover"/"support" collision that used to misroute CONTENT questions here
  // is fixed upstream in the plan prompt (a scope label now means the question
  // is about the assistant ITSELF); the history reaches the answer so a scope
  // follow-up resolves against the exchange.
  if (plan.intent === 'scope' && driver.answer) {
    yield emit({ phase: 'reason', summary: 'Reading the workspace index itself' });
    const inventory = scopeSummary(docs);
    const inventoryPage = { docId: 'workspace-index', page: 1, imageUrl: '', text: inventory, kind: 'other' as const };
    const text = await driver.answer(
      userInput && userInput.trim().length > 0 ? userInput : `${conversation.device}: ${conversation.symptom}`,
      [inventoryPage], 'qa', history,
    );
    yield emit({ phase: 'decide', summary: 'Answered from the workspace index' });
    return {
      index: conversation.steps.length, phaseEvents: events, agentLabel,
      instruction: text.split('\n')[0].slice(0, 200),
      answer: text,
      citations: [],
      proposedNext: [],
      confidence: 0.95, confidenceReason: 'answered from the workspace index itself', status: 'ok',
    };
  }

  // A reported measurement is plain conversation: the technician types the
  // reading, the plan reforges around it and the next verdict weighs it
  // against the values printed in the manual pages - no invented spec table.

  // RETRIEVE (driven by sufficiency, max 3)
  const candidates = candidatePages(docs, conversation.device);
  const videoIntent = userInput === 'find-video' || /video|walkthrough/i.test(userInput ?? '');
  let retrieved: ScoredPage[] = [];
  let evidenceIncomplete = false;
  let keyPages: number[] = [];
  let query = plan.queries[0] ?? `${conversation.device} ${conversation.symptom}`;
  for (let round = 0; round < 3; round++) {
    yield emit({ phase: 'retrieve', summary: `Searching the knowledge base: "${query}"` });
    // Later rounds search what is NOT already retained: each round discovers.
    const pool = round === 0 ? candidates
      : candidates.filter((p) => !retrieved.some((r) => r.page.docId === p.docId && r.page.page === p.page));
    // Text-side prefilter: the visual rerank pays ~900 tokens per page image.
    const trimmed = trimPool(query, pool);
    let results: ScoredPage[];
    try {
      results = await driver.retrieve(query, trimmed);
    } catch (err) {
      // A transient rerank 500 must not kill the step. With pages already
      // retained, reason over those; with nothing yet, one retry then give up.
      if (retrieved.length > 0) break;
      yield emit({ phase: 'retrieve', summary: 'Retrieval hiccup - retrying' });
      await new Promise((r) => setTimeout(r, 2000));
      results = await driver.retrieve(query, trimmed);
    }
    // Dynamic top = union of the classic top-3 and anything within 85% of
    // the best score, capped at 5. Never LESS context than a fixed top-3
    // (an 85%-only filter starved the diagnosis when the best score was
    // isolated), but a 4th-ranked table entry still makes the cut.
    const eligible = results.filter((r) => r.score >= 1.5);
    const best = eligible[0]?.score ?? 0;
    const top = eligible.filter((r, i) => i < 3 || r.score >= best * 0.85).slice(0, 5);
    yield emit({
      phase: 'retrieve',
      summary: top.length > 0 ? `Found ${top.length} relevant page(s)` : 'No relevant pages found',
      hitPages: top.map((t) => ({ docId: t.page.docId, page: t.page.page })),
      citations: top.map(toCitation),
    });
    retrieved.push(...top.filter((t) => !retrieved.some((r) => r.page.docId === t.page.docId && r.page.page === t.page.page)));
    if (retrieved.length === 0) break;
    if (videoIntent && retrieved.some((r) => r.page.kind === 'video-segment')) break; // media step: no depth needed

    // (A structural-completeness shortcut lived here briefly: it skipped the
    // sufficiency call when kinds looked complete, and promptly dived on the
    // WRONG table page in the generator case. With sufficiency on Nemotron
    // at ~3-5s the shortcut saves nothing worth that risk - the model READS
    // the evidence, kinds alone do not.)
    const verdict = await driver.assessSufficiency(q, retrieved);
    evidenceIncomplete = !verdict.sufficient;
    if (verdict.keyPages?.length) keyPages = verdict.keyPages;
    if (verdict.sufficient || !verdict.followupQuery) break;
    yield emit({ phase: 'retrieve', summary: 'Evidence insufficient - retrieving again', detail: verdict.reason });
    query = verdict.followupQuery;
  }

  // MEDIA step: the user asked for the video, the diagnosis already exists.
  // Deliver the timestamped segments directly - no re-diagnosis pass.
  const videoHits = retrieved.filter((r) => r.page.kind === 'video-segment');
  if (videoIntent && videoHits.length > 0) {
    const citations = videoHits.map(toCitation);
    const conf = computeConfidence({ exactCodeMatch: false, corroboratingCitations: citations.length - 1, requiredPageMissing: false });
    yield emit({ phase: 'decide', summary: `Video walkthrough: ${videoHits.length} segment(s) at their exact seconds` });
    return {
      index: conversation.steps.length, phaseEvents: events, agentLabel,
      instruction: `Video walkthrough found. ${videoHits.length} step(s) cited at their exact timestamps - click a segment to play it at the right second.`,
      citations,
      proposedNext: [
        { label: 'Compile work order', action: 'compile-work-order' },
      ],
      confidence: conf.value, confidenceReason: conf.reason, status: 'ok',
    };
  }

  // NO EVIDENCE guardrail
  if (retrieved.length === 0) {
    const conf = computeConfidence({ exactCodeMatch: false, corroboratingCitations: 0, requiredPageMissing: true });
    yield emit({ phase: 'decide', summary: 'Cannot proceed without grounded evidence' });
    return {
      index: conversation.steps.length, phaseEvents: events, agentLabel,
      instruction: `No relevant pages for "${conversation.device}" in the knowledge base. Upload its manual, or I can only offer generic guidance.`,
      citations: [], proposedNext: [{ label: 'Upload a manual', action: 'open-ingest' }],
      confidence: conf.value, confidenceReason: conf.reason, status: 'no-evidence',
    };
  }

  // QUESTION intent: informational asks deserve a full grounded ANSWER, not
  // a diagnosis mold. Same retrieval, free-form cited prose out.
  const deepDive = userInput === 'explain-deep';
  const answerMode = workflowProfile().decisionMode === 'answer';
  if ((answerMode || plan.intent === 'question' || deepDive) && driver.answer) {
    yield emit({ phase: 'reason', summary: deepDive ? 'Re-reading the cited pages in depth' : 'Reading the pages to answer' });
    const questionText = deepDive
      ? `Explain in depth: ${conversation.symptom} (device: ${conversation.device})`
      : (userInput && !ACTION_INPUT.test(userInput) ? userInput : `${conversation.device}: ${conversation.symptom}`);
    // Scores accumulated across rounds come from DIFFERENT queries (the
    // assess followups), so they are not comparable: a specs page can outrank
    // the page holding the actual value. Worse, similarity ranks covers and
    // TOC pages above value tables (they list every keyword). The sufficiency
    // judge READ the evidence listing: the pages it named come first. Only
    // when it named none, fall back to a re-rank against the real question.
    let bestFirst = [...retrieved].sort((a, b) => b.score - a.score);
    if (keyPages.length > 0) {
      const isKey = (r: ScoredPage) => keyPages.includes(r.page.page);
      bestFirst = [...bestFirst.filter(isKey), ...bestFirst.filter((r) => !isKey(r))];
    } else if (retrieved.length > 4) {
      yield emit({ phase: 'reason', summary: 'Focusing the retained pages on the question' });
      try {
        const rescored = await driver.retrieve(questionText, retrieved.map((r) => r.page));
        if (rescored.length > 0) bestFirst = rescored;
      } catch { /* keep the cross-round order */ }
    }
    const text = await driver.answer(questionText, bestFirst.map((r) => r.page), deepDive ? 'deep' : 'qa', deepDive ? undefined : history);
    const citations = bestFirst.map(toCitation);
    const distinct = Math.max(new Set(retrieved.map((r) => r.page.docId)).size, new Set(retrieved.map((r) => r.page.kind)).size);
    const conf = computeConfidence({ exactCodeMatch: false, corroboratingCitations: distinct - 1, requiredPageMissing: evidenceIncomplete });
    yield emit({ phase: 'decide', summary: 'Answer grounded in the cited pages' });
    return {
      index: conversation.steps.length, phaseEvents: events, agentLabel,
      instruction: text.split('\n')[0].slice(0, 200),
      answer: text,
      citations,
      proposedNext: [
        { label: 'Explain in depth', action: 'explain-deep' },
        { label: 'Compile work order', action: 'compile-work-order' },
      ],
      confidence: conf.value, confidenceReason: conf.reason, status: 'ok',
    };
  }

  // REASON (multimodal). diagnose reads the first 4 pages only: the ones the
  // sufficiency judge named come first (same rule as answer), accumulation
  // order for the rest.
  yield emit({ phase: 'reason', summary: 'Reading the retrieved pages' + (conversation.attachments.length > 0 ? ' and your photo' : '') });
  let evidenceOrder = keyPages.length > 0
    ? [...retrieved.filter((r) => keyPages.includes(r.page.page)), ...retrieved.filter((r) => !keyPages.includes(r.page.page))]
    : retrieved;
  let diagnosis = await driver.diagnose(q, evidenceOrder.map((r) => r.page), conversation.attachments[0]?.dataUrl);
  yield emit({ phase: 'reason', summary: `Likely fault: ${diagnosis.component}`, detail: diagnosis.cause });

  // SECOND LOOK. An "insufficient evidence" verdict with pages in hand is
  // often a retrieval bias, not a corpus gap (measured on the bench: a plan
  // query carrying the device name crowns the pages that DISPLAY that name,
  // covers and title pages, over the fault table - Brother "Jam Rear" read
  // four covers and surrendered while the error table sat at rank 6). The
  // scope already encodes the device, so before the honest no-evidence step,
  // retry ONCE with the bare symptom over the pages not yet read.
  if (/insufficient|insuffisan/i.test(diagnosis.component)) {
    const bareQuery = conversation.symptom === FREEFORM_SYMPTOM ? conversation.device : conversation.symptom;
    const pool = candidates.filter((p) => !retrieved.some((r) => r.page.docId === p.docId && r.page.page === p.page));
    yield emit({ phase: 'retrieve', summary: `Second look: searching "${bareQuery}" beyond the pages already read` });
    try {
      const second = await driver.retrieve(bareQuery, trimPool(bareQuery, pool));
      const extra = second
        .filter((r) => r.score >= 1.5 && !retrieved.some((x) => x.page.docId === r.page.docId && x.page.page === r.page.page))
        .slice(0, 4);
      if (extra.length > 0) {
        yield emit({
          phase: 'retrieve', summary: `Second look retained ${extra.length} new page(s)`,
          hitPages: extra.map((t) => ({ docId: t.page.docId, page: t.page.page })),
          citations: extra.map(toCitation),
        });
        evidenceOrder = [...extra, ...evidenceOrder];
        retrieved.push(...extra);
        diagnosis = await driver.diagnose(q, evidenceOrder.map((r) => r.page), conversation.attachments[0]?.dataUrl);
        yield emit({ phase: 'reason', summary: `Likely fault: ${diagnosis.component}`, detail: diagnosis.cause });
      }
    } catch { /* the second look is best-effort: fall through to the honest no-evidence step */ }
  }

  // The model refusing to invent IS a feature: when the pages truly do not
  // support a diagnosis (index pages pointing at procedures not in the KB),
  // deliver an honest no-evidence step - no phantom parts, no 'undefined'.
  if (/insufficient|insuffisan/i.test(diagnosis.component)) {
    const conf = computeConfidence({ exactCodeMatch: false, corroboratingCitations: 0, requiredPageMissing: true });
    yield emit({ phase: 'decide', summary: 'The retrieved pages do not support a grounded diagnosis' });
    return {
      index: conversation.steps.length, phaseEvents: events, agentLabel,
      instruction: `The pages found (see citations) reference procedures that are not in the knowledge base yet. Upload the full service manual for "${conversation.device}", or open the cited index pages to locate the paper procedure.`,
      citations: retrieved.map(toCitation),
      proposedNext: [{ label: 'Upload the full manual', action: 'open-ingest' }],
      confidence: conf.value, confidenceReason: conf.reason, status: 'no-evidence',
    };
  }

  // DEEP READ: manuals answer in cross-references ("test fuel solenoid,
  // paragraph 2-95.1"). Follow the first ones like a technician would - one
  // targeted retrieve, referenced pages join the citations.
  const refPattern = /(?:paragraph|para\.?|section|see page|WP)\s+([0-9][0-9A-Za-z.-]{1,10})/gi;
  const refs = [...new Set(
    [...`${diagnosis.checks.join(' ')} ${diagnosis.instruction ?? ''}`.matchAll(refPattern)].map((m) => m[1]),
  )].slice(0, 2);
  if (refs.length > 0) {
    yield emit({ phase: 'reason', summary: `Following the manual's cross-reference${refs.length > 1 ? 's' : ''}: ${refs.join(', ')}` });
    const pool = candidates.filter((p) => !retrieved.some((r) => r.page.docId === p.docId && r.page.page === p.page));
    const refQuery = `${refs.join(' ')} ${diagnosis.component} procedure`;
    const followed = await driver.retrieve(refQuery, trimPool(refQuery, pool));
    const extra = followed.filter((r) => r.score >= 1.5).slice(0, 2);
    if (extra.length > 0) {
      retrieved.push(...extra);
      yield emit({
        phase: 'reason',
        summary: `Referenced procedure${extra.length > 1 ? 's' : ''} pulled into the evidence`,
        hitPages: extra.map((t) => ({ docId: t.page.docId, page: t.page.page })),
        citations: extra.map(toCitation),
      });
    }
  }

  // TOOLS: the agent CHOSE its operations inside the verdict (diagnosis.tools
  // names registry ops); the loop only executes what was requested. Nothing
  // is hard-wired: this point sits on the diagnose path only (answer-mode
  // returned above), so whatever ops the workspace installed - shipped
  // registry or calibration-written - are on offer.
  const ops = activeTools();
  const requested = (diagnosis.tools ?? [])
    .map((req) => ({ req, tool: ops.find((t) => t.id === req.id) }))
    .filter((x): x is { req: { id: string; args?: Record<string, string> }; tool: (typeof ops)[number] } => x.tool !== undefined);
  yield emit({
    phase: 'tools',
    summary: requested.length > 0
      ? `Agent requested: ${requested.map((x) => x.tool.label.toLowerCase()).join(', ')}`
      : 'Cross-checking the cited sources',
  });
  // Lookup ops search the workspace corpus themselves - hand them the pages.
  const toolCtx = { device: conversation.device, component: `${diagnosis.componentKey ?? ''} ${diagnosis.component}`.trim(), pages: candidates };
  for (const { req, tool } of requested) {
    const run = await tool.run(req.args ?? {}, toolCtx);
    yield emit({
      phase: 'tools',
      summary: `${tool.label}: ${run.summary}`,
      ...(run.pages && run.pages.length > 0 ? {
        hitPages: run.pages.map((p) => ({ docId: p.docId, page: p.page })),
        citations: run.pages.map((p) => toCitation({ page: p, score: 0 })),
      } : {}),
    });
  }

  // DECIDE
  const citations = retrieved.map(toCitation);
  // Generic exact-code detection: any code-like token from the symptom
  // (E3, DTC 21, P0301, F7 E1...) found in a retained page's text or kind.
  const codes = (conversation.symptom.match(/\b[a-z]{0,4}[-\s]?\d{1,4}\b/gi) ?? [])
    .map((c) => c.replace(/[-\s]/g, '').toLowerCase())
    .filter((c) => /\d/.test(c) && c.length >= 2);
  const exactCodeMatch = codes.length > 0 && retrieved.some((r) =>
    r.page.kind === 'error-table' ||
    codes.some((c) => (r.page.text ?? '').replace(/[-\s]/g, '').toLowerCase().includes(c)));
  // Corroboration = distinct SOURCES (documents / page kinds), not raw count:
  // six pages of the same manual are one voice, not five echoes.
  const distinctSources = Math.max(
    new Set(retrieved.map((r) => r.page.docId)).size,
    new Set(retrieved.map((r) => r.page.kind)).size,
  );
  // The sufficiency judge reads text SNIPPETS and keeps doubting pages whose
  // snippet cuts off before the answer (measured: it re-asked for an
  // error-code table it had RETAINED since round one). When the exact code
  // is literally in the retained evidence and a full verdict came out, that
  // doubt is refuted by the facts - no missing-page penalty.
  const conf = computeConfidence({ exactCodeMatch, corroboratingCitations: distinctSources - 1, requiredPageMissing: evidenceIncomplete && !exactCodeMatch });
  yield emit({ phase: 'decide', summary: `First check: ${diagnosis.checks[0] ?? diagnosis.instruction ?? 'see cited pages'}` });

  // Proposed actions follow the DIAGNOSIS, not a fixed script. The model
  // writes the contextual follow-ups inside its verdict (what the user
  // would naturally send next); they feed the open-reply flow. Measurements
  // are typed as real values, never pre-filled buttons.
  const proposedNext: { label: string; action: string }[] = [];
  for (const f of (diagnosis.followups ?? []).slice(0, 2)) {
    const t = String(f).trim();
    if (t.length > 3) proposedNext.push({ label: t, action: `ask:${t}` });
  }
  // Offer the video only when its segments actually cover the diagnosed
  // component - a walkthrough for another part is worse than no button.
  const compTokens = `${diagnosis.componentKey ?? ''} ${diagnosis.component}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  const hasVideo = candidates.some((p) => p.kind === 'video-segment'
    && compTokens.some((t) => `${p.docId} ${p.title ?? ''} ${p.text ?? ''}`.toLowerCase().includes(t)));
  if (hasVideo) proposedNext.push({ label: 'Show me the replacement video', action: 'find-video' });
  if (citations.length > 1) proposedNext.push({ label: 'Show the corroborating page', action: 'show-citation:1' });
  proposedNext.push({ label: 'Explain in depth', action: 'explain-deep' });
  proposedNext.push({ label: 'Compile work order', action: 'compile-work-order' });

  return {
    index: conversation.steps.length, phaseEvents: events, agentLabel,
    instruction: diagnosis.instruction ?? `${diagnosis.cause} First: ${diagnosis.checks[0]}.`,
    citations,
    proposedNext: proposedNext.slice(0, 6),
    confidence: conf.value, confidenceReason: conf.reason, status: 'ok',
    diagnosis,
    // The pages the verdict was actually read from (diagnose sees the first
    // four): engine-guaranteed sourcing, whatever the model chose to cite.
    readPages: evidenceOrder.slice(0, 4).map((r) => ({ docId: r.page.docId, page: r.page.page })),
  };
}

export function compileWorkOrder(conversation: Conversation, diagnosis: Diagnosis, parts: PartLine[], safety: SafetyInfo): WorkOrder {
  const allCitations = conversation.steps.flatMap((s) => s.citations);
  const missingDocs = conversation.steps.filter((s) => s.status === 'no-evidence').map((s) => s.instruction);
  const conf = workOrderConfidence(conversation.steps);
  return {
    device: conversation.device, symptom: conversation.symptom, diagnosis,
    procedure: ['Disconnect power.', ...diagnosis.checks.map((c) => `Check: ${c}.`), 'Replace the confirmed faulty component.', 'Run a test cycle to confirm the fault is cleared.'],
    parts, safety: safety.lines, citations: allCitations, missingDocs,
    confidence: conf.value, confidenceReason: conf.reason,
  };
}
