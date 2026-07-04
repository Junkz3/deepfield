import { describe, expect, it } from 'vitest';
import { splitSeedFiles } from './studio';
import type { Document } from '../agent/types';

const doc = (id: string): Document => ({
  id, filename: `${id}.pdf`, format: 'pdf', category: 'dishwasher', brand: 'Whirlpool',
  model: 'W11187658', docType: 'service', sourceRights: 'test', origin: 'corpus',
  pages: [{ docId: id, page: 1, imageUrl: `/x/p1.png`, kind: 'other' as const }],
});

const SEED = [doc('whirlpool-w11187658'), doc('stihl-ms250-instruction-manual')];

describe('splitSeedFiles', () => {
  it('resolves a dropped file to its pre-indexed seed document by filename', () => {
    const { matched, unmatched } = splitSeedFiles([{ name: 'whirlpool-w11187658.pdf' }], SEED);
    expect(matched.map((d) => d.id)).toEqual(['whirlpool-w11187658']);
    expect(unmatched).toEqual([]);
  });

  it('matches filenames case-insensitively', () => {
    const { matched, unmatched } = splitSeedFiles([{ name: 'Whirlpool-W11187658.PDF' }], SEED);
    expect(matched.map((d) => d.id)).toEqual(['whirlpool-w11187658']);
    expect(unmatched).toEqual([]);
  });

  it('keeps unknown files in the live-ingest queue', () => {
    const files = [{ name: 'contrat-bail-2024.pdf' }];
    const { matched, unmatched } = splitSeedFiles(files, SEED);
    expect(matched).toEqual([]);
    expect(unmatched).toEqual(files);
  });

  it('resolves each seed document once even if dropped twice', () => {
    const { matched, unmatched } = splitSeedFiles(
      [{ name: 'stihl-ms250-instruction-manual.pdf' }, { name: 'STIHL-MS250-INSTRUCTION-MANUAL.pdf' }],
      SEED,
    );
    expect(matched.map((d) => d.id)).toEqual(['stihl-ms250-instruction-manual']);
    expect(unmatched).toEqual([]);
  });
});
