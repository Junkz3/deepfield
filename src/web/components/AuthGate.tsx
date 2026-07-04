// Account gate for multi-user deployments (AUTH_ENABLED=1 on the VM).
// On open deployments (dev server, no auth configured) it renders nothing
// but the app. When auth is on: sign in or create an account, the per-user
// server store rehydrates the workspaces, and a quota chip shows the daily
// inference budget.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './auth.css';

type Phase =
  | { kind: 'checking' }
  | { kind: 'open' }
  | { kind: 'gate' }
  | { kind: 'in'; email: string; quota?: { used: number; limit: number } };

const STORE_KEYS_PREFIX = 'rc.conversations';
const WS_KEY = 'rc.workspaces';

async function pullServerStore(): Promise<void> {
  try {
    const r = await fetch('/api/me/store');
    if (!r.ok) return;
    const store = await r.json() as { workspaces?: unknown; conversations?: Record<string, unknown> };
    if (store.workspaces) localStorage.setItem(WS_KEY, JSON.stringify(store.workspaces));
    for (const [k, v] of Object.entries(store.conversations ?? {})) {
      if (k === STORE_KEYS_PREFIX || k.startsWith(`${STORE_KEYS_PREFIX}.`)) {
        localStorage.setItem(k, JSON.stringify(v));
      }
    }
  } catch { /* offline store stays local */ }
}

function collectLocalStore(): string {
  const conversations: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k === STORE_KEYS_PREFIX || k.startsWith(`${STORE_KEYS_PREFIX}.`))) {
      try { conversations[k] = JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { /* skip */ }
    }
  }
  let workspaces: unknown = [];
  try { workspaces = JSON.parse(localStorage.getItem(WS_KEY) ?? '[]'); } catch { /* skip */ }
  return JSON.stringify({ workspaces, conversations, savedAt: new Date().toISOString() });
}

function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError((j as { error?: string }).error ?? `${mode} failed`); return; }
      onSignedIn();
    } catch {
      setError('network error, try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card panel fade-up">
        <span className="auth-mark" />
        <h1 className="auth-title">Deepfield</h1>
        <p className="auth-tagline">Sign in to your document-universe workspaces.</p>
        <label className="auth-label mono" htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          className="auth-input"
          type="email"
          autoComplete="email"
          value={email}
          autoFocus
          onChange={(e) => setEmail(e.target.value)}
        />
        <label className="auth-label mono" htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          className="auth-input"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="btn btn-primary auth-submit" onClick={() => void submit()} disabled={busy || !email || !password}>
          {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          className="auth-switch mono"
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}
        >
          {mode === 'login' ? 'No account yet? Create one' : 'Already registered? Sign in'}
        </button>
        <p className="auth-note mono">Accounts get a daily inference budget on this demo deployment.</p>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const pushTimer = useRef<number | null>(null);

  const check = useCallback(async () => {
    try {
      const r = await fetch('/api/me');
      if (!(r.headers.get('content-type') ?? '').includes('json')) { setPhase({ kind: 'open' }); return; }
      const j = await r.json() as { auth?: boolean; email?: string; quota?: { used: number; limit: number } };
      if (j.auth === false) { setPhase({ kind: 'open' }); return; }
      if (r.ok && j.email) {
        // The server store must land BEFORE the app boots and hydrates.
        await pullServerStore();
        setPhase({ kind: 'in', email: j.email, quota: j.quota });
        return;
      }
      setPhase({ kind: 'gate' });
    } catch {
      setPhase({ kind: 'open' });
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  // Signed in: sync the light manifest to the account store periodically
  // and on exit - your workspaces follow your account across browsers.
  useEffect(() => {
    if (phase.kind !== 'in') return;
    const push = () => {
      void fetch('/api/me/store', { method: 'PUT', body: collectLocalStore() }).catch(() => { /* retry next tick */ });
    };
    pushTimer.current = window.setInterval(push, 20_000);
    window.addEventListener('beforeunload', push);
    return () => {
      if (pushTimer.current !== null) window.clearInterval(pushTimer.current);
      window.removeEventListener('beforeunload', push);
    };
  }, [phase.kind]);

  if (phase.kind === 'checking') return <div className="auth-checking mono">Connecting…</div>;
  if (phase.kind === 'gate') return <AuthScreen onSignedIn={() => void check()} />;
  return (
    <>
      {children}
      {phase.kind === 'in' && (
        <div className="auth-chip mono" title="Daily inference budget on this account">
          <span className="auth-chip-mail">{phase.email}</span>
          {phase.quota && <span className="auth-chip-quota">{phase.quota.used}/{phase.quota.limit} today</span>}
          <button
            className="auth-chip-out"
            title="Sign out"
            onClick={() => { void fetch('/api/auth/logout', { method: 'POST' }).then(() => location.reload()); }}
          >
            Sign out
          </button>
        </div>
      )}
    </>
  );
}
