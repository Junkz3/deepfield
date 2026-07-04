import { describe, expect, it } from 'vitest';
import { FakeDriver } from './driver';
import { E3_PAGES } from './fixtures/e3-case';

const drv = new FakeDriver({ delayScale: 0 });
const q = { device: 'Whirlpool dishwasher', symptom: 'error code E3, does not heat' };
const candidates = Object.values(E3_PAGES);

describe('FakeDriver E3 script', () => {
  it('plans a retrieval-driven goal', async () => {
    const p = await drv.plan({ ...q, hasPhoto: false });
    expect(p.queries[0]).toMatch(/E3/i);
  });
  it('retrieves the error table first for the E3 query', async () => {
    const r = await drv.retrieve('dishwasher error code E3 does not heat', candidates);
    expect(r[0].page.page).toBe(18);
    expect(r[0].score).toBeGreaterThan(r[1].score);
  });
  it('declares evidence insufficient and asks for the wiring diagram', async () => {
    const r = await drv.retrieve('dishwasher error code E3 does not heat', candidates);
    const s = await drv.assessSufficiency(q, r.slice(0, 1));
    expect(s.sufficient).toBe(false);
    expect(s.followupQuery).toMatch(/wiring/i);
  });
  it('retrieves the schematic for the wiring query', async () => {
    const r = await drv.retrieve('dishwasher heater circuit wiring diagram', candidates);
    expect(r[0].page.page).toBe(25);
  });
  it('diagnoses the heater circuit from evidence', async () => {
    const d = await drv.diagnose(q, [E3_PAGES.errorTable, E3_PAGES.wiring]);
    expect(d.component).toMatch(/heating element/i);
  });
  it('flips to thermistor when the user reports an in-spec heater measurement', async () => {
    const p = await drv.plan({ ...q, hasPhoto: false, userInput: 'report-measurement:heating element:22' });
    expect(p.goal).toMatch(/thermistor/i);
  });
  it('classify returns dishwasher metadata for a whirlpool filename', async () => {
    const m = await drv.classify({ filename: 'whirlpool-service.pdf', pageImages: [], pageTexts: [] });
    expect(m.category).toBe('dishwasher');
  });
});
