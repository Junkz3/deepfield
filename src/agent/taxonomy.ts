import type { Document, Page, PageKind, TaxonomyNode } from './types';

/** Human-readable purpose of a page, shown before the user opens it. */
export const KIND_TITLES: Record<PageKind, string> = {
  'error-table': 'Error-code table',
  'schematic': 'Wiring diagram',
  'troubleshooting': 'Troubleshooting guide',
  'procedure': 'Repair procedure',
  'parts': 'Parts list',
  'safety': 'Safety notices',
  'coverage-table': 'Coverage table',
  'video-segment': 'Video segment',
  'other': 'Manual page',
};

export function pageTitle(p: Page): string {
  return p.title ?? (p.kind === 'video-segment' && p.text ? p.text : KIND_TITLES[p.kind]);
}

export interface GalaxyNode { id: string; type: TaxonomyNode['type']; label: string; x: number; y: number; r: number; parentId?: string; docId?: string; page?: number; categoryIndex: number }
export interface GalaxyLayout { nodes: GalaxyNode[]; edges: { from: string; to: string }[] }

export function buildTaxonomy(docs: Document[]): TaxonomyNode {
  const root: TaxonomyNode = { id: 'root', label: 'Repair Center', type: 'category', children: [], origin: 'corpus' };
  const ensure = (parent: TaxonomyNode, id: string, label: string, type: TaxonomyNode['type'], origin: TaxonomyNode['origin']) => {
    let n = parent.children.find((c) => c.id === id);
    if (!n) { n = { id, label, type, children: [], origin }; parent.children.push(n); parent.children.sort((a, b) => a.id.localeCompare(b.id)); }
    return n;
  };
  for (const d of docs) {
    const cat = ensure(root, `cat:${d.category}`, d.category, 'category', d.origin);
    const brand = ensure(cat, `brand:${d.category}/${d.brand}`, d.brand, 'brand', d.origin);
    const model = ensure(brand, `model:${d.category}/${d.brand}/${d.model}`, d.model, 'model', d.origin);
    const docNode = ensure(model, `doc:${d.id}`, d.filename, 'document', d.origin);
    docNode.docId = d.id;
    for (const p of d.pages) {
      const pn = ensure(docNode, `page:${d.id}/${p.page}`, `p.${p.page}`, 'page', d.origin);
      pn.docId = d.id;
    }
  }
  return root;
}

export function mergeDocs(corpus: Document[], session: Document[]): Document[] {
  const byId = new Map(corpus.map((d) => [d.id, d]));
  for (const d of session) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()];
}

/** Which documents a device query scopes to — the single source of truth the
 *  agent loop AND the universe rendering share (contextual recursion). */
export function scopeDocIds(docs: Document[], deviceQuery: string): Set<string> {
  const tokens = deviceQuery.toLowerCase().split(/\s+/).filter(Boolean);
  // Score = matched token count, keep only the best-matching docs. A binary
  // OR let "sewing machine" pull the washing-machine manual in via "machine".
  let best = 0;
  const scored = docs.map((d) => {
    const hay = [d.category, d.brand, d.model].map((f) => f.toLowerCase());
    const score = tokens.filter((t) => hay.some((f) => f.includes(t))).length;
    if (score > best) best = score;
    return { d, score };
  });
  const scope = best > 0 ? scored.filter((s) => s.score === best).map((s) => s.d) : docs;
  return new Set(scope.map((d) => d.id));
}

export function candidatePages(docs: Document[], deviceQuery: string): Page[] {
  const ids = scopeDocIds(docs, deviceQuery);
  return docs.filter((d) => ids.has(d.id)).flatMap((d) => d.pages);
}

/** Cheap text-side prefilter before the visual rerank. The reranker reads
 *  page IMAGES (~900 tokens each), so a 90-page pool costs 20-40s per round;
 *  token overlap plus kind boosts keep the pool tight with zero extra calls.
 *  Pages without a usable text layer (scans, photos) always pass: they are
 *  exactly what the VISUAL rerank exists for. */
export function trimPool(query: string, pages: Page[], cap = 40): Page[] {
  if (pages.length <= cap) return pages;
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2))];
  const KIND_BOOST: Partial<Record<PageKind, number>> = {
    'error-table': 2, troubleshooting: 2, 'coverage-table': 2, procedure: 1, schematic: 1, 'video-segment': 1,
  };
  const untexted = pages.filter((p) => (p.text ?? '').trim().length < 40);
  const texted = pages.filter((p) => (p.text ?? '').trim().length >= 40);
  if (texted.length <= cap) return pages;
  const scored = texted.map((p, i) => {
    const hay = `${p.title ?? ''} ${p.text}`.toLowerCase();
    return { p, i, s: tokens.filter((t) => hay.includes(t)).length * 2 + (KIND_BOOST[p.kind] ?? 0) };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return [...untexted, ...scored.slice(0, cap).map((x) => x.p)];
}

export function layoutGalaxy(root: TaxonomyNode): GalaxyLayout {
  const nodes: GalaxyNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const cats = root.children;
  cats.forEach((cat, ci) => {
    // Elliptical ring (wide screens), rotated 30deg so no constellation sits at
    // the exact bottom where the command card floats.
    const catAngle = (ci / Math.max(cats.length, 1)) * Math.PI * 2 - Math.PI / 2 + Math.PI / 6;
    const cx = Math.cos(catAngle) * 0.62, cy = Math.sin(catAngle) * 0.40;
    nodes.push({ id: cat.id, type: 'category', label: cat.label, x: cx, y: cy, r: 0.055, categoryIndex: ci });
    edges.push({ from: cat.id, to: 'root' });
    const docNodes = cat.children.flatMap((b) => b.children.flatMap((m) => m.children.filter((n) => n.type === 'document')));
    docNodes.forEach((doc, di) => {
      const a = (di / Math.max(docNodes.length, 1)) * Math.PI * 2 + ci; // ci offsets orbits per constellation
      const dx = cx + Math.cos(a) * 0.15, dy = cy + Math.sin(a) * 0.15;
      nodes.push({ id: doc.id, type: 'document', label: doc.label, x: dx, y: dy, r: 0.03, parentId: cat.id, docId: doc.docId, categoryIndex: ci });
      edges.push({ from: doc.id, to: cat.id });
      doc.children.forEach((pg, pi) => {
        const pa = (pi / Math.max(doc.children.length, 1)) * Math.PI * 2;
        nodes.push({
          id: pg.id, type: 'page', label: pg.label,
          x: dx + Math.cos(pa) * 0.05, y: dy + Math.sin(pa) * 0.05, r: 0.008,
          parentId: doc.id, docId: pg.docId, page: Number(pg.id.split('/').pop()), categoryIndex: ci,
        });
        edges.push({ from: pg.id, to: doc.id });
      });
    });
  });
  return { nodes, edges };
}
