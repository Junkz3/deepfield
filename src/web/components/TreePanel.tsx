// Recursive taxonomy tree: the legible mirror of the galaxy.
import { useMemo, useState } from 'react';
import { buildTaxonomy } from '../../agent/taxonomy';
import type { TaxonomyNode } from '../../agent/types';
import { categoryColor, useApp } from '../store';

function Node({ node, depth }: { node: TaxonomyNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === 'page') return null; // pages stay galaxy-only; the tree shows structure
  const pageCount = node.type === 'document' ? node.children.length : 0;
  const color = node.type === 'category' ? categoryColor(node.label) : undefined;
  const hasChildren = node.children.some((c) => c.type !== 'page');
  return (
    <div className="tree-node" style={{ paddingLeft: depth * 14 }}>
      <button className="tree-row" onClick={() => setOpen(!open)}>
        <span className="tree-caret mono">{hasChildren ? (open ? '−' : '+') : '·'}</span>
        {color && <span className="tree-swatch" style={{ background: color }} />}
        <span className={`tree-label ${node.type}`}>{node.label}</span>
        {node.type === 'document' && <span className="tree-count mono">{pageCount}p</span>}
        {node.origin === 'session' && <span className="tree-session mono">session</span>}
      </button>
      {open && node.children.map((c) => <Node key={c.id} node={c} depth={depth + 1} />)}
    </div>
  );
}

export function TreePanel() {
  const { docs } = useApp();
  const root = useMemo(() => buildTaxonomy(docs), [docs]);
  return (
    <div className="tree-panel panel">
      <div className="tree-head mono">KNOWLEDGE TREE</div>
      {root.children.map((c) => (
        <Node key={c.id} node={c} depth={0} />
      ))}
    </div>
  );
}
