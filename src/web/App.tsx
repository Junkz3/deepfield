import { useEffect } from 'react';
import { AppProvider, useApp } from './store';
import { Sidebar } from './components/Sidebar';
import './app.css';

function CenterPlaceholder() {
  const { docs } = useApp();
  return (
    <section className="view-placeholder fade-up">
      <h1>Repair Center</h1>
      <p className="mono">{docs.length} documents in the knowledge base</p>
      <p>The knowledge galaxy renders here.</p>
    </section>
  );
}

function ConversationPlaceholder({ id }: { id: string }) {
  const { state } = useApp();
  const conv = state.conversations.find((c) => c.id === id);
  return (
    <section className="view-placeholder fade-up">
      <h1>{conv?.device ?? 'Conversation'}</h1>
      <p className="mono">{conv?.symptom}</p>
      <p>The copilot cockpit renders here.</p>
    </section>
  );
}

function Shell() {
  const { state, dispatch } = useApp();

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
      <main className="main">
        {state.activeView.kind === 'center' ? (
          <CenterPlaceholder />
        ) : (
          <ConversationPlaceholder id={state.activeView.id} />
        )}
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
