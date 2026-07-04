// User-driven universe filter, folded into a single compact pill: the closed
// state shows the active category (or "Filter"), clicking unfolds the list.
// The chosen category feeds the same scopeIds channel the agent uses, so the
// out-of-filter files ghost exactly like out-of-scope files do.
import { useMemo, useState } from 'react';
import type { Document } from '../../agent/types';
import { catColor } from '../cat-colors';

export function CategoryFilter({ docs, value, onChange }: {
  docs: Document[];
  value: string | null;
  onChange: (cat: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // Same order as the 3D category anchors: alphabetical over unique labels.
  const categories = useMemo(() => [...new Set(docs.map((d) => d.category))].sort(), [docs]);
  if (categories.length < 2) return null;
  const pick = (cat: string | null) => { onChange(cat); setOpen(false); };

  return (
    <div className="galaxy-filter">
      <button
        className={`chip galaxy-filter-chip ${value !== null ? 'active' : ''}`}
        style={value !== null ? { borderColor: catColor(value), color: catColor(value) } : undefined}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Filter files by category"
      >
        {value !== null && <span className="dot" style={{ background: catColor(value) }} />}
        {value ?? 'Filter'}
        <span className="galaxy-filter-caret mono">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="galaxy-filter-menu fade-up" role="menu">
          <button className={`chip galaxy-filter-chip ${value === null ? 'active' : ''}`} role="menuitem" onClick={() => pick(null)}>
            All categories
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              className={`chip galaxy-filter-chip ${value === cat ? 'active' : ''}`}
              style={value === cat ? { borderColor: catColor(cat), color: catColor(cat) } : undefined}
              role="menuitem"
              onClick={() => pick(value === cat ? null : cat)}
            >
              <span className="dot" style={{ background: catColor(cat) }} />
              {cat}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
