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
    // distinct-source corroboration: one doc, two page kinds = one corroboration
    expect(step.confidence).toBeCloseTo(0.8, 5);
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

describe('runStep - measurement pivot (tool changes the outcome)', () => {
  it('flips the hypothesis to thermistor on an in-spec heater reading', async () => {
    const c = conv();
    c.steps.push({ index: 0 } as GuidedStep);
    const { events, step } = await drain(runStep({ conversation: c, docs: [heroDoc], userInput: 'report-measurement:heating element:22' }, drv));
    expect(events.some((e) => e.phase === 'tools' && e.summary.match(/within spec/i))).toBe(true);
    expect(step.instruction).toMatch(/thermistor/i);
    expect(step.proposedNext.some((p) => p.action.includes('WPW10352973') || p.label.match(/thermistor/i))).toBe(true);
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
