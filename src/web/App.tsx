import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { scopeDocIds } from '../agent/taxonomy';
import { AppProvider, useApp } from './store';
import { Sidebar } from './components/Sidebar';
import { ConversationView } from './components/ConversationView';
import { CommandBar } from './components/CommandBar';
import { PageLightbox } from './components/PageLightbox';
import { TreePanel } from './components/TreePanel';
import './app.css';
import './components/galaxy.css';

const Galaxy3D = lazy(() => import('./components/Galaxy3D').then((m) => ({ default: m.Galaxy3D })));

function Shell() {
  const { state, dispatch, docs } = useApp();
  const [showTree, setShowTree] = useState(false);
  const inConversation = state.activeView.kind === 'conversation';

  // Contextual recursion: the active conversation's scope recomposes the universe.
  const scopeIds = useMemo(() => {
    if (state.activeView.kind !== 'conversation') return null;
    const conv = state.conversations.find((c) => state.activeView.kind === 'conversation' && c.id === state.activeView.id);
    return conv ? scopeDocIds(docs, conv.device) : null;
  }, [state.activeView, state.conversations, docs]);

  // Global shortcuts: Ctrl+Shift+R = demo reset, Ctrl+Shift+D = driver toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        dispatch({ type: 'demo-reset' });
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        dispatch({ type: 'set-driver', kind: state.driverKind === 'fake' ? 'vultr' : 'fake' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.driverKind]);

  return (
    <div className="shell">
      <Sidebar />
      <main className="main stage">
        {/* The universe is the permanent backdrop of everything. */}
        <Suspense fallback={<div className="galaxy-loading mono">Charting the knowledge universe…</div>}>
          <Galaxy3D
            panelOpen={inConversation}
            scopeIds={scopeIds}
            onOpenPage={(docId, page) => dispatch({ type: 'open-lightbox', docId, page })}
          />
        </Suspense>

        {!inConversation && (
          <>
            <button className={`galaxy-tree-toggle btn ${showTree ? 'active' : ''}`} onClick={() => setShowTree(!showTree)}>
              Knowledge tree
            </button>
            {showTree && (
              <div className="galaxy-tree-drawer fade-up">
                <TreePanel />
              </div>
            )}
            <CommandBar />
          </>
        )}

        {inConversation && state.activeView.kind === 'conversation' && (
          <div className="conv-panel fade-up">
            <ConversationView id={state.activeView.id} />
          </div>
        )}

        <PageLightbox />
      </main>
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
