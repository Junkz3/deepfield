import { useEffect } from 'react';
import { AppProvider, useApp } from './store';
import { Sidebar } from './components/Sidebar';
import { ConversationView } from './components/ConversationView';
import { GalaxyView } from './components/GalaxyView';
import './app.css';

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
          <GalaxyView />
        ) : (
          <ConversationView id={state.activeView.id} />
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
