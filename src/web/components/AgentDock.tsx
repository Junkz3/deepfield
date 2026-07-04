// The agent dock: which specialists are enabled for the NEXT request.
// One chip per team agent; click toggles it in or out of the router's
// reach. Lives wherever a request can start (command bar, conversation).
import { useApp } from '../store';
import './agentdock.css';

export function AgentDock({ compact }: { compact?: boolean }) {
  const { state, dispatch } = useApp();
  if (state.team.length === 0) return null;
  const activeCount = state.team.filter((a) => a.active).length;
  const solo = state.team.length === 1;

  return (
    <div className={`agent-dock ${compact ? 'compact' : ''}`}>
      <span className="agent-dock-label mono">{solo ? 'Agent' : 'Agents'}</span>
      {state.team.map((a) => {
        const locked = a.active && activeCount === 1 && !solo;
        return (
          <button
            key={a.id}
            className={`agent-chip ${a.active ? 'on' : 'off'}`}
            disabled={solo}
            title={solo ? a.charter : locked ? `${a.charter} (at least one agent must stay active)` : a.charter}
            onClick={() => dispatch({ type: 'toggle-agent', id: a.id })}
          >
            <span className="agent-chip-dot" aria-hidden />
            {a.label}
          </button>
        );
      })}
    </div>
  );
}
