import type { Document, Page, TaxonomyNode } from './types';

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
  const matches = docs.filter((d) =>
    tokens.some((t) => [d.category, d.brand, d.model].some((f) => f.toLowerCase().includes(t))),
  );
  const scope = matches.length > 0 ? matches : docs;
  return new Set(scope.map((d) => d.id));
}

export function candidatePages(docs: Document[], deviceQuery: string): Page[] {
  const ids = scopeDocIds(docs, deviceQuery);
  return docs.filter((d) => ids.has(d.id)).flatMap((d) => d.pages);
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
