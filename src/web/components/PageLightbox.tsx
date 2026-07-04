// Global document viewer: click any file in the universe to actually read it.
// Pages navigate with arrows / thumbnail strip; cited regions stay framed;
// video documents play in the official embedded player at the cited second.
import { useEffect } from 'react';
import { useApp } from '../store';

export function PageLightbox() {
  const { state, dispatch, docs } = useApp();
  const lb = state.lightbox;

  const doc = lb ? docs.find((d) => d.id === lb.docId) : undefined;
  const idx = doc ? Math.max(0, doc.pages.findIndex((p) => p.page === lb!.page)) : 0;

  useEffect(() => {
    if (!lb || !doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'close-lightbox' });
      if (e.key === 'ArrowRight' && idx < doc.pages.length - 1) {
        dispatch({ type: 'open-lightbox', docId: doc.id, page: doc.pages[idx + 1].page });
      }
      if (e.key === 'ArrowLeft' && idx > 0) {
        dispatch({ type: 'open-lightbox', docId: doc.id, page: doc.pages[idx - 1].page });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lb, doc, idx, dispatch]);

  if (!lb || !doc) return null;
  const page = doc.pages[idx];
  if (!page) return null;

  const isVideo = !!page.videoUrl && page.timestamp !== undefined;
  const videoId = isVideo ? new URL(page.videoUrl!).searchParams.get('v') ?? '' : '';
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="cite-lightbox" onClick={() => dispatch({ type: 'close-lightbox' })}>
      <div className="lightbox-meta mono">
        {doc.brand} {doc.model} — {isVideo ? `segment @ ${mmss(page.timestamp!)}: "${page.text}"` : `p.${page.page} (${page.kind})`} · {doc.sourceRights}
      </div>

      {isVideo ? (
        <div className="video-frame" onClick={(e) => e.stopPropagation()}>
          <iframe
            key={page.page}
            src={`https://www.youtube.com/embed/${videoId}?start=${page.timestamp}&autoplay=1`}
            title={`${doc.model} @ ${mmss(page.timestamp!)}`}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
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
      )}

      {/* Page navigator: thumbnails for documents, chapter list for videos */}
      <div className="lightbox-nav" onClick={(e) => e.stopPropagation()}>
        {doc.pages.map((p, i) =>
          p.timestamp !== undefined ? (
            <button
              key={p.page}
              className={`lightbox-chapter mono ${i === idx ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'open-lightbox', docId: doc.id, page: p.page })}
            >
              {mmss(p.timestamp)} {p.text}
            </button>
          ) : (
            <button
              key={p.page}
              className={`lightbox-thumb ${i === idx ? 'active' : ''}`}
              title={`p.${p.page} (${p.kind})`}
              onClick={() => dispatch({ type: 'open-lightbox', docId: doc.id, page: p.page })}
            >
              <img src={p.imageUrl} alt={`p.${p.page}`} loading="lazy" />
              <span className="mono">{p.page}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
