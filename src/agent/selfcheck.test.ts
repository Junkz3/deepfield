import { describe, expect, it } from 'vitest';
import { pickFactPages, scoreProbe } from './selfcheck';
import type { Document } from './types';

const doc = (id: string, pages: { page: number; text?: string; kind?: string }[]): Document => ({
  id, filename: `${id}.pdf`, format: 'pdf', category: 'policy', brand: 'X', model: 'Y', docType: 'user',
  sourceRights: 'test', origin: 'session',
  pages: pages.map((p) => ({ docId: id, page: p.page, imageUrl: '', kind: (p.kind ?? 'other') as any, text: p.text })),
});

const FACTS = 'The deductible is $129 per claim. Coverage lasts 24 months and pays 80% of costs up to $5,000 in total per year of coverage. The service fee is $29 for screen damage and $99 for other accidental damage under the same plan terms.';
const PROSE = 'This section explains in general terms how the plan works and who administers it for you across all regions and situations of everyday life, without going into any of the specific figures that appear elsewhere in this document.';

describe('pickFactPages', () => {
  it('prefers fact-dense pages and never covers or TOC pages', () => {
    const d = doc('a', [
      { page: 1, text: FACTS },            // cover: excluded even if dense
      { page: 2, text: FACTS },            // TOC zone: excluded
      { page: 7, text: PROSE },
      { page: 9, text: FACTS },
    ]);
    const picked = pickFactPages([d], 1);
    expect(picked).toHaveLength(1);
    expect(picked[0].page).toBe(9);
  });

  it('spreads across documents before going deep', () => {
    const a = doc('a', [{ page: 5, text: FACTS }, { page: 6, text: FACTS }]);
    const b = doc('b', [{ page: 8, text: FACTS }]);
    const picked = pickFactPages([a, b], 2);
    expect(new Set(picked.map((p) => p.docId))).toEqual(new Set(['a', 'b']));
  });

  it('skips pages with no usable text', () => {
    const d = doc('a', [{ page: 5 }, { page: 6, text: 'short' }]);
    expect(pickFactPages([d], 3)).toHaveLength(0);
  });
});

describe('scoreProbe', () => {
  const probe = { question: 'q', mustContain: ['$129', '24 months'] };
  const cite = (docId: string, page: number) => ({ docId, page, label: '' });

  it('passes when a literal value is quoted and the source page is cited', () => {
    const v = scoreProbe('La franchise est de $129 (p.3).', [cite('a', 3)], probe, { docId: 'a', page: 3 });
    expect(v).toEqual({ factFound: true, pageCited: true, passed: true });
  });

  it('tolerates a one-page drift in the citation', () => {
    const v = scoreProbe('couvert 24 months', [cite('a', 4)], probe, { docId: 'a', page: 3 });
    expect(v.passed).toBe(true);
  });

  it('fails without the literal fact, even if the page is cited', () => {
    const v = scoreProbe('Vous etes couvert, voir la police.', [cite('a', 3)], probe, { docId: 'a', page: 3 });
    expect(v).toEqual({ factFound: false, pageCited: true, passed: false });
  });

  it('fails when the fact comes without the source page', () => {
    const v = scoreProbe('$129 de franchise', [cite('b', 9)], probe, { docId: 'a', page: 3 });
    expect(v).toEqual({ factFound: true, pageCited: false, passed: false });
  });
});
