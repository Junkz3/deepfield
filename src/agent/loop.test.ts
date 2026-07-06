import { afterEach, describe, expect, it } from 'vitest';
import { FakeDriver } from './driver';
import type { ModelDriver } from './driver';
import { runStep } from './loop';
import { E3_PAGES, HERO_DOC_ID } from './fixtures/e3-case';
import { setWorkflowProfile, setWorkflowTeam } from './workflow';
import { FREEFORM_SYMPTOM } from './types';
import type { Conversation, Document, GuidedStep, Page, PhaseEvent, PlanAction, ScoredPage, Turn } from './types';

const heroDoc: Document = {
  id: HERO_DOC_ID, filename: 'whirlpool service manual.pdf', format: 'pdf',
  category: 'dishwasher', brand: 'Whirlpool', model: 'W11187658', docType: 'service',
  pages: Object.values(E3_PAGES), sourceRights: 'Whirlpool official', origin: 'corpus',
};

const conv = (): Conversation => ({
  id: 'c1', device: 'Whirlpool dishwasher', symptom: 'error code E3, does not heat',
  attachments: [], steps: [], userInputs: [], status: 'active',
});

async function drain(gen: AsyncGenerator<PhaseEvent, GuidedStep>) {
  const events: PhaseEvent[] = [];
  while (true) {
    const n = await gen.next();
    if (n.done) return { events, step: n.value };
    events.push(n.value);
  }
}

const drv = new FakeDriver({ delayScale: 0 });

describe('runStep - hero E3 first step', () => {
  it('runs plan -> retrieve x2 (autonomous) -> reason -> tools -> decide with visible decision', async () => {
    const { events, step } = await drain(runStep({ conversation: conv(), docs: [heroDoc] }, drv));
    const phases = events.map((e) => e.phase);
    expect(phases.filter((p) => p === 'retrieve').length).toBeGreaterThanOrEqual(3); // 2 starts + >=1 hit event
    expect(phases[0]).toBe('plan');
    const decisionEvent = events.find((e) => e.detail?.match(/wiring/i) && e.phase === 'retrieve');
    expect(decisionEvent, 'the autonomous re-retrieve decision must be narrated').toBeTruthy();
    expect(step.status).toBe('ok');
    expect(step.citations.map((c) => c.page)).toEqual(expect.arrayContaining([18, 25]));
    // distinct-source corroboration: one doc, three page kinds = two corroborations
    expect(step.confidence).toBeCloseTo(0.9, 5);
    expect(step.proposedNext.length).toBeGreaterThan(0);
    expect(step.instruction).toMatch(/heating element/i);
  });
  it('emits hitPages on retrieval results (galaxy pulse hook)', async () => {
    const { events } = await drain(runStep({ conversation: conv(), docs: [heroDoc] }, drv));
    const hits = events.filter((e) => e.hitPages && e.hitPages.length > 0);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].hitPages![0]).toEqual({ docId: HERO_DOC_ID, page: 18 });
  });
});

describe('runStep - requested ops execute against the real corpus', () => {
  it('narrates the agent-requested ops in the timeline', async () => {
    const { events } = await drain(runStep({ conversation: conv(), docs: [heroDoc] }, drv));
    // The offline script requests part_lookup + safety_notes in its verdict;
    // both are generic lookups now - they search the workspace pages.
    const requested = events.find((e) => e.phase === 'tools' && e.summary.startsWith('Agent requested:'));
    expect(requested?.summary).toMatch(/parts pages lookup/i);
    const runs = events.filter((e) => e.phase === 'tools' && /lookup:/i.test(e.summary));
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('runStep - second look after an insufficient verdict', () => {
  // Measured failure mode: the plan query carries the device name, the
  // visual rerank crowns the cover pages that display it, and the verdict
  // reads covers only. The second look retries with the bare symptom.
  const cover: Page = { docId: 'd', page: 1, imageUrl: '/p1.png', kind: 'other', text: 'Printer X100 user guide cover' };
  const table: Page = { docId: 'd', page: 9, imageUrl: '/p9.png', kind: 'error-table', text: 'Jam Rear: open the fuser cover and remove the jammed paper' };
  const printerDoc: Document = {
    id: 'd', filename: 'x100.pdf', format: 'pdf', category: 'printer', brand: 'X', model: 'X100',
    docType: 'user', pages: [cover, table], sourceRights: 'test', origin: 'corpus',
  };
  const stub = (diagnoseLog: Page[][]): ModelDriver => ({
    plan: async () => ({ goal: 'g', queries: ['X X100 printer jam rear display'] }),
    // The plan query (device tokens) surfaces the cover; the bare symptom
    // retry surfaces the error table.
    retrieve: async (query) => query.includes('display shows') ? [{ page: table, score: 3 }] : [{ page: cover, score: 3 }],
    assessSufficiency: async () => ({ sufficient: true, reason: 'r' }),
    diagnose: async (_q, evidence) => {
      diagnoseLog.push([...evidence]);
      return evidence.some((p) => p.kind === 'error-table')
        ? { component: 'fuser unit', cause: 'paper jammed at the rear', checks: ['open the fuser cover'] }
        : { component: 'insufficient evidence', cause: 'covers only', checks: [] };
    },
    classify: async () => ({ category: 'printer', brand: 'X', model: 'X100', docType: 'user', pageKinds: [] }),
  });

  it('retries with the bare symptom and recovers a grounded verdict', async () => {
    const diagnoseLog: Page[][] = [];
    const c = { ...conv(), device: 'X X100 printer', symptom: 'display shows Jam Rear' };
    const { events, step } = await drain(runStep({ conversation: c, docs: [printerDoc] }, stub(diagnoseLog)));
    expect(diagnoseLog.length).toBe(2);
    expect(diagnoseLog[1][0].page).toBe(9); // second read starts from the recovered page
    expect(step.status).toBe('ok');
    expect(step.diagnosis?.component).toBe('fuser unit');
    expect(step.citations.map((cit) => cit.page)).toContain(9);
    expect(events.some((e) => e.summary.startsWith('Second look')), 'the second look must be narrated').toBe(true);
  });

  it('still surrenders honestly when the second look finds nothing new', async () => {
    const diagnoseLog: Page[][] = [];
    const drvStub = stub(diagnoseLog);
    drvStub.retrieve = async () => [{ page: cover, score: 3 }]; // never finds the table
    const c = { ...conv(), device: 'X X100 printer', symptom: 'display shows Jam Rear' };
    const { step } = await drain(runStep({ conversation: c, docs: [printerDoc] }, drvStub));
    expect(step.status).toBe('no-evidence');
  });
});

describe('runStep - no evidence guardrail', () => {
  it('says what is missing instead of inventing', async () => {
    const bareDoc: Document = { ...heroDoc, id: 'bare', pages: [{ docId: 'bare', page: 1, imageUrl: '/x.png', kind: 'other' }] };
    const c = { ...conv(), device: 'Unknown fax machine', symptom: 'paper jam' };
    const { step } = await drain(runStep({ conversation: c, docs: [bareDoc] }, drv));
    expect(step.status).toBe('no-evidence');
    expect(step.confidence).toBeCloseTo(0.2, 5);
    expect(step.instruction).toMatch(/no relevant/i);
  });
});

// A2 (scope robustness), B (conversation memory) and C (open page N) are
// generic - proven here on an answer-mode (insurance) workspace, the vertical
// where the "cover" collision and the follow-up loop were observed.
describe('runStep - answer-mode robustness (A2 / B / C)', () => {
  afterEach(() => { setWorkflowProfile('repair'); setWorkflowTeam([]); }); // reset module singletons

  const covPage: Page = { docId: 'saga', page: 20, imageUrl: '/p20.png', kind: 'coverage-table', text: 'Key loss: replacement covered up to 500.' };
  const cover: Page = { docId: 'saga', page: 1, imageUrl: '/p1.png', kind: 'other', text: 'Saga Car policy cover' };
  const covDoc: Document = {
    id: 'saga', filename: 'saga car.pdf', format: 'pdf', category: 'auto policy', brand: 'Saga', model: 'Car',
    docType: 'user', pages: [cover, covPage], sourceRights: 'test', origin: 'corpus',
  };
  const insConv = (steps: GuidedStep[] = []): Conversation => ({
    id: 'i1', device: 'does the insurance cover a lost car key', symptom: FREEFORM_SYMPTOM,
    attachments: [], steps, userInputs: [], status: 'active',
  });
  const priorAnswer: GuidedStep = {
    index: 0, phaseEvents: [], instruction: 'Yes, covered up to 500 (p.20)',
    answer: 'Yes, a lost car key replacement is covered up to 500 (p.20).',
    citations: [{ docId: 'saga', page: 20, label: 'saga p.20' }],
    proposedNext: [], confidence: 0.7, confidenceReason: '', status: 'ok',
  };

  interface Rec { history?: Turn[]; context?: Turn[]; retrieveCount: number }
  const stub = (cfg: { intent: PlanAction['intent']; retrieve: (q: string) => ScoredPage[]; answerText: string; rec: Rec }): ModelDriver => ({
    plan: async (q) => { cfg.rec.history = q.history; return { goal: 'g', queries: ['car key loss coverage'], intent: cfg.intent }; },
    retrieve: async (query) => { cfg.rec.retrieveCount++; return cfg.retrieve(query); },
    assessSufficiency: async () => ({ sufficient: true, reason: 'ok' }),
    diagnose: async () => ({ component: 'x', cause: 'c', checks: ['ck'] }),
    classify: async () => ({ category: '', brand: '', model: '', docType: 'user', pageKinds: [] }),
    answer: async (_question, _evidence, _mode, context) => { cfg.rec.context = context; return cfg.answerText; },
  });

  it('A: a scope question answers from the workspace inventory, never touching retrieval', async () => {
    // A1 (the sharpened plan prompt) keeps the scope/content split upstream;
    // the loop trusts a scope label and answers from the deterministic
    // inventory - no similarity retrieval, no manual page.
    setWorkflowProfile('insurance');
    const rec: Rec = { retrieveCount: 0 };
    const d = stub({ intent: 'scope', retrieve: () => { throw new Error('scope must not retrieve'); }, answerText: 'This workspace indexes one auto policy.', rec });
    const c = { ...insConv(), device: 'what can you help with' };
    const { step } = await drain(runStep({ conversation: c, docs: [covDoc], userInput: 'what can you help with' }, d));
    expect(step.confidenceReason).toBe('answered from the workspace index itself');
    expect(step.confidence).toBeCloseTo(0.95, 5);
    expect(step.citations.length).toBe(0);
    expect(rec.retrieveCount).toBe(0);
  });

  it('B: a follow-up carries the prior exchange into plan AND answer', async () => {
    setWorkflowProfile('insurance');
    const rec: Rec = { retrieveCount: 0 };
    const d = stub({ intent: 'question', retrieve: () => [{ page: covPage, score: 3 }], answerText: 'Yes, still covered (p.20).', rec });
    const { step } = await drain(runStep({ conversation: insConv([priorAnswer]), docs: [covDoc], userInput: "t'es sûr ?" }, d));
    expect(rec.history?.length).toBe(1);
    expect(rec.history?.[0].answer).toMatch(/covered/i);
    expect(rec.history?.[0].question).toBe('does the insurance cover a lost car key'); // original question resolved, not the button
    expect(rec.context?.length, 'answer() must receive the conversation context').toBe(1);
    expect(step.answer).toMatch(/covered/i);
  });

  it('C: an explicit page reference answers directly from that page, bypassing retrieval', async () => {
    setWorkflowProfile('insurance');
    const rec: Rec = { retrieveCount: 0 };
    const d = stub({
      intent: 'question',
      retrieve: () => { throw new Error('retrieval must not run for an explicit page reference'); },
      answerText: 'Page 20 confirms a lost key is covered up to 500.', rec,
    });
    const { events, step } = await drain(runStep({ conversation: insConv([priorAnswer]), docs: [covDoc], userInput: 'sur la page 20 on dirait si' }, d));
    expect(events.some((e) => /Opening the page/.test(e.summary)), 'the page open must be narrated').toBe(true);
    expect(rec.retrieveCount, 'no similarity retrieval when the user named the page').toBe(0);
    expect(step.citations.map((c) => c.page)).toContain(20);
    expect(rec.context?.length).toBe(1);
  });

  it('C: an error code like P0301 is never mistaken for a page number', async () => {
    setWorkflowProfile('repair');
    const rec: Rec = { retrieveCount: 0 };
    const d = stub({ intent: 'diagnose', retrieve: () => [{ page: covPage, score: 3 }], answerText: 'x', rec });
    const c = { ...insConv(), device: 'car', symptom: 'code P0301 flashing' };
    const { events } = await drain(runStep({ conversation: c, docs: [covDoc], userInput: 'the P0301 code is back' }, d));
    expect(events.some((e) => /Opening the page/.test(e.summary))).toBe(false);
  });
});
