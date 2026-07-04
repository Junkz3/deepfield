import { LANGS, LANG_NAMES, useApp } from '../store';
import { setAgentLanguage } from '../../vultr/client';
import './sidebar.css';

/** Galaxy glyph: the agent sun + two orbiting docs, pure SVG, no emoji. */
function GalaxyGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="2.6" fill="var(--accent)" />
      <circle cx="9" cy="9" r="6.4" fill="none" stroke="var(--line-strong)" strokeWidth="1" />
      <circle cx="14.6" cy="6.2" r="1.4" fill="var(--info)" />
      <circle cx="3.8" cy="12.4" r="1.1" fill="var(--cat-vehicle)" />
    </svg>
  );
}

export function Sidebar() {
  const { state, dispatch } = useApp();
  const isCenter = state.activeView.kind === 'center';

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark" />
        RepairCenter
      </div>

      <button
        className={`sidebar-center ${isCenter ? 'active' : ''}`}
        onClick={() => dispatch({ type: 'open-center' })}
      >
        <GalaxyGlyph />
        <span>Repair Center</span>
        <span className="sidebar-count mono">{state.corpusDocs.length + state.sessionDocs.length}</span>
      </button>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span>Conversations</span>
          <button
            className="sidebar-new"
            title="New conversation"
            onClick={() => dispatch({ type: 'open-center' })}
            data-newconv
          >
            +
          </button>
        </div>
        <div className="sidebar-list">
          {state.conversations.length === 0 && (
            <div className="sidebar-empty">No conversations yet. Describe a fault to start.</div>
          )}
          {state.conversations.map((c) => {
            const active = state.activeView.kind === 'conversation' && state.activeView.id === c.id;
            return (
              <button
                key={c.id}
                className={`sidebar-item ${active ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'open-conversation', id: c.id })}
              >
                <span className="sidebar-item-device">{c.device}</span>
                <span className="sidebar-item-symptom">{c.symptom}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sidebar-langs">
        {LANGS.map((l) => (
          <button
            key={l.code}
            className={`sidebar-lang mono ${state.lang === l.code ? 'active' : ''}`}
            title={`Agent language: ${LANG_NAMES[l.code]} (retrieval is multilingual)`}
            onClick={() => {
              dispatch({ type: 'set-lang', lang: l.code });
              setAgentLanguage(LANG_NAMES[l.code]);
            }}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="sidebar-foot">
        <span className="chip" title="Ctrl+Shift+D toggles the driver">
          <span
            className="dot"
            style={{ background: state.driverKind === 'vultr' ? 'var(--ok)' : 'var(--warn)' }}
          />
          {state.driverKind === 'vultr' ? 'VULTR LIVE' : 'OFFLINE SCRIPT'}
        </span>
        <button
          className="sidebar-reset mono"
          title="Clear conversations and session files, back to the seeded corpus"
          onClick={() => dispatch({ type: 'demo-reset' })}
        >
          RESET
        </button>
      </div>
    </aside>
  );
}
