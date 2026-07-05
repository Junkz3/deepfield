import { describe, expect, it } from 'vitest';
import { FakeDriver } from './driver';
import type { ModelDriver } from './driver';
import { runStep } from './loop';
import { E3_PAGES, HERO_DOC_ID } from './fixtures/e3-case';
import type { Conversation, Document, GuidedStep, Page, PhaseEvent } from './types';

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
