// Global document viewer: click any file in the universe to actually read it.
// Pages navigate with arrows / thumbnail strip; cited regions stay framed;
// video documents play in the official embedded player at the cited second.
// The Translate action makes Nemotron read the page IMAGE and render it in
// the technician's language - works on scans, tables and diagrams alike.
import { useEffect, useState } from 'react';
import { LANG_NAMES, useApp } from '../store';
import { translateLines, translatePage } from '../translate';

export function PageLightbox() {
  const { state, dispatch, docs } = useApp();
  const lb = state.lightbox;
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [chapterLines, setChapterLines] = useState<string[] | null>(null);

  const doc = lb ? docs.find((d) => d.id === lb.docId) : undefined;
  const idx = doc ? Math.max(0, doc.pages.findIndex((p) => p.page === lb!.page)) : 0;

  // Reset the translation pane when the page changes.
  useEffect(() => { setTranslation(null); setTranslating(false); }, [lb?.docId, lb?.page]);
  useEffect(() => { setChapterLines(null); }, [lb?.docId]);

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

  const runTranslate = async () => {
    if (translating) return;
    setTranslating(true);
    try {
      if (isVideo) {
        const lines = doc.pages.map((p) => p.text ?? '');
        setChapterLines(await translateLines(doc.id, lines, state.lang, state.driverKind));
      } else {
        setTranslation(await translatePage(doc.id, page.page, page.imageUrl, state.lang, state.driverKind));
      }
    } catch (e) {
      setTranslation(`Translation failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="cite-lightbox" onClick={() => dispatch({ type: 'close-lightbox' })}>
      <div className="lightbox-meta mono">
        {doc.brand} {doc.model} — {isVideo ? `segment @ ${mmss(page.timestamp!)}: "${page.text}"` : `p.${page.page} (${page.kind})`} · {doc.sourceRights}
      </div>

      <button
        className={`btn lightbox-translate ${translating ? 'busy' : ''}`}
        onClick={(e) => { e.stopPropagation(); void runTranslate(); }}
        title={`Translate to ${LANG_NAMES[state.lang]} (language selector in the sidebar)`}
      >
        {translating ? 'Reading the page…' : `Translate to ${state.lang.toUpperCase()}`}
      </button>

      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {isVideo ? (
          <div className="video-frame">
            <iframe
              key={page.page}
              src={`https://www.youtube.com/embed/${videoId}?start=${page.timestamp}&autoplay=1`}
              title={`${doc.model} @ ${mmss(page.timestamp!)}`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : (
          <span className="cite-img-wrap zoomed">
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

        {translation && !isVideo && (
          <aside className="translate-pane fade-up">
            <div className="translate-head mono">
              {LANG_NAMES[state.lang].toUpperCase()} · NEMOTRON READ
              <button onClick={() => setTranslation(null)} title="Close translation">×</button>
            </div>
            <div className="translate-body">{translation}</div>
          </aside>
        )}
      </div>

      {/* Page navigator: thumbnails for documents, chapter list for videos */}
      <div className="lightbox-nav" onClick={(e) => e.stopPropagation()}>
        {doc.pages.map((p, i) =>
          p.timestamp !== undefined ? (
            <button
              key={p.page}
              className={`lightbox-chapter mono ${i === idx ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'open-lightbox', docId: doc.id, page: p.page })}
            >
              {mmss(p.timestamp)} {chapterLines?.[i] ?? p.text}
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
