import { describe, expect, it } from 'vitest';
import { initialState, reducer } from './store';
import type { AppState } from './store';
import type { Document } from '../agent/types';

const doc = (id: string): Document => ({
  id, filename: `${id}.pdf`, format: 'pdf', category: 'dishwasher', brand: 'Whirlpool',
  model: 'W11187658', docType: 'service', sourceRights: 'test', origin: 'corpus',
  pages: [{ docId: id, page: 1, imageUrl: `/x/p1.png`, kind: 'other' as const }],
});

const DOCS = [doc('whirlpool-w11187658'), doc('stihl-ms250-instruction-manual')];

describe('boot (default mode, non-regression)', () => {
  it('boots immediately with the corpus docs', () => {
    const s = reducer(initialState, { type: 'boot', docs: DOCS });
    expect(s.booted).toBe(true);
    expect(s.corpusDocs).toEqual(DOCS);
  });
});

describe('boot (studio mode: deferred)', () => {
  const studio: AppState = { ...initialState, studioMode: true };

  it('holds the docs in pendingDocs without booting', () => {
    const s = reducer(studio, { type: 'boot', docs: DOCS });
    expect(s.booted).toBe(false);
    expect(s.corpusDocs).toEqual([]);
    expect(s.pendingDocs).toEqual(DOCS);
  });

  it('create-workspace boots on the resolved corpus and names the workspace', () => {
    const held = reducer(studio, { type: 'boot', docs: DOCS });
    const s = reducer(held, { type: 'create-workspace', name: 'RepairCenter', corpus: held.pendingDocs });
    expect(s.booted).toBe(true);
    expect(s.studioMode).toBe(false);
    expect(s.corpusDocs).toEqual(DOCS);
    expect(s.pendingDocs).toEqual([]);
    expect(s.workspaceName).toBe('RepairCenter');
  });

  it('create-workspace with an empty corpus boots on an empty universe', () => {
    const held = reducer(studio, { type: 'boot', docs: DOCS });
    const s = reducer(held, { type: 'create-workspace', name: 'LegalDiscovery', corpus: [] });
    expect(s.booted).toBe(true);
    expect(s.corpusDocs).toEqual([]);
    expect(s.workspaceName).toBe('LegalDiscovery');
  });

  it('falls back to RepairCenter when the name is blank', () => {
    const s = reducer({ ...initialState, studioMode: true }, { type: 'create-workspace', name: '   ', corpus: [] });
    expect(s.workspaceName).toBe('RepairCenter');
  });

  it('ignores a late boot arriving after create-workspace', () => {
    const created = reducer({ ...initialState, studioMode: true }, { type: 'create-workspace', name: 'Empty', corpus: [] });
    const s = reducer(created, { type: 'boot', docs: DOCS });
    expect(s.corpusDocs).toEqual([]);
  });

  it('studio-preview shows the selected corpus in the universe without booting', () => {
    const held = reducer(studio, { type: 'boot', docs: DOCS });
    const s = reducer(held, { type: 'studio-preview', corpus: DOCS });
    expect(s.corpusDocs).toEqual(DOCS);
    expect(s.booted).toBe(false);
    const cleared = reducer(s, { type: 'studio-preview', corpus: [] });
    expect(cleared.corpusDocs).toEqual([]);
  });

  it('studio-preview is ignored outside studio mode', () => {
    const booted = reducer(initialState, { type: 'boot', docs: DOCS });
    const s = reducer(booted, { type: 'studio-preview', corpus: [] });
    expect(s.corpusDocs).toEqual(DOCS);
  });
});
