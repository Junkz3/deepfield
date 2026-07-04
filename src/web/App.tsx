import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { categoryScope, scopeDocIds } from '../agent/taxonomy';
import { installWorkspaceOps, TOOL_REGISTRY } from '../agent/tools';
import { setWorkflowProfile } from '../agent/workflow';
import { getDriver } from './driver-factory';
import { deepenDocument, ingestFile } from './ingest';
import { AppProvider, useApp } from './store';
import { Sidebar } from './components/Sidebar';
import { DeepfieldStudio } from './components/DeepfieldStudio';
import { ConversationView } from './components/ConversationView';
import { CommandBar } from './components/CommandBar';
import { CategoryFilter } from './components/CategoryFilter';
import { PageLightbox } from './components/PageLightbox';
import { SelfCheckPanel } from './components/SelfCheckPanel';
import './app.css';
import './components/galaxy.css';

const Galaxy3D = lazy(() => import('./components/Galaxy3D').then((m) => ({ default: m.Galaxy3D })));

function Shell() {
  const { state, dispatch, docs } = useApp();
  const [dragging, setDragging] = useState(false);
  const [ingesting, setIngesting] = useState<string | null>(null);
  const [studioQueue, setStudioQueue] = useState<File[]>([]);
  const [checkDocIds, setCheckDocIds] = useState<string[]>([]);
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const inConversation = state.activeView.kind === 'conversation';

  const ingestFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const driver = await getDriver(state.driverKind);
    for (const file of files) {
      setIngesting(`Reading and classifying "${file.name}"…`);
      dispatch({ type: 'ingest-start', name: file.name });
      try {
        const doc = await ingestFile(file, driver);
        dispatch({ type: 'add-session-doc', doc });
        dispatch({ type: 'ingest-done', docId: doc.id });
        // Deepen in the background: the remaining pages render batch by batch
        // and join the constellation live - a dropped 88-page policy becomes
        // as searchable as a built corpus, without blocking the drop.
        void deepenDocument(file, doc, driver, (docId, pages) =>
          dispatch({ type: 'extend-session-doc', docId, pages }),
        ).catch(() => { /* deepening is best-effort; the first pages already landed */ });
        setCheckDocIds((prev) => (prev.includes(doc.id) ? prev : [...prev, doc.id]));
        setIngesting(`Filed under ${doc.category} / ${doc.brand} ${doc.model}`);
        setTimeout(() => setIngesting(null), 2600);
      } catch (err) {
        dispatch({ type: 'ingest-done', docId: null });
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

  // Contextual recursion: the active conversation's scope recomposes the
  // universe; outside a conversation the user's own category filter does.
  const scopeIds = useMemo(() => {
    if (state.activeView.kind === 'conversation') {
      const conv = state.conversations.find((c) => state.activeView.kind === 'conversation' && c.id === state.activeView.id);
      return conv ? scopeDocIds(docs, conv.device) : null;
    }
    return catFilter !== null ? categoryScope(docs, catFilter) : null;
  }, [state.activeView, state.conversations, docs, catFilter]);

  // Global shortcuts: Ctrl+Shift+R = demo reset, Ctrl+Shift+D = driver toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setWorkflowProfile('repair');
        installWorkspaceOps(TOOL_REGISTRY);
        setCatFilter(null);
        dispatch({ type: 'demo-reset' });
      } else if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        dispatch({ type: 'set-driver', kind: state.driverKind === 'fake' ? 'vultr' : 'fake' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.driverKind]);

  // Files dropped in the Studio that are not pre-indexed: ingest them once the
  // workspace is open, so they go through the driver the workspace booted with.
  useEffect(() => {
    if (!state.studioMode && studioQueue.length > 0) {
      const queue = studioQueue;
      setStudioQueue([]);
      void ingestFiles(queue);
    }
  }, [state.studioMode, studioQueue, ingestFiles]);

  return (
    <div className="shell">
      {!state.studioMode && <Sidebar />}
      <main
        className={`main stage ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!inConversation && !state.studioMode) setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={inConversation || state.studioMode ? undefined : onDrop}
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

        {!inConversation && !state.studioMode && (
          <>
            <label className="galaxy-add" title="Add manuals to the knowledge universe (or drop files anywhere)">
              <span className="galaxy-add-plus mono">+</span>
              Add files
              <input
                type="file"
                multiple
                hidden
                accept=".pdf,image/*,.txt,.log,.md"
                onChange={(e) => { if (e.target.files) void ingestFiles([...e.target.files]); e.target.value = ''; }}
              />
            </label>
            <CategoryFilter docs={docs} value={catFilter} onChange={setCatFilter} />
            <CommandBar />
          </>
        )}

        {inConversation && state.activeView.kind === 'conversation' && (
          <div className="conv-panel fade-up">
            <ConversationView id={state.activeView.id} />
          </div>
        )}

        {dragging && !inConversation && !state.studioMode && (
          <div className="drop-veil">
            <div className="drop-veil-inner mono">Release to add to the knowledge universe</div>
          </div>
        )}
        {ingesting && <div className="ingest-toast mono fade-up">{ingesting}</div>}

        {checkDocIds.length > 0 && !inConversation && !state.studioMode && (
          <SelfCheckPanel docIds={checkDocIds} onClose={() => setCheckDocIds([])} />
        )}

        {/* Studio floats over the live (empty) universe: creation happens in plain sight. */}
        {state.studioMode && (
          <DeepfieldStudio
            onCreate={(name, corpus, liveFiles) => {
              if (liveFiles.length > 0) setStudioQueue(liveFiles);
              dispatch({ type: 'create-workspace', name, corpus });
            }}
          />
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
