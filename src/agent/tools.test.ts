import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from './types';
import {
  activeTools, installWorkspaceOps, opFromSpec, opsPromptSection,
  setWorkspaceTools, TOOL_REGISTRY, workspaceOps,
} from './tools';

const page = (n: number, text: string, title?: string): Page =>
  ({ docId: 'doc', page: n, imageUrl: `p${n}.png`, text, title, kind: 'other' });

describe('workspace tool registry (the model requests, the loop executes)', () => {
  afterEach(() => installWorkspaceOps(TOOL_REGISTRY));

  it('exposes the repair preset by default and honors the workspace curation', () => {
    expect(activeTools().map((t) => t.id)).toEqual(['part_lookup', 'safety_notes', 'measurement_check']);
    setWorkspaceTools(['part_lookup']);
    expect(activeTools().map((t) => t.id)).toEqual(['part_lookup']);
    setWorkspaceTools([]);
    expect(activeTools()).toEqual([]);
  });

  it('the preset ops are the generic runners - nothing simulated', async () => {
    // part_lookup searches the real corpus pages for parts material; with no
    // matching page it says so instead of inventing stock or references.
    const partLookup = TOOL_REGISTRY.find((t) => t.id === 'part_lookup')!;
    expect(partLookup.kind).toBe('lookup');
    const found = await partLookup.run({ component: 'heating element' }, {
      device: 'Whirlpool dishwasher', component: 'heater',
      pages: [page(4, 'wash cycle overview'), page(58, 'replacement parts list: heating element W10518394', 'Parts list')],
    });
    expect(found.pages?.map((p) => p.page)).toEqual([58]);
    expect(found.summary).toMatch(/Parts list p\.58/);
    const nothing = await partLookup.run({ component: 'flux capacitor' }, { device: 'x', component: 'y', pages: [] });
    expect(nothing.summary).toMatch(/no matching page/i);
    expect(TOOL_REGISTRY.find((t) => t.id === 'measurement_check')!.kind).toBe('capture');
  });
});

describe('calibrated ops (two generic behaviors cover every vertical)', () => {
  afterEach(() => installWorkspaceOps(TOOL_REGISTRY));

  it('the verdict prompt op offer is byte-identical to the tuned sentence', () => {
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
