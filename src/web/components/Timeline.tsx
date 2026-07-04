// The reasoning timeline: the star of the demo. Renders phase events as they
// stream in; the autonomous re-retrieve decision is visually prominent.
import type { ReactNode } from 'react';
import type { Phase, PhaseEvent } from '../../agent/types';

const PHASE_COLOR: Record<Phase, string> = {
  plan: 'var(--info)',
  retrieve: 'var(--cat-dishwasher)',
  reason: 'var(--cat-smartphone)',
  tools: 'var(--accent)',
  decide: 'var(--ok)',
};

const ICON_PROPS = {
  width: 11,
  height: 11,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const PHASE_ICON: Record<Phase, ReactNode> = {
  plan: (
    <svg {...ICON_PROPS} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  ),
  retrieve: (
    <svg {...ICON_PROPS} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.3-4.3" />
    </svg>
  ),
  reason: (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M12 3c.9 4.6 3.4 7.1 8 8-4.6.9-7.1 3.4-8 8-.9-4.6-3.4-7.1-8-8 4.6-.9 7.1-3.4 8-8Z" />
    </svg>
  ),
  tools: (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  decide: (
    <svg {...ICON_PROPS} aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
};

const RETRY_ICON = (
  <svg {...ICON_PROPS} aria-hidden>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export function Timeline({ events, running, onOpenPage }: {
  events: PhaseEvent[];
  running: boolean;
  onOpenPage?: (docId: string, page: number) => void;
}) {
  return (
    <div className="timeline">
      {events.map((e, i) => {
        const isDecision = e.phase === 'retrieve' && !!e.detail;
        const isLast = i === events.length - 1;
        const color = isDecision ? 'var(--accent)' : PHASE_COLOR[e.phase];
        return (
          <div key={i} className={`timeline-row fade-up ${isDecision ? 'decision' : ''}`}>
            <span className="timeline-rail">
              <span
                className={`timeline-node ${running && isLast ? 'live' : ''}`}
                style={{ color }}
              >
                {isDecision ? RETRY_ICON : PHASE_ICON[e.phase]}
              </span>
            </span>
            <span className="timeline-phase mono" style={{ color }}>
              {e.phase.toUpperCase()}
            </span>
            <span className="timeline-body">
              {isDecision && <span className="timeline-eyebrow mono">AUTONOMOUS RE-RETRIEVE</span>}
              <span className="timeline-summary">{e.summary}</span>
              {e.detail && <span className="timeline-detail">{e.detail}</span>}
              {e.hitPages && e.hitPages.length > 0 && (
                <span className="timeline-hits">
                  {e.hitPages.map((h, j) => (
                    <button
                      key={j}
                      className="timeline-hit mono"
                      onClick={() => onOpenPage?.(h.docId, h.page)}
                      title="Open this page in the manual"
                    >
                      p.{h.page}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </div>
        );
      })}
      {running && events.length === 0 && (
        <div className="timeline-row">
          <span className="timeline-rail">
            <span className="timeline-node live" style={{ color: 'var(--info)' }}>{PHASE_ICON.plan}</span>
          </span>
          <span className="timeline-phase mono" style={{ color: 'var(--info)' }}>PLAN</span>
          <span className="timeline-body"><span className="timeline-summary">Starting…</span></span>
        </div>
      )}
    </div>
  );
}
