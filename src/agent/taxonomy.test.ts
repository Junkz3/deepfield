import { describe, expect, it } from 'vitest';
import { buildTaxonomy, candidatePages, layoutGalaxy, mergeDocs } from './taxonomy';
import type { Document } from './types';

const doc = (id: string, category: string, brand: string, model: string, pages = 2): Document => ({
  id, filename: `${id}.pdf`, format: 'pdf', category, brand, model, docType: 'service',
  sourceRights: 'test', origin: 'corpus',
  pages: Array.from({ length: pages }, (_, i) => ({ docId: id, page: i + 1, imageUrl: `/x/p${i + 1}.png`, kind: 'other' as const })),
});

const CORPUS = [
  doc('whirlpool-dw', 'dishwasher', 'Whirlpool', 'WDT730', 3),
  doc('lg-dw', 'dishwasher', 'LG', 'LDF9322'),
  doc('hmmwv', 'vehicle', 'AM General', 'M1151'),
];

describe('buildTaxonomy', () => {
  it('builds category -> brand -> model -> document -> page with stable ids', () => {
    const root = buildTaxonomy(CORPUS);
    const cats = root.children.map((c) => c.id).sort();
    expect(cats).toEqual(['cat:dishwasher', 'cat:vehicle']);
    const dw = root.children.find((c) => c.id === 'cat:dishwasher')!;
    expect(dw.children.map((b) => b.id).sort()).toEqual(['brand:dishwasher/LG', 'brand:dishwasher/Whirlpool']);
    const whirl = dw.children.find((b) => b.id === 'brand:dishwasher/Whirlpool')!;
    const model = whirl.children[0];
    expect(model.id).toBe('model:dishwasher/Whirlpool/WDT730');
    expect(model.children[0].id).toBe('doc:whirlpool-dw');
    expect(model.children[0].children).toHaveLength(3);
  });
});

describe('mergeDocs', () => {
  it('is idempotent by id', () => {
    const session = [doc('whirlpool-dw', 'dishwasher', 'Whirlpool', 'WDT730')];
    expect(mergeDocs(CORPUS, session)).toHaveLength(3);
    expect(mergeDocs(CORPUS, [doc('new', 'coffee', 'Keurig', 'K-Duo')])).toHaveLength(4);
  });
});

describe('candidatePages', () => {
  it('scopes to the BEST-matching docs, not every token hit', () => {
    const pages = candidatePages(CORPUS, 'Whirlpool dishwasher');
    expect(new Set(pages.map((p) => p.docId))).toEqual(new Set(['whirlpool-dw']));
  });
  it('a generic query keeps every doc of the tied category', () => {
    const pages = candidatePages(CORPUS, 'dishwasher');
    expect(new Set(pages.map((p) => p.docId))).toEqual(new Set(['whirlpool-dw', 'lg-dw']));
  });
  it('a shared noun does not pull in another appliance', () => {
    const corpus = [...CORPUS, doc('brother-sew', 'sewing machine', 'Brother', 'XM2701'), doc('lg-wash', 'washing machine', 'LG', 'WM3400')];
    const pages = candidatePages(corpus, 'Brother XM2701 sewing machine');
    expect(new Set(pages.map((p) => p.docId))).toEqual(new Set(['brother-sew']));
  });
  it('never returns a silently empty scope', () => {
    expect(candidatePages(CORPUS, 'zzz unknown').length).toBe(7);
  });
});

describe('layoutGalaxy', () => {
  it('is deterministic and keeps every node inside [-1,1]', () => {
    const a = layoutGalaxy(buildTaxonomy(CORPUS));
    const b = layoutGalaxy(buildTaxonomy(CORPUS));
    expect(a).toEqual(b);
    for (const n of a.nodes) {
      expect(Math.abs(n.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(n.y)).toBeLessThanOrEqual(1);
    }
    expect(a.nodes.some((n) => n.type === 'page')).toBe(true);
    expect(a.edges.some((e) => e.from.startsWith('cat:'))).toBe(true);
  });
});

describe('scopeDocIds (contextual recursion)', () => {
  it('scopes to matching docs and shares truth with candidatePages', async () => {
    const { scopeDocIds } = await import('./taxonomy');
    const ids = scopeDocIds(CORPUS, 'Whirlpool dishwasher');
    expect(ids).toEqual(new Set(['whirlpool-dw']));
    expect(scopeDocIds(CORPUS, 'zzz unknown').size).toBe(3);
  });
});
