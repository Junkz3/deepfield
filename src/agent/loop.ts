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
        instruction: `${verdict.verdict} Now test the ${verdict.suggestedComponent}: ${diagnosis.checks[0]}`,
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
  let retrieved: ScoredPage[] = [];
  let query = plan.queries[0] ?? `${conversation.device} ${conversation.symptom}`;
  for (let round = 0; round < 3; round++) {
    yield emit({ phase: 'retrieve', summary: `Searching the knowledge base: "${query}"` });
    const results = await driver.retrieve(query, candidates);
    const top = results.filter((r) => r.score >= 1.5).slice(0, 3);
    yield emit({
      phase: 'retrieve',
      summary: top.length > 0 ? `Found ${top.length} relevant page(s)` : 'No relevant pages found',
      hitPages: top.map((t) => ({ docId: t.page.docId, page: t.page.page })),
      citations: top.map(toCitation),
    });
    retrieved.push(...top.filter((t) => !retrieved.some((r) => r.page.docId === t.page.docId && r.page.page === t.page.page)));
    if (retrieved.length === 0) break;
    const verdict = await driver.assessSufficiency(q, retrieved);
    if (verdict.sufficient || !verdict.followupQuery) break;
    yield emit({ phase: 'retrieve', summary: 'Evidence insufficient - retrieving again', detail: verdict.reason });
    query = verdict.followupQuery;
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

  // TOOLS
  yield emit({ phase: 'tools', summary: 'Checking parts and safety' });
  const partRef = PART_FOR[diagnosis.component.toLowerCase().includes('heat') ? 'heating element' : 'thermistor'];
  const part = await getPart(partRef);
  const safety = await checkSafety(`${conversation.device.toLowerCase().includes('hmmwv') || conversation.device.toLowerCase().includes('vehicle') ? 'vehicle: ' : ''}replace ${diagnosis.component}`);
  yield emit({ phase: 'tools', summary: `${part.name}: ${part.inStock ? 'in stock' : `lead time ${part.leadDays}d`} - safety notes attached` });

  // DECIDE
  const citations = retrieved.map(toCitation);
  const exactCodeMatch = /e3|dtc/i.test(conversation.symptom) && retrieved.some((r) => r.page.kind === 'error-table');
  const conf = computeConfidence({ exactCodeMatch, corroboratingCitations: citations.length - 1, requiredPageMissing: false });
  yield emit({ phase: 'decide', summary: `First check: ${diagnosis.checks[0]}` });

  // Proposed actions follow the DIAGNOSIS, not a fixed script.
  const component = diagnosis.component.toLowerCase();
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
    instruction: `${diagnosis.cause} Start with: ${diagnosis.checks[0]}.`,
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
