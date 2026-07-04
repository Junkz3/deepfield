// Global document viewer: click any file in the universe to actually read it.
// Pages navigate with arrows / thumbnail strip; cited regions stay framed;
// video documents play in the official embedded player at the cited second.
// The Translate action makes Nemotron read the page IMAGE and render it in
// the technician's language - works on scans, tables and diagrams alike.
import { useEffect, useRef, useState } from 'react';
import { langName, useApp } from '../store';
import { translateLines, translatePage, translateTextLayer } from '../translate';
import type { TextBlock } from '../../agent/types';

interface PatchStyle { bg: string; fg: string }

/** Sample the page background around each block so patches melt into the
 *  design: only the words change, not the look. */
function samplePatchStyles(img: HTMLImageElement, blocks: TextBlock[]): PatchStyle[] {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d');
  if (!g) return blocks.map(() => ({ bg: 'rgba(252,252,250,0.97)', fg: '#17202b' }));
  g.drawImage(img, 0, 0);
  const W = canvas.width, H = canvas.height;
  return blocks.map((b) => {
    const pts: [number, number][] = [];
    const x0 = b.x * W, y0 = b.y * H, w = b.w * W, h = b.h * H;
    for (let i = 0; i < 6; i++) {
      pts.push([x0 + (w * i) / 5, Math.max(0, y0 - 4)]);          // just above
      pts.push([x0 + (w * i) / 5, Math.min(H - 1, y0 + h + 4)]);  // just below
    }
    let r = 0, gr = 0, bl = 0, n = 0;
    for (const [px, py] of pts) {
      try {
        const d = g.getImageData(Math.round(px), Math.round(py), 1, 1).data;
        r += d[0]; gr += d[1]; bl += d[2]; n++;
      } catch { /* ignore */ }
    }
    if (n === 0) return { bg: 'rgba(252,252,250,0.97)', fg: '#17202b' };
    r = Math.round(r / n); gr = Math.round(gr / n); bl = Math.round(bl / n);
    const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * bl;
    return { bg: `rgb(${r}, ${gr}, ${bl})`, fg: lum > 140 ? '#17202b' : '#f2f5f8' };
  });
}

export function PageLightbox() {
  const { state, dispatch, docs } = useApp();
  const lb = state.lightbox;
  // With a conversation open, the page docks into the universe half so the
  // chat stays usable: click another citation and this viewer just swaps.
  const docked = state.activeView.kind === 'conversation';
  const [translation, setTranslation] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [showTranslated, setShowTranslated] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [chapterLines, setChapterLines] = useState<string[] | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgH, setImgH] = useState(600);
  const [patchStyles, setPatchStyles] = useState<PatchStyle[]>([]);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Unified mouse + touch gestures: one pointer pans, two pinch-zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { mode: 'pan'; x: number; y: number; tx: number; ty: number }
    | { mode: 'pinch'; dist: number; mx: number; my: number }
    | null
  >(null);
  const tapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);

  // Re-anchor the gesture whenever the finger count changes: two = pinch,
  // one on a zoomed page = pan (also the hand-off when a pinch finger lifts).
  const syncGesture = () => {
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      gesture.current = { mode: 'pinch', dist: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else if (pts.length === 1 && zoomRef.current.scale > 1) {
      gesture.current = { mode: 'pan', x: pts[0].x, y: pts[0].y, tx: zoomRef.current.tx, ty: zoomRef.current.ty };
    } else {
      gesture.current = null;
    }
  };

  const zoomToggleAt = (clientX: number, clientY: number, el: HTMLElement) => {
    if (zoomRef.current.scale > 1) { setZoom({ scale: 1, tx: 0, ty: 0 }); return; }
    const r = el.getBoundingClientRect();
    const cx = clientX - (r.left + r.width / 2);
    const cy = clientY - (r.top + r.height / 2);
    setZoom({ scale: 2.2, tx: cx - 2.2 * cx, ty: cy - 2.2 * cy });
  };

  const doc = lb ? docs.find((d) => d.id === lb.docId) : undefined;
  const idx = doc ? Math.max(0, doc.pages.findIndex((p) => p.page === lb!.page)) : 0;

  // Reset the translation state when the page changes.
  useEffect(() => { setTranslation(null); setBlocks(null); setTranslating(false); }, [lb?.docId, lb?.page]);
  useEffect(() => { setZoom({ scale: 1, tx: 0, ty: 0 }); }, [lb?.docId, lb?.page]);

  // Wheel zoom needs a non-passive native listener (React's root wheel is passive).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
        const scale = Math.min(4.5, Math.max(1, z.scale * factor));
        if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
        // keep the point under the cursor fixed while zooming
        const r = el.getBoundingClientRect();
        const cx = e.clientX - (r.left + r.width / 2);
        const cy = e.clientY - (r.top + r.height / 2);
        const k = scale / z.scale;
        return { scale, tx: cx - k * (cx - z.tx), ty: cy - k * (cy - z.ty) };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [lb?.docId, lb?.page]);
  useEffect(() => { setChapterLines(null); }, [lb?.docId]);

  useEffect(() => {
    if (!lb || !doc) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
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
      } else if (
        page.textBlocks &&
        page.textBlocks.length > 0 &&
        // degenerate layouts (dense TOCs, giant merged tables) read better in the pane
        !page.textBlocks.some((b) => b.h > 0.35 || b.text.length >= 480)
      ) {
        // Pixel-true in-place translation: layout comes from the PDF text
        // layer (extracted at ingest); only the words change language.
        const translated = await translateLines(
          `${doc.id}/${page.page}/blocks`,
          page.textBlocks.map((b) => b.text),
          state.lang,
          state.driverKind,
        );
        setBlocks(page.textBlocks.map((b, i) => ({ ...b, text: translated[i] ?? b.text })));
        if (imgRef.current?.complete) setPatchStyles(samplePatchStyles(imgRef.current, page.textBlocks));
        setShowTranslated(true);
      } else if (page.textBlocks && page.textBlocks.length > 0) {
        // Dense layout, but a text layer exists: reliable text-only pane via Kimi.
        setTranslation(await translateTextLayer(doc.id, page.page, page.textBlocks, state.lang, state.driverKind));
      } else {
        // True scans only: Nemotron reads the image (retry allowed, failures not cached).
        setTranslation(await translatePage(doc.id, page.page, page.imageUrl, state.lang, state.driverKind));
      }
    } catch (e) {
      setTranslation(`Translation failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className={`cite-lightbox ${docked ? 'docked' : ''}`} onClick={() => dispatch({ type: 'close-lightbox' })}>
      <div className="lightbox-meta mono">
        {doc.brand} {doc.model} — {isVideo ? `segment @ ${mmss(page.timestamp!)}: "${page.text}"` : `p.${page.page} (${page.kind})`} · {doc.sourceRights}
      </div>

      <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
        {blocks && (
          <button className="btn" onClick={() => setShowTranslated(!showTranslated)}>
            {showTranslated ? 'Show original' : `Show ${state.lang.toUpperCase()}`}
          </button>
        )}
        <button
          className={`btn lightbox-translate ${translating ? 'busy' : ''}`}
          onClick={() => void runTranslate()}
          title={`Translate to ${langName(state.lang)} (language selector in the sidebar)`}
        >
          {translating ? 'Reading the page…' : `Translate to ${state.lang.toUpperCase()}`}
        </button>
      </div>

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
          <span
            className={`cite-img-wrap zoomed page-rise ${zoom.scale > 1 ? 'panning' : ''}`}
            key={`${doc.id}-${page.page}`}
            ref={wrapRef}
            style={zoom.scale > 1 ? { transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})` } : undefined}
            onAnimationEnd={(e) => e.currentTarget.classList.remove('page-rise')}
            onDoubleClick={(e) => zoomToggleAt(e.clientX, e.clientY, e.currentTarget)}
            onPointerDown={(e) => {
              if (e.pointerType === 'mouse') {
                if (zoom.scale === 1) return; // keep native dblclick behavior when not zoomed
                e.preventDefault();
              } else {
                // candidate tap: invalidated by a second finger or by moving
                tapRef.current = pointers.current.size === 0 ? { t: performance.now(), x: e.clientX, y: e.clientY } : null;
              }
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              syncGesture();
            }}
            onPointerMove={(e) => {
              if (!pointers.current.has(e.pointerId)) return;
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              const g = gesture.current;
              if (!g) return;
              if (g.mode === 'pan') {
                const tx = g.tx + e.clientX - g.x;
                const ty = g.ty + e.clientY - g.y;
                setZoom((z) => ({ ...z, tx, ty }));
              } else {
                const pts = [...pointers.current.values()];
                if (pts.length < 2) return;
                const [a, b] = pts;
                const dist = Math.hypot(b.x - a.x, b.y - a.y);
                const mx = (a.x + b.x) / 2;
                const my = (a.y + b.y) / 2;
                const r = e.currentTarget.getBoundingClientRect();
                const dmx = mx - g.mx;
                const dmy = my - g.my;
                const ratio = g.dist > 0 ? dist / g.dist : 1;
                setZoom((z) => {
                  const scale = Math.min(4.5, Math.max(1, z.scale * ratio));
                  if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
                  const k = scale / z.scale;
                  const cx = mx - (r.left + r.width / 2);
                  const cy = my - (r.top + r.height / 2);
                  // same keep-the-point-fixed rule as the wheel; midpoint drift pans
                  return { scale, tx: cx - k * (cx - z.tx) + dmx, ty: cy - k * (cy - z.ty) + dmy };
                });
                gesture.current = { mode: 'pinch', dist, mx, my };
              }
            }}
            onPointerUp={(e) => {
              pointers.current.delete(e.pointerId);
              // Manual double-tap: Safari does not deliver dblclick reliably on touch
              if (e.pointerType !== 'mouse' && tapRef.current) {
                const tap = tapRef.current;
                tapRef.current = null;
                const now = performance.now();
                if (now - tap.t < 300 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 12) {
                  const prev = lastTapRef.current;
                  lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
                  if (prev && now - prev.t < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 40) {
                    lastTapRef.current = null;
                    zoomToggleAt(e.clientX, e.clientY, e.currentTarget);
                  }
                }
              }
              syncGesture();
            }}
            onPointerCancel={(e) => {
              pointers.current.delete(e.pointerId);
              tapRef.current = null;
              syncGesture();
            }}
          >
            <img
              ref={imgRef}
              src={page.imageUrl}
              alt={`${doc.model} page ${page.page}`}
              draggable={false}
              onLoad={() => imgRef.current && setImgH(imgRef.current.clientHeight)}
            />
            {blocks && showTranslated && (() => {
              const lineHeights = blocks.map((bb) => (bb.h * imgH) / (bb.lines ?? 1)).sort((a, z) => a - z);
              const median = lineHeights[Math.floor(lineHeights.length / 2)] || 14;
              return blocks.map((b, i) => {
                const lh = (b.h * imgH) / (b.lines ?? 1);
                const centered = Math.abs(b.x + b.w / 2 - 0.5) < 0.06 && b.x > 0.12;
                const st = patchStyles[i];
                return (
              <span
                key={i}
                className="tl-patch"
                style={{
                  left: `${b.x * 100}%`,
                  top: `${b.y * 100}%`,
                  width: `${b.w * 100}%`,
                  minHeight: `${b.h * 100}%`,
                  maxHeight: `${b.h * 170}%`,
                  // the ORIGINAL line height sets the type size: only the
                  // words change, not the look
                  fontSize: `${Math.max(7, Math.min(26, Math.round(lh * 0.72)))}px`,
                  fontWeight: (b.lines ?? 1) <= 2 && lh > median * 1.6 ? 650 : 400,
                  textAlign: centered ? 'center' : 'left',
                  background: st?.bg ?? 'rgba(252,252,250,0.97)',
                  color: st?.fg ?? '#17202b',
                  boxShadow: `0 0 0 3px ${st?.bg ?? 'rgba(252,252,250,0.97)'}`,
                }}
              >
                {b.text}
              </span>
                );
              });
            })()}
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
              {langName(state.lang).toUpperCase()} · NEMOTRON READ
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
