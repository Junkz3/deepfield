// Cited evidence viewer: the page image with the cited region drawn on it.
// Verified regions get a precise box; absent regions degrade to an intentional
// whole-page highlight. Click opens a zoom lightbox.
import { useEffect, useState } from 'react';
import type { Citation, Document } from '../../agent/types';

function docLabel(docs: Document[], docId: string): string {
  const d = docs.find((x) => x.id === docId);
  return d ? `${d.brand} ${d.model}` : docId;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function CitationPanel({ citations, docs }: { citations: Citation[]; docs: Document[] }) {
  const [sel, setSel] = useState(0);
  const [zoom, setZoom] = useState(false);
  const cite = citations[Math.min(sel, citations.length - 1)];

  useEffect(() => setSel(0), [citations]);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  if (!cite) {
    return (
      <div className="cite-panel empty">
        <div className="cite-empty">
          <span className="cite-empty-ring" />
          Retrieved pages appear here, with the cited region highlighted.
        </div>
      </div>
    );
  }

  const doc = docs.find((d) => d.id === cite.docId);
  const page = doc?.pages.find((p) => p.page === cite.page);
  const imageUrl = page?.imageUrl ?? '';

  return (
    <div className="cite-panel">
      <div className="cite-tabs">
        {citations.map((c, i) => (
          <button key={i} className={`cite-tab ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)}>
            <span className="mono">p.{c.page}</span>
            {c.timestamp !== undefined && <span className="mono"> @{fmtTime(c.timestamp)}</span>}
          </button>
        ))}
      </div>

      <div className="cite-meta">
        <span className="cite-doc">{docLabel(docs, cite.docId)}</span>
        <span className="cite-kind mono">{cite.label.replace(cite.docId, '').trim()}</span>
      </div>

      <button className={`cite-view ${cite.region ? '' : 'whole-page'}`} onClick={() => setZoom(true)} title="Click to zoom">
        {imageUrl ? (
          <span className="cite-img-wrap">
            <img src={imageUrl} alt={`Cited page ${cite.page}`} />
            {cite.region ? (
              <span
                className="cite-region"
                style={{
                  left: `${cite.region.x * 100}%`,
                  top: `${cite.region.y * 100}%`,
                  width: `${cite.region.w * 100}%`,
                  height: `${cite.region.h * 100}%`,
                }}
              />
            ) : (
              <span className="cite-whole-label mono">cited page</span>
            )}
          </span>
        ) : (
          <span className="cite-missing">Page image not available</span>
        )}
      </button>

      {cite.quote && <blockquote className="cite-quote">"{cite.quote}"</blockquote>}

      {zoom && imageUrl && (
        <div className="cite-lightbox" onClick={() => setZoom(false)}>
          <span className="cite-img-wrap zoomed" onClick={(e) => e.stopPropagation()}>
            <img src={imageUrl} alt={`Cited page ${cite.page} zoomed`} />
            {cite.region && (
              <span
                className="cite-region strong"
                style={{
                  left: `${cite.region.x * 100}%`,
                  top: `${cite.region.y * 100}%`,
                  width: `${cite.region.w * 100}%`,
                  height: `${cite.region.h * 100}%`,
                }}
              />
            )}
          </span>
        </div>
      )}
    </div>
  );
}
