import { LANGS, langName, useApp } from '../store';
import { VoiceToggle } from './VoiceToggle';
import { setAgentLanguage } from '../../vultr/client';
import { setWorkflowProfile } from '../../agent/workflow';
import './sidebar.css';

/** Galaxy glyph: the agent sun + two orbiting docs, pure SVG, no emoji.
 *  Doubles as the Deepfield logo (Studio header uses it enlarged). */
export function GalaxyGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
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
        <span className="sidebar-brand-mark" aria-hidden>
          <GalaxyGlyph size={22} />
        </span>
        <span className="sidebar-brand-text">
          {state.workspaceName}
          <span className="sidebar-brand-sub">built on Deepfield</span>
        </span>
      </div>

      <div className="sidebar-section sidebar-workspaces">
        <div className="sidebar-section-head">
          <span>Workspaces</span>
          <button
            className="sidebar-new"
            disabled={1 + state.workspaces.length >= 4}
            title={1 + state.workspaces.length >= 4 ? 'Up to 4 workspaces per session' : 'New workspace'}
            onClick={() => dispatch({ type: 'open-studio' })}
          >
            +
          </button>
        </div>
        <button
          className={`sidebar-center ${isCenter && !state.studioOpen ? 'active' : ''}`}
          onClick={() => { dispatch({ type: 'close-studio' }); dispatch({ type: 'open-center' }); }}
        >
          <GalaxyGlyph />
          <span>{state.workspaceName}</span>
          <span className="sidebar-count mono">{state.corpusDocs.length + state.sessionDocs.length}</span>
        </button>
        {state.workspaces.map((w) => (
          <button
            key={w.id}
            className="sidebar-center dormant"
            title={`Switch to ${w.name}`}
            onClick={() => dispatch({ type: 'switch-workspace', id: w.id })}
          >
            <GalaxyGlyph />
            <span>{w.name}</span>
            <span className="sidebar-count mono">{w.corpusDocs.length + w.sessionDocs.length}</span>
          </button>
        ))}
      </div>

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
          {state.conversations.length === 0 && state.workspaces.every((w) => w.conversations.length === 0) && (
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
                {state.workspaces.length > 0 && (
                  <span className="sidebar-item-ws mono">{state.workspaceName}</span>
                )}
              </button>
            );
          })}
          {/* Parked workspaces keep their history in sight: opening one of
              their conversations switches the whole workspace over. */}
          {state.workspaces.flatMap((w) =>
            w.conversations.map((c) => (
              <button
                key={c.id}
                className="sidebar-item dormant"
                title={`In ${w.name} - opens after switching`}
                onClick={() => {
                  dispatch({ type: 'switch-workspace', id: w.id });
                  dispatch({ type: 'open-conversation', id: c.id });
                }}
              >
                <span className="sidebar-item-device">{c.device}</span>
                <span className="sidebar-item-symptom">{c.symptom}</span>
                <span className="sidebar-item-ws mono">{w.name}</span>
              </button>
            )),
          )}
        </div>
      </div>

      <div className="sidebar-langs">
        <span className="sidebar-langs-label mono">LANG</span>
        <select
          className="sidebar-lang-select mono"
          value={state.lang}
          title="Agent language. Retrieval is natively cross-lingual in the starred six; other languages route the search query through English."
          onChange={(e) => {
            const code = e.target.value;
            dispatch({ type: 'set-lang', lang: code });
            setAgentLanguage(langName(code));
          }}
        >
          <optgroup label="Retrieval-grade">
            {LANGS.filter((l) => l.retrieval).map((l) => (
              <option key={l.code} value={l.code}>{l.code.toUpperCase()} — {l.name}</option>
            ))}
          </optgroup>
          <optgroup label="Translation">
            {LANGS.filter((l) => !l.retrieval).map((l) => (
              <option key={l.code} value={l.code}>{l.code.toUpperCase()} — {l.name}</option>
            ))}
          </optgroup>
        </select>
      </div>
      <VoiceToggle />
      <div className="sidebar-foot">
        <button
          className="chip sidebar-driver"
          title="Toggle the inference driver (Ctrl+Shift+D)"
          onClick={() => dispatch({ type: 'set-driver', kind: state.driverKind === 'fake' ? 'vultr' : 'fake' })}
        >
          <span
            className="dot"
            style={{ background: state.driverKind === 'vultr' ? 'var(--ok)' : 'var(--warn)' }}
          />
          {state.driverKind === 'vultr' ? 'VULTR LIVE' : 'OFFLINE SCRIPT'}
        </button>
        <button
          className="sidebar-reset mono"
          title="Clear conversations and session files, back to the seeded corpus"
          onClick={() => { setWorkflowProfile('repair'); dispatch({ type: 'demo-reset' }); }}
        >
          RESET
        </button>
      </div>
    </aside>
  );
}
