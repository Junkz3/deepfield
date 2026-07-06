import { afterEach, describe, expect, it } from 'vitest';
import { VultrDriver } from './client';
import type { Transport } from './client';
import { FREEFORM_SYMPTOM } from '../agent/types';
import { setWorkflowProfile, setWorkflowTeam } from '../agent/workflow';

// A transport that answers every /chat/completions with a canned model reply.
const fakeChat = (content: string): Transport => async () => ({ choices: [{ message: { content } }] });

describe('VultrDriver.plan - query sanitization', () => {
  afterEach(() => { setWorkflowProfile('repair'); setWorkflowTeam([]); });

  it('strips an echoed "retrieval query:" label the model sometimes prepends', async () => {
    setWorkflowProfile('insurance');
    const d = new VultrDriver(fakeChat('{"goal":"g","queries":["retrieval query: lost car key coverage"],"intent":"question"}'));
    const p = await d.plan({ device: 'does the insurance cover a lost car key', symptom: FREEFORM_SYMPTOM, hasPhoto: false });
    expect(p.queries[0]).toBe('lost car key coverage');
    expect(p.intent).toBe('question');
  });

  it('also strips bare "query:" / "search query:" prefixes', async () => {
    const d = new VultrDriver(fakeChat('{"goal":"g","queries":["Query: heating element resistance"]}'));
    expect((await d.plan({ device: 'x', symptom: 'y', hasPhoto: false })).queries[0]).toBe('heating element resistance');
    const d2 = new VultrDriver(fakeChat('{"goal":"g","queries":["search query: fuser jam"]}'));
    expect((await d2.plan({ device: 'x', symptom: 'y', hasPhoto: false })).queries[0]).toBe('fuser jam');
  });

  it('leaves a clean query untouched and never returns an empty query list', async () => {
    const d = new VultrDriver(fakeChat('{"goal":"g","queries":["windscreen replacement coverage"]}'));
    expect((await d.plan({ device: 'x', symptom: 'y', hasPhoto: false })).queries[0]).toBe('windscreen replacement coverage');
    // Unparseable reply -> deterministic fallback query, never empty.
    const d2 = new VultrDriver(fakeChat('not json at all'));
    expect((await d2.plan({ device: 'dev', symptom: 'sym', hasPhoto: false })).queries.length).toBeGreaterThan(0);
  });

  it('does not eat a query that merely starts with the word "search"', async () => {
    const d = new VultrDriver(fakeChat('{"goal":"g","queries":["search coil continuity test"]}'));
    expect((await d.plan({ device: 'x', symptom: 'y', hasPhoto: false })).queries[0]).toBe('search coil continuity test');
  });
});
