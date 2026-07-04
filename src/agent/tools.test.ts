import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from './types';
import {
  activeTools, checkMeasurement, checkSafety, getPart, installWorkspaceOps,
  opFromSpec, opsPromptSection, setWorkspaceTools, TOOL_REGISTRY, workspaceOps,
} from './tools';

describe('getPart', () => {
  it('returns a known part with stock info', async () => {
    const p = await getPart('W10518394');
    expect(p).toMatchObject({ ref: 'W10518394', name: 'Heating element', inStock: true });
  });
  it('returns a graceful unknown for missing refs', async () => {
    const p = await getPart('NOPE');
    expect(p.inStock).toBe(false);
    expect(p.name).toMatch(/unknown/i);
  });
});

describe('checkSafety', () => {
  it('returns cited safety lines', async () => {
    const s = await checkSafety('replace heating element');
    expect(s.lines.length).toBeGreaterThan(0);
    expect(s.citations[0].label).toBeTruthy();
  });
  it('uses vehicle safety set for vehicle operations', async () => {
    const s = await checkSafety('vehicle: test TCM harness');
    expect(s.lines[0]).toMatch(/battery/i);
  });
});

describe('checkMeasurement (the hypothesis-flip tool)', () => {
  it('in-spec heater reading flips suspicion to the thermistor', async () => {
    const v = await checkMeasurement('heating element', 22);
    expect(v.withinSpec).toBe(true);
    expect(v.suggestedComponent).toBe('thermistor');
    expect(v.verdict).toMatch(/within spec/i);
  });
  it('out-of-spec heater reading confirms the heater', async () => {
    const v = await checkMeasurement('heating element', 0);
    expect(v.withinSpec).toBe(false);
    expect(v.suggestedComponent).toBeUndefined();
  });
  it('unknown component says so honestly', async () => {
    const v = await checkMeasurement('flux capacitor', 42);
    expect(v.verdict).toMatch(/no spec/i);
  });
});

describe('workspace tool registry (the model requests, the loop executes)', () => {
  afterEach(() => setWorkspaceTools(TOOL_REGISTRY.map((t) => t.id)));

  it('exposes the full registry by default and honors the workspace curation', () => {
    expect(activeTools().map((t) => t.id)).toEqual(['part_lookup', 'safety_notes', 'measurement_check']);
    setWorkspaceTools(['part_lookup']);
    expect(activeTools().map((t) => t.id)).toEqual(['part_lookup']);
    setWorkspaceTools([]);
    expect(activeTools()).toEqual([]);
  });

  it('part_lookup resolves a known component to a catalog part', async () => {
    const tool = TOOL_REGISTRY.find((t) => t.id === 'part_lookup')!;
    const run = await tool.run({ component: 'heating element' }, { device: 'Whirlpool dishwasher', component: 'heater' });
    expect(run.part?.ref).toBe('W10518394');
    expect(run.summary).toMatch(/in stock/i);
  });

  it('part_lookup falls back to an honest OEM line off-catalog', async () => {
    const tool = TOOL_REGISTRY.find((t) => t.id === 'part_lookup')!;
    const run = await tool.run({ component: 'fuel solenoid' }, { device: 'generator', component: 'fuel solenoid' });
    expect(run.part?.ref).toBe('OEM');
    expect(run.part?.inStock).toBe(false);
  });

  it('safety_notes picks the vehicle set from the device context', async () => {
    const tool = TOOL_REGISTRY.find((t) => t.id === 'safety_notes')!;
    const run = await tool.run({ operation: 'test TCM harness' }, { device: 'HMMWV M1151', component: 'sensor' });
    expect(run.safety?.lines[0]).toMatch(/battery/i);
  });
});

const page = (n: number, text: string, title?: string): Page =>
  ({ docId: 'doc', page: n, imageUrl: `p${n}.png`, text, title, kind: 'other' });

describe('calibrated ops (two generic behaviors cover every vertical)', () => {
  afterEach(() => installWorkspaceOps(TOOL_REGISTRY));

  it('the verdict prompt op offer is byte-identical to the shipped sentence', () => {
    // The repair prompt is lace: it took four measured iterations to settle.
    // Locking the exact sentence guarantees generalizing ops moved nothing.
    expect(opsPromptSection(TOOL_REGISTRY)).toBe(
      ' After the diagnosis fields are set, request follow-up workspace operations in "tools" when they apply: '
      + '{"id":"part_lookup","args":{...}}, {"id":"safety_notes","args":{...}}, {"id":"measurement_check","args":{...}} '
      + '(part_lookup with args.component when one replaceable component is the prime suspect; '
      + 'safety_notes with args.operation before hands-on work; '
      + 'measurement_check with args.component when a reading would decide). '
      + 'Never let tool choice alter the diagnosis fields.',
    );
    expect(opsPromptSection([])).toBe('');
  });

  it('a lookup op searches the workspace pages and hands back the hits', async () => {
    const op = opFromSpec({
      id: 'torque-spec-lookup', label: 'Torque spec lookup', kind: 'lookup',
      cue: 'with args.fastener when tightening torque matters', query: 'torque specification chart',
    });
    const run = await op.run({ fastener: 'head bolt' }, {
      device: 'engine', component: 'head',
      pages: [
        page(3, 'lubrication intervals and oil grades'),
        page(9, 'torque specification chart: head bolt 85 Nm', 'Torque chart'),
        page(11, 'wiring diagram overview'),
      ],
    });
    expect(run.pages?.map((p) => p.page)).toEqual([9]);
    expect(run.summary).toMatch(/Torque chart p\.9/);
  });

  it('a lookup op says so honestly when nothing matches', async () => {
    const op = opFromSpec({ id: 'x', label: 'X', kind: 'lookup', cue: 'with args.a when b', query: 'zzz qqq' });
    const run = await op.run({}, { device: 'd', component: 'c', pages: [page(1, 'unrelated prose')] });
    expect(run.pages).toEqual([]);
    expect(run.summary).toMatch(/no matching page/i);
  });

  it('a capture op narrates the awaited real-world value', async () => {
    const op = opFromSpec({ id: 'reading', label: 'Reading', kind: 'capture', cue: 'with args.point when unsure' });
    const run = await op.run({ point: 'line pressure' }, { device: 'd', component: 'pump' });
    expect(run.summary).toMatch(/line pressure/);
  });

  it('installWorkspaceOps replaces the registry and activates everything', () => {
    const op = opFromSpec({ id: 'only-op', label: 'Only', kind: 'lookup', cue: 'with args.q when asked', query: 'q' });
    installWorkspaceOps([op]);
    expect(workspaceOps().map((t) => t.id)).toEqual(['only-op']);
    expect(activeTools().map((t) => t.id)).toEqual(['only-op']);
    setWorkspaceTools([]);
    expect(activeTools()).toEqual([]);
  });
});
