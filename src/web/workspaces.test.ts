import { describe, expect, it } from 'vitest';
import type { Conversation, Document } from '../agent/types';
import { presetTeam } from '../agent/team';
import { initialState, reducer } from './store';

const doc = { id: 'd1', pages: [] } as unknown as Document;
const conv = { id: 'c1' } as unknown as Conversation;

describe('multi-workspace snapshots', () => {
  it('add-workspace parks the active one and starts clean in the new one', () => {
    const booted = { ...initialState, booted: true, corpusDocs: [doc], conversations: [conv] };
    const added = reducer(booted, {
      type: 'add-workspace', id: 'ws-2', name: 'Jefferson Insurance',
      corpus: [], team: presetTeam('insurance'), ops: [],
    });
    expect(added.activeWorkspaceId).toBe('ws-2');
    expect(added.workspaceName).toBe('Jefferson Insurance');
    expect(added.conversations).toEqual([]);
    expect(added.studioOpen).toBe(false);
    expect(added.workspaces.map((w) => w.id)).toEqual(['default']);
    expect(added.workspaces[0].corpusDocs).toHaveLength(1);
    expect(added.workspaces[0].conversations).toHaveLength(1);
  });

  it('switch-workspace swaps flat state against the parked snapshot, both intact', () => {
    const booted = { ...initialState, booted: true, corpusDocs: [doc], conversations: [conv] };
    const added = reducer(booted, {
      type: 'add-workspace', id: 'ws-2', name: 'Jefferson Insurance',
      corpus: [], team: presetTeam('insurance'), ops: [],
    });
    const back = reducer(added, { type: 'switch-workspace', id: 'default' });
    expect(back.activeWorkspaceId).toBe('default');
    expect(back.workspaceName).toBe('RepairCenter');
    expect(back.corpusDocs).toHaveLength(1);
    expect(back.conversations.map((c) => c.id)).toEqual(['c1']);
    expect(back.workspaces.map((w) => w.id)).toEqual(['ws-2']);
    expect(back.workspaces[0].team.map((a) => a.id)).toContain('coverage-advisor');
    // Unknown target is a no-op, never a crash.
    expect(reducer(back, { type: 'switch-workspace', id: 'nope' })).toBe(back);
  });
});
