import type { Diagnosis, Page, PlanAction } from '../types';

export const HERO_DOC_ID = 'whirlpool-w11187658';

export const E3_PAGES: Record<'errorTable' | 'wiring' | 'troubleshooting', Page> = {
  // Region verified against the rendered p18.png (120 DPI, 1020x1320): the E3 table row.
  errorTable: { docId: HERO_DOC_ID, page: 18, imageUrl: `/corpus/${HERO_DOC_ID}/p18.png`, kind: 'error-table', region: { x: 0.06, y: 0.62, w: 0.85, h: 0.066 }, text: 'E3 HEATER FAILURE - temperature does not reach value after 90 min. Check heater, thermistor, control.' },
  wiring: { docId: HERO_DOC_ID, page: 25, imageUrl: `/corpus/${HERO_DOC_ID}/p25.png`, kind: 'schematic', region: { x: 0.15, y: 0.2, w: 0.7, h: 0.5 } },
  troubleshooting: { docId: HERO_DOC_ID, page: 19, imageUrl: `/corpus/${HERO_DOC_ID}/p19.png`, kind: 'troubleshooting' },
};

export const E3_PLAN: PlanAction = {
  goal: 'Identify why the dishwasher reports E3 and does not heat',
  queries: ['dishwasher error code E3 does not heat'],
};

export const E3_SUFFICIENCY = {
  sufficient: false,
  reason: 'The error table points at the heater circuit, but I need the wiring diagram to locate the heater and thermistor connectors.',
  followupQuery: 'dishwasher heater circuit wiring diagram',
};

export const E3_DIAGNOSIS: Diagnosis = {
  component: 'Heating element (heater circuit)',
  cause: 'E3 = heater failure: water temperature did not reach target within 90 minutes.',
  checks: [
    'Measure heating element resistance (spec 15-30 ohms)',
    'Measure thermistor resistance if heater is in spec',
    'Inspect heater relay and control board connector',
  ],
  instruction: 'E3 points at the heating circuit: unplug the machine, then measure the heating element resistance - the manual expects 15-30 ohms.',
  componentKey: 'heater',
};

export const E3_FLIPPED_DIAGNOSIS: Diagnosis = {
  component: 'Thermistor / OWI sensor',
  cause: 'Heater measures within spec; the thermistor reporting water temperature is now the prime suspect.',
  checks: ['Measure thermistor resistance (spec 48-55 kilo-ohms at 25 C)', 'Check thermistor connector continuity to control'],
  instruction: 'Since the heater checks out, move to the thermistor: it should read 48-55 kilo-ohms at room temperature.',
  componentKey: 'thermistor',
};
