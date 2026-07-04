import { describe, expect, it } from 'vitest';
import { calibrationPrompt, heuristicProfile, parseProfile } from './calibrate';

describe('heuristicProfile', () => {
  it('maps insurance-flavored filenames to the insurance profile', () => {
    const p = heuristicProfile({ workspaceName: 'AssurCheck', fileNames: ['police-auto-2024.pdf', 'garantie-habitation.pdf'] });
    expect(p.id).toBe('insurance');
  });

  it('maps legal-flavored filenames to the legal profile', () => {
    const p = heuristicProfile({ workspaceName: 'Discovery', fileNames: ['jugement-ca-paris.pdf', 'nda-fournisseur.pdf'] });
    expect(p.id).toBe('legal');
  });

  it('maps manuals to the repair profile', () => {
    const p = heuristicProfile({ workspaceName: 'Atelier', fileNames: ['service-manual-lg.pdf'] });
    expect(p.id).toBe('repair');
  });

  it('falls back to generic when nothing matches', () => {
    const p = heuristicProfile({ workspaceName: 'Divers', fileNames: ['notes.txt'] });
    expect(p.id).toBe('generic');
  });

  it('reads the workspace name too, not only files', () => {
    const p = heuristicProfile({ workspaceName: 'Warranty Claims', fileNames: [] });
    expect(p.id).toBe('insurance');
  });
});

describe('parseProfile', () => {
  const VALID = {
    id: 'insurance-claims', agentRole: 'a warranty claims analyst', subjectNoun: 'claim',
    issueNoun: 'question', retrievalHint: 'coverage tables first', decisionMode: 'answer',
    physicalTools: false, classifyHint: 'category = document type',
  };

  it('accepts a valid profile embedded in prose', () => {
    const p = parseProfile(`Here is the profile:\n${JSON.stringify(VALID)}\nDone.`);
    expect(p?.agentRole).toBe('a warranty claims analyst');
    expect(p?.decisionMode).toBe('answer');
  });

  it('rejects an invalid decisionMode', () => {
    expect(parseProfile(JSON.stringify({ ...VALID, decisionMode: 'vibes' }))).toBeNull();
  });

  it('rejects missing text fields', () => {
    expect(parseProfile(JSON.stringify({ ...VALID, agentRole: '' }))).toBeNull();
  });

  it('rejects garbage', () => {
    expect(parseProfile('no json here')).toBeNull();
  });
});

describe('calibrationPrompt', () => {
  it('carries the corpus signal and demands strict JSON', () => {
    const prompt = calibrationPrompt({ workspaceName: 'AssurCheck', fileNames: ['police-auto.pdf'] });
    expect(prompt).toContain('AssurCheck');
    expect(prompt).toContain('police-auto.pdf');
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toMatch(/decisionMode/);
  });
});
