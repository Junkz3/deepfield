import { describe, expect, it } from 'vitest';
import { checkMeasurement, checkSafety, getPart } from './tools';

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
