import { afterEach, describe, expect, it } from 'vitest';
import { FakeDriver } from './driver';
import { runStep } from './loop';
import { heuristicCalibration, heuristicTeam, parseOps, parseTeam, parseTeamCalibration, presetTeam } from './team';
import { TOOL_REGISTRY } from './tools';
import type { Conversation, Document } from './types';
import { setWorkflowProfile, setWorkflowTeam, workflowProfile } from './workflow';

afterEach(() => {
  setWorkflowTeam([]);
  setWorkflowProfile('repair');
});

describe('presetTeam', () => {
  it('ships insurance as a real two-agent team with distinct ids and hints', () => {
    const team = presetTeam('insurance');
    expect(team).toHaveLength(2);
    expect(new Set(team.map((a) => a.id)).size).toBe(2);
    expect(team.every((a) => a.active)).toBe(true);
    expect(team[0].profile.retrievalHint).not.toBe(team[1].profile.retrievalHint);
  });

  it('ships repair and unknown presets as solo teams', () => {
    expect(presetTeam('repair')).toHaveLength(1);
    expect(presetTeam('whatever')[0].profile.id).toBe('generic');
  });
});

describe('heuristicTeam', () => {
  it('weighs the intent sentence above neutral file names', () => {
    const team = heuristicTeam({
      workspaceName: 'Acme',
      fileNames: ['doc-a.pdf', 'doc-b.pdf'],
      intent: 'our support desk answers policyholder coverage questions and handles claims',
    });
    expect(team.map((a) => a.id)).toContain('claims-analyst');
  });

  it('falls back to a generic solo agent when nothing matches', () => {
    const team = heuristicTeam({ workspaceName: 'X', fileNames: ['notes.txt'] });
    expect(team).toHaveLength(1);
    expect(team[0].profile.id).toBe('generic');
  });
});

describe('parseTeam', () => {
  const agent = (id: string, extra: Record<string, unknown> = {}) => ({
    id, label: `Agent ${id}`, charter: 'handles x', agentRole: 'an analyst',
    subjectNoun: 'document', issueNoun: 'question', retrievalHint: 'tables first',
    decisionMode: 'answer', physicalTools: false, classifyHint: 'category = type',
    ...extra,
  });

  it('parses a valid team and marks every agent active', () => {
    const team = parseTeam(JSON.stringify({ team: [agent('a'), agent('b')] }));
    expect(team).toHaveLength(2);
    expect(team!.every((a) => a.active)).toBe(true);
    expect(team![0].profile.agentRole).toBe('an analyst');
  });

  it('drops invalid agents, duplicates, and caps the team at 3', () => {
    const team = parseTeam(JSON.stringify({
      team: [agent('a'), agent('a'), agent('bad', { decisionMode: 'guess' }), agent('c'), agent('d'), agent('e')],
    }));
    // slice(0,3) first: a, a(dup), bad(invalid) -> only "a" survives
    expect(team!.map((a) => a.id)).toEqual(['a']);
  });

  it('returns null on prose, bad JSON, or an empty team', () => {
    expect(parseTeam('no json here')).toBeNull();
    expect(parseTeam('{"team": []}')).toBeNull();
    expect(parseTeam('{"team": [{"id": "x"}]}')).toBeNull();
  });
});

describe('parseOps (model-written workspace operations)', () => {
  const lookup = { id: 'coolant-spec', label: 'Coolant spec lookup', kind: 'lookup', query: 'coolant capacity table', cue: 'with args.system when fluids matter' };
  const capture = { id: 'pressure', label: 'Pressure capture', kind: 'capture', cue: 'with args.point when a reading would decide' };

  it('parses valid lookup and capture ops', () => {
    const ops = parseOps(JSON.stringify({ ops: [lookup, capture] }));
    expect(ops.map((o) => o.id)).toEqual(['coolant-spec', 'pressure']);
    expect(ops[0].query).toBe('coolant capacity table');
    expect(ops[1].query).toBeUndefined();
  });

  it('drops unknown kinds, lookups without a query, duplicates, and caps at 3', () => {
    const ops = parseOps(JSON.stringify({
      ops: [
        { ...lookup, kind: 'execute' },
        { ...lookup, query: undefined },
        capture, capture,
        { ...lookup, id: 'extra-1' }, { ...lookup, id: 'extra-2' },
      ],
    }));
    // slice(0,3) first: execute(bad), no-query(bad), capture -> one survivor
    expect(ops.map((o) => o.id)).toEqual(['pressure']);
  });

  it('returns [] on prose or a missing ops field', () => {
    expect(parseOps('no json')).toEqual([]);
    expect(parseOps('{"team": []}')).toEqual([]);
  });

  it('parseTeamCalibration drops ops when no agent diagnoses (no consumer)', () => {
    const text = JSON.stringify({
      team: [{
        id: 'advisor', label: 'Advisor', charter: 'coverage questions', agentRole: 'an advisor',
        subjectNoun: 'policy', issueNoun: 'question', retrievalHint: 'coverage tables first',
        decisionMode: 'answer', physicalTools: false, classifyHint: 'category = policy type',
      }],
      ops: [lookup],
    });
    expect(parseTeamCalibration(text)!.ops).toEqual([]);
  });

  it('parseTeamCalibration materializes ops into runnable tools', () => {
    const text = JSON.stringify({
      team: [{
        id: 'tech', label: 'Technician', charter: 'field diagnostics', agentRole: 'a technician',
        subjectNoun: 'machine', issueNoun: 'fault', retrievalHint: 'procedures first',
        decisionMode: 'diagnosis', physicalTools: true, classifyHint: 'category = machine type',
      }],
      ops: [lookup],
    });
    const c = parseTeamCalibration(text);
    expect(c!.team[0].id).toBe('tech');
    expect(c!.ops[0].id).toBe('coolant-spec');
    expect(typeof c!.ops[0].run).toBe('function');
  });
});

describe('heuristicCalibration', () => {
  it('ships the hand-written registry for the repair vertical only', () => {
    const repair = heuristicCalibration({ workspaceName: 'Shop', fileNames: ['service-manual.pdf'] });
    expect(repair.ops).toBe(TOOL_REGISTRY);
    const insurance = heuristicCalibration({ workspaceName: 'Desk', fileNames: ['policy-wording.pdf'] });
    expect(insurance.team.map((a) => a.id)).toContain('claims-analyst');
    expect(insurance.ops).toEqual([]);
  });
});

describe('runStep routing', () => {
  const doc: Document = {
    id: 'manual', filename: 'manual.pdf', format: 'pdf', category: 'dishwasher',
    brand: 'Whirlpool', model: 'W11', docType: 'service', sourceRights: 'test', origin: 'corpus',
    pages: [
      { docId: 'manual', page: 12, imageUrl: '', kind: 'error-table', text: 'E3 heating fault table' },
      { docId: 'manual', page: 13, imageUrl: '', kind: 'schematic', text: 'wiring diagram heater circuit' },
    ],
  };

  const run = async (symptom: string) => {
    const conversation: Conversation = {
      id: 't', device: 'Whirlpool dishwasher', symptom,
      attachments: [], steps: [], userInputs: [], status: 'active',
    };
    const gen = runStep({ conversation, docs: [doc] }, new FakeDriver({ delayScale: 0 }));
    while (true) {
      const n = await gen.next();
      if (n.done) return n.value;
    }
  };

  it('routes to the agent whose charter matches the request and applies its profile', async () => {
    setWorkflowTeam([
      { id: 'billing', label: 'Billing agent', charter: 'invoices refunds pricing subscription', active: true, profile: { ...workflowProfile(), id: 'billing' } },
      { id: 'field-tech', label: 'Field technician', charter: 'error codes heating faults diagnostics', active: true, profile: { ...workflowProfile(), id: 'field-tech' } },
    ]);
    const step = await run('error code E3, heating fault');
    expect(step.agentLabel).toBe('Field technician');
    expect(workflowProfile().id).toBe('field-tech');
    expect(step.phaseEvents.some((e) => e.summary === 'Routed to Field technician')).toBe(true);
  });

  it('ignores disabled agents and skips the routing event with a solo team', async () => {
    setWorkflowTeam([
      { id: 'billing', label: 'Billing agent', charter: 'invoices refunds', active: false, profile: { ...workflowProfile(), id: 'billing' } },
      { id: 'field-tech', label: 'Field technician', charter: 'error codes diagnostics', active: true, profile: { ...workflowProfile(), id: 'field-tech' } },
    ]);
    const step = await run('refund my invoice please');
    // billing is toggled off: even a billing-flavored request stays with the tech
    expect(step.agentLabel).toBe('Field technician');
    expect(step.phaseEvents.some((e) => e.summary.startsWith('Routed to'))).toBe(false);
  });

  it('leaves steps unlabeled when no team is set (legacy workspaces)', async () => {
    const step = await run('error code E3');
    expect(step.agentLabel).toBeUndefined();
  });
});
