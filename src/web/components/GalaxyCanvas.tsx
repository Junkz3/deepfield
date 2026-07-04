// The knowledge galaxy renderer. SVG nodes over a Canvas starfield.
// The layout is deterministic (layoutGalaxy); ambient life comes from
// translation-only orbital drift (labels never tilt) and CSS twinkle.
// Retrieval hits pulse and draw a link to the agent sun: retrieval, made visible.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTaxonomy, layoutGalaxy } from '../../agent/taxonomy';
import type { GalaxyNode } from '../../agent/taxonomy';
import type { Document } from '../../agent/types';
import { categoryColor, useApp } from '../store';

const DRIFT_SPEED = 0.028; // radians/s for doc orbits — slow, alive, not dizzy

interface HoverInfo { node: GalaxyNode; doc?: Document; x: number; y: number }

function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const stars: { x: number; y: number; r: number; p: number; s: number }[] = [];
    const resize = () => {
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
      if (stars.length === 0) {
        for (let i = 0; i < 160; i++) {
          stars.push({ x: Math.random(), y: Math.random(), r: Math.random() * 1.1 + 0.25, p: Math.random() * Math.PI * 2, s: 0.3 + Math.random() * 0.9 });
        }
      }
    };
    resize();
    window.addEventListener('resize', resize);
    const draw = (t: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const st of stars) {
        const a = 0.18 + 0.5 * Math.abs(Math.sin(st.p + (t / 1000) * st.s));
        ctx.globalAlpha = a;
        ctx.fillStyle = '#9db4c8';
        ctx.beginPath();
        ctx.arc(st.x * canvas.width, st.y * canvas.height, st.r * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={ref} className="galaxy-stars" />;
}

export function GalaxyCanvas({ onSelectDoc }: { onSelectDoc?: (docId: string) => void }) {
  const { state, docs } = useApp();
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [focusDoc, setFocusDoc] = useState<string | null>(null);
  const orbitRefs = useRef(new Map<string, SVGGElement>());

  const layout = useMemo(() => layoutGalaxy(buildTaxonomy(docs)), [docs]);
  const docNodes = useMemo(() => layout.nodes.filter((n) => n.type === 'document'), [layout]);
  const catNodes = useMemo(() => layout.nodes.filter((n) => n.type === 'category'), [layout]);
  const pagesByDoc = useMemo(() => {
    const m = new Map<string, GalaxyNode[]>();
    for (const n of layout.nodes) {
      if (n.type === 'page' && n.parentId) {
        if (!m.has(n.parentId)) m.set(n.parentId, []);
        m.get(n.parentId)!.push(n);
      }
    }
    return m;
  }, [layout]);

  const catCenter = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const c of catNodes) m.set(c.id, { x: c.x, y: c.y });
    return m;
  }, [catNodes]);

  const hitDocIds = useMemo(() => new Set(state.highlight.map((h) => `doc:${h.docId}`)), [state.highlight]);
  const hitPageIds = useMemo(() => new Set(state.highlight.map((h) => `page:${h.docId}/${h.page}`)), [state.highlight]);

  // Orbital drift: translation-only, direct DOM writes, no React re-render.
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const base = new Map(docNodes.map((n) => {
      const c = n.parentId ? catCenter.get(n.parentId)! : { x: 0, y: 0 };
      return [n.id, { cx: c.x, cy: c.y, r: Math.hypot(n.x - c.x, n.y - c.y), a0: Math.atan2(n.y - c.y, n.x - c.x) }];
    }));
    const tick = (t: number) => {
      const dt = (t - t0) / 1000;
      for (const [id, b] of base) {
        const g = orbitRefs.current.get(id);
        if (!g) continue;
        const a = b.a0 + dt * DRIFT_SPEED;
        g.setAttribute('transform', `translate(${b.cx + Math.cos(a) * b.r}, ${b.cy + Math.sin(a) * b.r})`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [docNodes, catCenter]);

  const docById = (docId?: string) => docs.find((d) => d.id === docId);

  return (
    <div className="galaxy-wrap">
      <Starfield />
      <svg className="galaxy-svg" viewBox="-1.45 -0.80 2.9 1.62" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
            <stop offset="35%" stopColor="var(--accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <filter id="nodeGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="0.012" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Constellation spokes */}
        {catNodes.map((c) => (
          <line key={`spoke-${c.id}`} x1="0" y1="0" x2={c.x} y2={c.y} className="galaxy-spoke" />
        ))}

        {/* Retrieval links: hit docs draw a live line to the agent sun */}
        {docNodes.filter((n) => hitDocIds.has(n.id)).map((n) => (
          <line
            key={`link-${n.id}`}
            x1="0" y1="0" x2={n.x} y2={n.y}
            className="galaxy-link"
            style={{ stroke: categoryColor(catNodes[n.categoryIndex]?.label ?? '') }}
          />
        ))}

        {/* Scanning sweep while retrieval is in flight */}
        {state.scanning && (
          <g className="galaxy-sweep">
            <path d="M 0 0 L 1.1 0 A 1.1 1.1 0 0 1 0.95 0.55 Z" fill="url(#sunGlow)" opacity="0.35" />
          </g>
        )}

        {/* Category constellations */}
        {catNodes.map((c) => {
          const color = categoryColor(c.label);
          return (
            <g key={c.id} className="galaxy-cat">
              <circle cx={c.x} cy={c.y} r={c.r} fill="none" stroke={color} strokeWidth="0.006" opacity="0.85" />
              <circle cx={c.x} cy={c.y} r={c.r * 0.45} fill={color} opacity="0.9" />
              <text x={c.x} y={c.y + c.r + 0.055} className="galaxy-cat-label" fill={color}>
                {c.label}
              </text>
            </g>
          );
        })}

        {/* Documents + their page dots (drift via group transform) */}
        {docNodes.map((n) => {
          const color = categoryColor(catNodes[n.categoryIndex]?.label ?? '');
          const doc = docById(n.docId);
          const isHit = hitDocIds.has(n.id);
          const isSession = doc?.origin === 'session';
          const pages = pagesByDoc.get(n.id) ?? [];
          return (
            <g
              key={n.id}
              ref={(el) => { if (el) orbitRefs.current.set(n.id, el); }}
              transform={`translate(${n.x}, ${n.y})`}
              className={`galaxy-doc ${isHit ? 'hit' : ''} ${focusDoc === n.docId ? 'focus' : ''}`}
              onMouseEnter={(e) => setHover({ node: n, doc, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                setFocusDoc(focusDoc === n.docId ? null : n.docId ?? null);
                if (n.docId && onSelectDoc) onSelectDoc(n.docId);
              }}
            >
              {pages.map((p, i) => {
                const px = p.x - n.x, py = p.y - n.y;
                const pageHit = hitPageIds.has(p.id);
                return (
                  <circle
                    key={p.id}
                    cx={px} cy={py} r={pageHit ? 0.011 : 0.0055}
                    className={`galaxy-page ${pageHit ? 'hit' : ''}`}
                    fill={color}
                    style={{ animationDelay: `${(i % 7) * 0.6}s` }}
                  />
                );
              })}
              <circle r={n.r} fill="var(--bg2)" stroke={color} strokeWidth={isHit ? 0.005 : 0.0028} filter={isHit ? 'url(#nodeGlow)' : undefined} />
              <circle r={n.r * 0.42} fill={color} opacity={isHit ? 1 : 0.75} />
              {isSession && <circle r={n.r + 0.012} fill="none" stroke="var(--accent)" strokeWidth="0.0025" strokeDasharray="0.012 0.008" />}
              <text y={n.r + 0.042} className="galaxy-doc-label">{doc ? doc.model : n.label}</text>
            </g>
          );
        })}

        {/* The agent sun */}
        <g className="galaxy-sun">
          <circle r="0.34" fill="url(#sunGlow)" className="sun-halo" />
          <circle r="0.055" fill="var(--accent)" />
          <circle r="0.085" fill="none" stroke="var(--accent)" strokeWidth="0.004" opacity="0.5" className="sun-ring" />
          <text y="0.155" className="galaxy-sun-label">AGENT</text>
        </g>
      </svg>

      {hover?.doc && (
        <div className="galaxy-card" style={{ left: hover.x + 14, top: hover.y + 10 }}>
          <div className="galaxy-card-title">{hover.doc.brand} {hover.doc.model}</div>
          <div className="galaxy-card-line mono">
            {hover.doc.docType} · {hover.doc.pages.length} pages · {hover.doc.format.toUpperCase()}
          </div>
          <div className="galaxy-card-rights">{hover.doc.sourceRights}</div>
        </div>
      )}
    </div>
  );
}
