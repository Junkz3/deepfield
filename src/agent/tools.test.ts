import { afterEach, describe, expect, it } from 'vitest';
import { activeTools, checkMeasurement, checkSafety, getPart, setWorkspaceTools, TOOL_REGISTRY } from './tools';

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
