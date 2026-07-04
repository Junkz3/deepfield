import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { scopeDocIds } from '../agent/taxonomy';
import { getDriver } from './driver-factory';
import { ingestFile } from './ingest';
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
  const [dragging, setDragging] = useState(false);
  const [ingesting, setIngesting] = useState<string | null>(null);
  const inConversation = state.activeView.kind === 'conversation';

  const ingestFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const driver = await getDriver(state.driverKind);
    for (const file of files) {
      setIngesting(`Reading and classifying "${file.name}"…`);
      try {
        const doc = await ingestFile(file, driver);
        dispatch({ type: 'add-session-doc', doc });
        setIngesting(`Filed under ${doc.category} / ${doc.brand} ${doc.model}`);
        setTimeout(() => setIngesting(null), 2600);
      } catch (err) {
        setIngesting(`Could not ingest ${file.name}: ${err instanceof Error ? err.message : 'unknown error'}`);
        setTimeout(() => setIngesting(null), 4000);
      }
    }
  }, [dispatch, state.driverKind]);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void ingestFiles([...e.dataTransfer.files]);
  }, [ingestFiles]);

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
      <main
        className={`main stage ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!inConversation) setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={inConversation ? undefined : onDrop}
      >
        {/* The universe is the permanent backdrop of everything. */}
        <Suspense fallback={<div className="galaxy-loading mono">Charting the knowledge universe…</div>}>
          <Galaxy3D
            panelOpen={inConversation}
            scopeIds={scopeIds}
            onSelectDoc={(docId) => {
              const doc = docs.find((d) => d.id === docId);
              if (doc?.pages[0]) dispatch({ type: 'open-lightbox', docId, page: doc.pages[0].page });
            }}
            onOpenPage={(docId, page) => dispatch({ type: 'open-lightbox', docId, page })}
          />
        </Suspense>

        {!inConversation && (
          <>
            <button className={`galaxy-tree-toggle btn ${showTree ? 'active' : ''}`} onClick={() => setShowTree(!showTree)}>
              Knowledge tree
            </button>
            <label className="galaxy-add btn" title="Add manuals to the knowledge universe (or drop files anywhere)">
              Add files
              <input
                type="file"
                multiple
                hidden
                accept=".pdf,image/*,.txt,.log,.md"
                onChange={(e) => { if (e.target.files) void ingestFiles([...e.target.files]); e.target.value = ''; }}
              />
            </label>
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

        {dragging && !inConversation && (
          <div className="drop-veil">
            <div className="drop-veil-inner mono">Release to add to the knowledge universe</div>
          </div>
        )}
        {ingesting && <div className="ingest-toast mono fade-up">{ingesting}</div>}

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
