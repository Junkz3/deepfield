import { describe, expect, it } from 'vitest';
import { FakeDriver } from './driver';
import { runStep } from './loop';
import { E3_PAGES, HERO_DOC_ID } from './fixtures/e3-case';
import type { Conversation, Document, GuidedStep, PhaseEvent } from './types';

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
