// Account gate for multi-user deployments (AUTH_ENABLED=1 on the VM).
// On open deployments (dev server, no auth configured) it renders nothing
// but the app. When auth is on: sign in or create an account, verify the
// email (the agent stays locked until then), the per-user server store
// rehydrates the workspaces, and a quota chip shows the daily budget.
// Password reset rides the same gate: /?reset=<token> from the email.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './auth.css';

type Phase =
  | { kind: 'checking' }
  | { kind: 'open' }
  | { kind: 'gate' }
  | { kind: 'verify'; email: string }
  | { kind: 'in'; email: string; quota?: { used: number; limit: number } };

const STORE_KEYS_PREFIX = 'rc.conversations';
const WS_KEY = 'rc.workspaces';

/** One-shot auth params from email links, removed from the URL on read so a
 *  refresh does not replay them. Other app params (?driver, ?studio) stay. */
function readAuthParams(): { reset?: string; verified?: '1' | '0' } {
  const q = new URLSearchParams(location.search);
  const reset = q.get('reset') ?? undefined;
  const verified = (q.get('verified') as '1' | '0' | null) ?? undefined;
  if (reset !== undefined || verified !== undefined) {
    q.delete('reset');
    q.delete('verified');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }
  return { reset, verified };
}

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

type Mode = 'login' | 'signup' | 'forgot' | 'reset';

function AuthScreen({ onSignedIn, resetToken, initialNotice, onResetConsumed }: {
  onSignedIn: () => void;
  resetToken?: string;
  initialNotice?: { ok: boolean; text: string };
  onResetConsumed: () => void;
}) {
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(initialNotice ?? null);
  const [busy, setBusy] = useState(false);

  const post = async (path: string, body: unknown): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      return r.ok ? { ok: true } : { ok: false, error: j.error };
    } catch {
      return { ok: false, error: 'network error, try again' };
    }
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'forgot') {
        await post('/api/auth/request-reset', { email });
        setMode('login');
        setNotice({ ok: true, text: 'If an account exists for this email, a reset link is on its way.' });
        return;
      }
      if (mode === 'reset') {
        const r = await post('/api/auth/reset', { token: resetToken, password });
        if (!r.ok) {
          setError(r.error ?? 'reset failed');
          return;
        }
        onResetConsumed();
        setPassword('');
        setMode('login');
        setNotice({ ok: true, text: 'Password updated. Sign in with your new password.' });
        return;
      }
      const r = await post(`/api/auth/${mode}`, { email, password });
      if (!r.ok) { setError(r.error ?? `${mode} failed`); return; }
      onSignedIn();
    } finally {
      setBusy(false);
    }
  };

  const taglines: Record<Mode, string> = {
    login: 'Sign in to your document-universe workspaces.',
    signup: 'Create an account to build document-universe workspaces.',
    forgot: 'Enter your account email and we will send a reset link.',
    reset: 'Choose a new password for your account.',
  };
  const submitLabels: Record<Mode, string> = {
    login: 'Sign in',
    signup: 'Create account',
    forgot: 'Send reset link',
    reset: 'Set new password',
  };
  const showEmail = mode !== 'reset';
  const showPassword = mode !== 'forgot';
  const canSubmit = (!showEmail || email.length > 0) && (!showPassword || password.length > 0);

  return (
    <div className="auth-screen">
      <div className="auth-card panel fade-up">
        <span className="auth-mark" />
        <h1 className="auth-title">Deepfield</h1>
        <p className="auth-tagline">{taglines[mode]}</p>
        {showEmail && (
          <>
            <label className="auth-label mono" htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              className="auth-input"
              type="email"
              autoComplete="email"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && mode === 'forgot' && void submit()}
            />
          </>
        )}
        {showPassword && (
          <>
            <label className="auth-label mono" htmlFor="auth-password">
              {mode === 'reset' ? 'New password' : 'Password'}
            </label>
            <input
              id="auth-password"
              className="auth-input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              autoFocus={mode === 'reset'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
          </>
        )}
        {error && <div className="auth-error">{error}</div>}
        {notice && <div className={notice.ok ? 'auth-ok' : 'auth-error'}>{notice.text}</div>}
        <button className="btn btn-primary auth-submit" onClick={() => void submit()} disabled={busy || !canSubmit}>
          {busy ? 'One moment…' : submitLabels[mode]}
        </button>
        {mode !== 'reset' && (
          <button
            className="auth-switch mono"
            onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setNotice(null); }}
          >
            {mode === 'login' ? 'No account yet? Create one' : 'Already registered? Sign in'}
          </button>
        )}
        {mode === 'login' && (
          <button
            className="auth-switch mono"
            onClick={() => { setMode('forgot'); setError(null); setNotice(null); }}
          >
            Forgot your password?
          </button>
        )}
        {(mode === 'forgot' || mode === 'reset') && (
          <button
            className="auth-switch mono"
            onClick={() => { setMode('login'); setError(null); setNotice(null); }}
          >
            Back to sign in
          </button>
        )}
        <p className="auth-note mono">Accounts get a daily inference budget on this demo deployment.</p>
      </div>
    </div>
  );
}

function VerifyScreen({ email, linkFailed, onVerified }: {
  email: string;
  linkFailed: boolean;
  onVerified: () => void;
}) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(
    linkFailed ? { ok: false, text: 'That verification link was invalid or had expired. Resend a fresh one below.' } : null,
  );
  const [cooling, setCooling] = useState(false);
  const [busy, setBusy] = useState(false);

  const recheck = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/me');
      const j = await r.json().catch(() => ({})) as { verified?: boolean };
      if (r.ok && j.verified) { onVerified(); return; }
      setNote({ ok: false, text: 'Not verified yet. Open the link from the email, then try again.' });
    } catch {
      setNote({ ok: false, text: 'network error, try again' });
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (cooling) return;
    setCooling(true);
    window.setTimeout(() => setCooling(false), 60_000);
    try {
      await fetch('/api/auth/resend', { method: 'POST' });
      setNote({ ok: true, text: 'Sent. Give it a minute, and check the spam folder too.' });
    } catch {
      setNote({ ok: false, text: 'network error, try again' });
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card panel fade-up">
        <span className="auth-mark" />
        <h1 className="auth-title">Check your inbox</h1>
        <p className="auth-tagline">
          We sent a verification link to <strong>{email}</strong>. Click it to unlock the agent, then continue here.
        </p>
        {note && <div className={note.ok ? 'auth-ok' : 'auth-error'}>{note.text}</div>}
        <button className="btn btn-primary auth-submit" onClick={() => void recheck()} disabled={busy}>
          {busy ? 'One moment…' : 'I clicked the link, continue'}
        </button>
        <button className="auth-switch mono" onClick={() => void resend()} disabled={cooling}>
          {cooling ? 'Email sent, wait a minute to resend' : 'Resend the email'}
        </button>
        <button
          className="auth-switch mono"
          onClick={() => { void fetch('/api/auth/logout', { method: 'POST' }).then(() => location.reload()); }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const pushTimer = useRef<number | null>(null);
  const authParams = useRef(readAuthParams());

  const check = useCallback(async () => {
    // A reset link outranks any live session: the gate opens on the
    // new-password form and the token is consumed exactly once.
    if (authParams.current.reset) { setPhase({ kind: 'gate' }); return; }
    try {
      const r = await fetch('/api/me');
      if (!(r.headers.get('content-type') ?? '').includes('json')) { setPhase({ kind: 'open' }); return; }
      const j = await r.json() as { auth?: boolean; email?: string; verified?: boolean; quota?: { used: number; limit: number } };
      if (j.auth === false) { setPhase({ kind: 'open' }); return; }
      if (r.ok && j.email) {
        if (j.verified === false) { setPhase({ kind: 'verify', email: j.email }); return; }
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
  if (phase.kind === 'gate') {
    return (
      <AuthScreen
        onSignedIn={() => void check()}
        resetToken={authParams.current.reset}
        initialNotice={
          authParams.current.verified === '1'
            ? { ok: true, text: 'Email verified. Sign in to continue.' }
            : authParams.current.verified === '0'
              ? { ok: false, text: 'That verification link was invalid or had expired. Sign in to resend one.' }
              : undefined
        }
        onResetConsumed={() => { authParams.current.reset = undefined; }}
      />
    );
  }
  if (phase.kind === 'verify') {
    return (
      <VerifyScreen
        email={phase.email}
        linkFailed={authParams.current.verified === '0'}
        onVerified={() => void check()}
      />
    );
  }
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
