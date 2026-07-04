// Global page zoom: the proof view. Shows the real manual page with the
// verified cited region framed; opened from the universe or citation chips.
import { useEffect } from 'react';
import { useApp } from '../store';

export function PageLightbox() {
  const { state, dispatch, docs } = useApp();
  const lb = state.lightbox;

  useEffect(() => {
    if (!lb) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dispatch({ type: 'close-lightbox' });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lb, dispatch]);

  if (!lb) return null;
  const doc = docs.find((d) => d.id === lb.docId);
  const page = doc?.pages.find((p) => p.page === lb.page);
  if (!doc || !page) return null;

  return (
    <div className="cite-lightbox" onClick={() => dispatch({ type: 'close-lightbox' })}>
      <div className="lightbox-meta mono">
        {doc.brand} {doc.model} — p.{page.page} ({page.kind}) · {doc.sourceRights}
      </div>
      <span className="cite-img-wrap zoomed" onClick={(e) => e.stopPropagation()}>
        <img src={page.imageUrl} alt={`${doc.model} page ${page.page}`} />
        {page.region && (
          <span
            className="cite-region strong"
            style={{
              left: `${page.region.x * 100}%`,
              top: `${page.region.y * 100}%`,
              width: `${page.region.w * 100}%`,
              height: `${page.region.h * 100}%`,
            }}
          />
        )}
      </span>
    </div>
  );
}
