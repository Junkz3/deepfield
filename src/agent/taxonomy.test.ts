import { describe, expect, it } from 'vitest';
import { buildTaxonomy, candidatePages, layoutGalaxy, mergeDocs, trimPool } from './taxonomy';
import type { Document, Page } from './types';

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

describe('trimPool', () => {
  const page = (n: number, text: string | undefined, kind: Page['kind'] = 'other'): Page =>
    ({ docId: 'd', page: n, imageUrl: '', kind, text });
  const FILLER = 'general information about the appliance and its everyday use, nothing specific here at all';

  it('returns the pool untouched when it fits the cap', () => {
    const pool = [page(1, FILLER), page(2, 'heating element resistance 22 ohms')];
    expect(trimPool('heating element', pool, 40)).toBe(pool);
  });

  it('keeps the token-matching pages and drops filler when over the cap', () => {
    const pool = [
      ...Array.from({ length: 50 }, (_, i) => page(i + 1, FILLER)),
      page(60, 'error code E3: heating element or thermistor fault, resistance table'),
    ];
    const out = trimPool('E3 heating element', pool, 8);
    expect(out.length).toBe(8);
    expect(out.some((p) => p.page === 60)).toBe(true);
  });

  it('always lets pages without a text layer through (scans are the visual rerank job)', () => {
    const pool = [
      ...Array.from({ length: 50 }, (_, i) => page(i + 1, FILLER)),
      page(90, undefined),
      page(91, undefined),
    ];
    const out = trimPool('anything specific', pool, 8);
    expect(out.filter((p) => p.text === undefined).map((p) => p.page)).toEqual([90, 91]);
  });

  it('boosts high-value kinds so an error table survives even without a token hit', () => {
    const pool = [
      ...Array.from({ length: 50 }, (_, i) => page(i + 1, FILLER)),
      page(70, `${FILLER} fault listing`, 'error-table'),
    ];
    const out = trimPool('symptom words absent from every page', pool, 8);
    expect(out.some((p) => p.page === 70)).toBe(true);
  });
});

describe('categoryScope (user filter)', () => {
  it('returns exactly the docs of the requested category', async () => {
    const { categoryScope } = await import('./taxonomy');
    expect(categoryScope(CORPUS, 'dishwasher')).toEqual(new Set(['whirlpool-dw', 'lg-dw']));
  });
  it('returns an empty set for an unknown category', async () => {
    const { categoryScope } = await import('./taxonomy');
    expect(categoryScope(CORPUS, 'washing machine').size).toBe(0);
  });
  it('handles an empty corpus', async () => {
    const { categoryScope } = await import('./taxonomy');
    expect(categoryScope([], 'dishwasher').size).toBe(0);
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

describe('scopeSummary (the workspace knows itself)', () => {
  it('inventories categories, brands, models and page counts', () => {
    const docs = [
      { id: 'a', category: 'dishwasher', brand: 'Whirlpool', model: 'W11', docType: 'service', pages: [{}, {}] },
      { id: 'b', category: 'chainsaw', brand: 'Stihl', model: 'MS 250', docType: 'user', pages: [{}] },
      { id: 'c', category: 'dishwasher', brand: 'Bosch', model: 'SMS', docType: 'user', pages: [{}] },
    ] as unknown as Parameters<typeof scopeSummary>[0];
    const s = scopeSummary(docs);
    expect(s).toMatch(/3 document\(s\) across 2 device categories \(4 pages total\)/);
    expect(s).toMatch(/dishwasher: Whirlpool W11 \(service manual, 2 pages\); Bosch SMS/);
    expect(s).toMatch(/chainsaw: Stihl MS 250/);
  });
});
