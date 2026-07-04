import type { Conversation, Diagnosis, Document, GuidedStep, PartLine, PhaseEvent, SafetyInfo, ScoredPage, WorkOrder } from './types';
import type { ModelDriver } from './driver';
import { candidatePages, pageTitle } from './taxonomy';
import { checkMeasurement, checkSafety, getPart } from './tools';
import { computeConfidence, workOrderConfidence } from './confidence';

export interface StepInput { conversation: Conversation; docs: Document[]; userInput?: string }

const PART_FOR: Record<string, string> = {
  'heating element': 'W10518394',
  thermistor: 'WPW10352973',
};

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

  // PLAN
  yield emit({ phase: 'plan', summary: 'Planning what evidence is needed' });
  const plan = await driver.plan({ ...q, hasPhoto: conversation.attachments.length > 0, userInput });
  yield emit({ phase: 'plan', summary: plan.goal });

  // Measurement pivot path: tool call decides, then re-diagnose
  if (userInput?.startsWith('report-measurement:')) {
    const [, component, value] = userInput.split(':');
    yield emit({ phase: 'tools', summary: `Checking ${component} reading against manual spec` });
    const verdict = await checkMeasurement(component, Number(value));
    yield emit({ phase: 'tools', summary: verdict.verdict });
    if (verdict.withinSpec && verdict.suggestedComponent) {
      yield emit({ phase: 'reason', summary: `Hypothesis changed: ${component} is OK, pivoting to ${verdict.suggestedComponent}` });
      const diagnosis = await driver.diagnose(q, []); // pivot contract
      const partRef = PART_FOR[verdict.suggestedComponent] ?? PART_FOR[diagnosis.component.toLowerCase()] ?? 'WPW10352973';
      yield emit({ phase: 'tools', summary: 'Checking replacement part availability' });
      const part = await getPart(partRef);
      yield emit({ phase: 'decide', summary: `Next: test the ${verdict.suggestedComponent}` });
      const conf = computeConfidence({ exactCodeMatch: true, corroboratingCitations: 1, requiredPageMissing: false });
      return {
        index: conversation.steps.length, phaseEvents: events,
        instruction: diagnosis.instruction ? `${verdict.verdict} ${diagnosis.instruction}` : `${verdict.verdict} Now test the ${verdict.suggestedComponent}: ${diagnosis.checks[0]}`,
        citations: [], proposedNext: [
          { label: `Order ${part.name} (${part.ref})`, action: `order-part:${part.ref}` },
          { label: `${verdict.suggestedComponent} also in spec`, action: `report-measurement:${verdict.suggestedComponent}:52000` },
          { label: 'Compile work order', action: 'compile-work-order' },
        ],
        confidence: conf.value, confidenceReason: conf.reason, status: 'ok',
        diagnosis, parts: [part], safety: await checkSafety(`replace ${verdict.suggestedComponent}`),
      };
    }
  }

  // RETRIEVE (driven by sufficiency, max 3)
  const candidates = candidatePages(docs, conversation.device);
  const videoIntent = userInput === 'find-video' || /video|walkthrough/i.test(userInput ?? '');
  let retrieved: ScoredPage[] = [];
  let evidenceIncomplete = false;
  let query = plan.queries[0] ?? `${conversation.device} ${conversation.symptom}`;
  for (let round = 0; round < 3; round++) {
    yield emit({ phase: 'retrieve', summary: `Searching the knowledge base: "${query}"` });
    // Later rounds search what is NOT already retained: each round discovers.
    const pool = round === 0 ? candidates
      : candidates.filter((p) => !retrieved.some((r) => r.page.docId === p.docId && r.page.page === p.page));
    const results = await driver.retrieve(query, pool);
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
      index: conversation.steps.length, phaseEvents: events,
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
      index: conversation.steps.length, phaseEvents: events,
      instruction: `No relevant pages for "${conversation.device}" in the knowledge base. Upload its manual, or I can only offer generic guidance.`,
      citations: [], proposedNext: [{ label: 'Upload a manual', action: 'open-ingest' }],
      confidence: conf.value, confidenceReason: conf.reason, status: 'no-evidence',
    };
  }

  // REASON (multimodal)
  yield emit({ phase: 'reason', summary: 'Reading the retrieved pages' + (conversation.attachments.length > 0 ? ' and your photo' : '') });
  const diagnosis = await driver.diagnose(q, retrieved.map((r) => r.page), conversation.attachments[0]?.dataUrl);
  yield emit({ phase: 'reason', summary: `Likely fault: ${diagnosis.component}`, detail: diagnosis.cause });

  // The model refusing to invent IS a feature: when the pages truly do not
  // support a diagnosis (index pages pointing at procedures not in the KB),
  // deliver an honest no-evidence step - no phantom parts, no 'undefined'.
  if (/insufficient|insuffisan/i.test(diagnosis.component)) {
    const conf = computeConfidence({ exactCodeMatch: false, corroboratingCitations: 0, requiredPageMissing: true });
    yield emit({ phase: 'decide', summary: 'The retrieved pages do not support a grounded diagnosis' });
    return {
      index: conversation.steps.length, phaseEvents: events,
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
    const followed = await driver.retrieve(`${refs.join(' ')} ${diagnosis.component} procedure`, pool);
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

  // TOOLS
  yield emit({ phase: 'tools', summary: 'Checking parts and safety' });
  // Part lookup by machine key; devices without a catalog entry get an honest
  // OEM-sourcing line instead of a dishwasher part.
  const compKey = `${diagnosis.componentKey ?? ''} ${diagnosis.component}`.toLowerCase();
  const partRef = PART_FOR[compKey.trim()] ?? (compKey.includes('heat') ? PART_FOR['heating element'] : compKey.includes('therm') ? PART_FOR['thermistor'] : undefined);
  const part = partRef
    ? await getPart(partRef)
    : { ref: 'OEM', name: `${diagnosis.component} (source via OEM parts catalog)`, inStock: false, leadDays: undefined };
  const safety = await checkSafety(`${conversation.device.toLowerCase().includes('hmmwv') || conversation.device.toLowerCase().includes('vehicle') ? 'vehicle: ' : ''}replace ${diagnosis.component}`);
  yield emit({ phase: 'tools', summary: `${part.name}: ${part.inStock ? 'in stock' : part.leadDays ? `lead time ${part.leadDays}d` : 'order from OEM'} - safety notes attached` });

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
  const conf = computeConfidence({ exactCodeMatch, corroboratingCitations: distinctSources - 1, requiredPageMissing: evidenceIncomplete });
  yield emit({ phase: 'decide', summary: `First check: ${diagnosis.checks[0] ?? diagnosis.instruction ?? 'see cited pages'}` });

  // Proposed actions follow the DIAGNOSIS, not a fixed script. The machine
  // key stays English even when the display language does not.
  const component = `${diagnosis.componentKey ?? ''} ${diagnosis.component}`.toLowerCase();
  const proposedNext: { label: string; action: string }[] = [];
  if (component.includes('heat')) {
    proposedNext.push(
      { label: 'Heater measured 22 ohms (in spec)', action: 'report-measurement:heating element:22' },
      { label: 'Heater open circuit (0 ohms)', action: 'report-measurement:heating element:0' },
    );
  } else if (component.includes('thermistor') || component.includes('sensor')) {
    proposedNext.push({ label: 'Sensor reads in spec', action: 'report-measurement:thermistor:52000' });
  }
  const hasVideo = candidates.some((p) => p.kind === 'video-segment');
  if (hasVideo) proposedNext.push({ label: 'Show me the replacement video', action: 'find-video' });
  if (citations.length > 1) proposedNext.push({ label: 'Show the corroborating page', action: 'show-citation:1' });
  proposedNext.push({ label: 'Compile work order', action: 'compile-work-order' });

  return {
    index: conversation.steps.length, phaseEvents: events,
    instruction: diagnosis.instruction ?? `${diagnosis.cause} First: ${diagnosis.checks[0]}.`,
    citations,
    proposedNext: proposedNext.slice(0, 4),
    confidence: conf.value, confidenceReason: conf.reason, status: 'ok',
    diagnosis, parts: [part], safety,
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
