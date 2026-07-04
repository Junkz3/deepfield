// The reasoning timeline: the star of the demo. Renders phase events as they
// stream in; the autonomous re-retrieve decision is visually prominent.
import type { Phase, PhaseEvent } from '../../agent/types';

const PHASE_COLOR: Record<Phase, string> = {
  plan: 'var(--info)',
  retrieve: 'var(--cat-dishwasher)',
  reason: 'var(--cat-smartphone)',
  tools: 'var(--accent)',
  decide: 'var(--ok)',
};

export function Timeline({ events, running }: { events: PhaseEvent[]; running: boolean }) {
  return (
    <div className="timeline">
      {events.map((e, i) => {
        const isDecision = e.phase === 'retrieve' && !!e.detail;
        const isLast = i === events.length - 1;
        return (
          <div key={i} className={`timeline-row fade-up ${isDecision ? 'decision' : ''}`}>
            <span className="timeline-rail">
              <span
                className={`timeline-dot ${running && isLast ? 'live' : ''}`}
                style={{ background: PHASE_COLOR[e.phase] }}
              />
            </span>
            <span className="timeline-phase mono" style={{ color: PHASE_COLOR[e.phase] }}>
              {e.phase.toUpperCase()}
            </span>
            <span className="timeline-body">
              <span className="timeline-summary">{e.summary}</span>
              {e.detail && <span className="timeline-detail">{e.detail}</span>}
              {e.hitPages && e.hitPages.length > 0 && (
                <span className="timeline-hits mono">
                  {e.hitPages.map((h) => `p.${h.page}`).join('  ')}
                </span>
              )}
            </span>
          </div>
        );
      })}
      {running && events.length === 0 && (
        <div className="timeline-row">
          <span className="timeline-rail"><span className="timeline-dot live" style={{ background: 'var(--info)' }} /></span>
          <span className="timeline-phase mono" style={{ color: 'var(--info)' }}>PLAN</span>
          <span className="timeline-body"><span className="timeline-summary">Starting…</span></span>
        </div>
      )}
    </div>
  );
}
