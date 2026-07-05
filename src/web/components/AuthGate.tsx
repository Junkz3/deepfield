// Account gate for multi-user deployments (AUTH_ENABLED=1 on the VM).
// On open deployments (dev server, no auth configured) it renders nothing
// but the app. When auth is on: sign in or create an account, verify the
// email (the agent stays locked until then), the per-user server store
// rehydrates the workspaces, and a quota chip shows the daily budget.
// Password reset rides the same gate: /?reset=<token> from the email.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GalaxyGlyph } from './Sidebar';
import { Turnstile } from './Turnstile';
import './auth.css';

// Public Turnstile sitekey, baked in at build time. Empty = captcha disabled
// (dev, or a deployment that opts out); the server enforces the matching side.
const TURNSTILE_SITEKEY = (import.meta.env as Record<string, string | undefined>).VITE_TURNSTILE_SITEKEY;

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

/** Serialize the local store for the server mirror, or null when there is
 *  nothing worth saving. Returning null (never an empty payload) is the safety
 *  latch: a stray flush - a pagehide firing right after the store was cleared,
 *  a boot before hydration - must NOT overwrite the account's server backup
 *  with emptiness. An empty store means "nothing to back up yet", never
 *  "erase what the server holds". */
function collectLocalStore(): string | null {
  const conversations: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k === STORE_KEYS_PREFIX || k.startsWith(`${STORE_KEYS_PREFIX}.`))) {
      try { conversations[k] = JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { /* skip */ }
    }
  }
  let workspaces: unknown[] = [];
  try { const w = JSON.parse(localStorage.getItem(WS_KEY) ?? '[]'); if (Array.isArray(w)) workspaces = w; } catch { /* skip */ }
  const hasConversations = Object.values(conversations).some((v) => Array.isArray(v) && v.length > 0);
  if (!hasConversations && workspaces.length === 0) return null;
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
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0); // bump to remount the widget

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
      const r = await post(`/api/auth/${mode}`, { email, password, turnstileToken: captchaToken });
      if (!r.ok) {
        setError(r.error ?? `${mode} failed`);
        setCaptchaToken(null);
        setCaptchaNonce((n) => n + 1); // token is single-use: force a fresh challenge
        return;
      }
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
  const showCaptcha = Boolean(TURNSTILE_SITEKEY) && (mode === 'login' || mode === 'signup');
  const canSubmit = (!showEmail || email.length > 0) && (!showPassword || password.length > 0)
    && (!showCaptcha || Boolean(captchaToken));

  return (
    <div className="auth-screen">
      <div className="auth-card panel fade-up">
        <span className="auth-mark"><GalaxyGlyph size={26} /></span>
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
        {showCaptcha && (
          <Turnstile
            key={captchaNonce}
            sitekey={TURNSTILE_SITEKEY as string}
            onToken={setCaptchaToken}
            onClear={() => setCaptchaToken(null)}
          />
        )}
        {error && <div className="auth-error">{error}</div>}
        {notice && <div className={notice.ok ? 'auth-ok' : 'auth-error'}>{notice.text}</div>}
        <button className="btn btn-primary auth-submit" onClick={() => void submit()} disabled={busy || !canSubmit}>
          {busy ? 'One moment…' : submitLabels[mode]}
        </button>
        {(mode === 'login' || mode === 'signup') && (
          <button
            className="auth-switch mono"
            onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setNotice(null); }}
          >
            {mode === 'login'
              ? <>No account yet? Create one<span className="auth-free-tag">Free</span></>
              : 'Already registered? Sign in'}
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
        <p className="auth-note mono">
          <strong>Free</strong> and fully functional. A daily per-account budget and a shared
          global cap keep this public demo within its inference limits.
        </p>
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
        <span className="auth-mark"><GalaxyGlyph size={26} /></span>
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
  // Server-mirror health: 'error' means the server rejected the store (over
  // its size cap), so local changes are NOT being backed up: worth surfacing.
  // 'offline' is a transient network blip and stays silent.
  const [syncState, setSyncState] = useState<'ok' | 'offline' | 'error' | null>(null);
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

  // Signed in: mirror the local store to the private per-account server store.
  // Event-driven and debounced so a new conversation lands in ~1.5s instead of
  // waiting up to 20s; a periodic tick and a keepalive flush on pagehide are
  // the safety net. Your conversations follow your account across browsers.
  useEffect(() => {
    if (phase.kind !== 'in') return;
    let inFlight = false;
    let dirtyWhileInFlight = false;
    let debounce: number | null = null;

    const flush = async () => {
      // Coalesce: never overlap PUTs. A change arriving mid-flight re-arms the
      // debounce from the finally block, so nothing is dropped.
      if (inFlight) { dirtyWhileInFlight = true; return; }
      const body = collectLocalStore();
      if (body === null) return; // empty store: never overwrite the server backup
      inFlight = true;
      try {
        const r = await fetch('/api/me/store', { method: 'PUT', body });
        // A non-ok status (store over the size cap -> 400/500) does NOT reject
        // a fetch, so it would otherwise pass silently. Surface it instead.
        setSyncState(r.ok ? 'ok' : 'error');
      } catch {
        setSyncState('offline'); // network blip: transient, the next tick retries
      } finally {
        inFlight = false;
        if (dirtyWhileInFlight) { dirtyWhileInFlight = false; schedule(); }
      }
    };

    const schedule = () => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { debounce = null; void flush(); }, 1500);
    };

    const onDirty = () => schedule();
    // Best-effort flush when the tab goes away. keepalive lets the request
    // outlive the page (unlike a plain fetch on beforeunload); it is capped at
    // ~64KB by the browser, but the debounced flush above has almost certainly
    // already synced the latest change.
    const onPageHide = () => {
      const body = collectLocalStore();
      if (body === null) return; // empty store: never overwrite the server backup
      try {
        void fetch('/api/me/store', { method: 'PUT', body, keepalive: true });
      } catch { /* nothing more we can do at unload */ }
    };

    window.addEventListener('rc:store-dirty', onDirty);
    window.addEventListener('pagehide', onPageHide);
    const iv = window.setInterval(() => void flush(), 20_000);
    return () => {
      window.removeEventListener('rc:store-dirty', onDirty);
      window.removeEventListener('pagehide', onPageHide);
      window.clearInterval(iv);
      if (debounce !== null) window.clearTimeout(debounce);
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
          {syncState === 'error' && (
            <span
              className="auth-chip-sync"
              title="Server backup paused: this account's store is over its size limit. Recent changes are saved on this device only."
            >
              sync paused
            </span>
          )}
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
