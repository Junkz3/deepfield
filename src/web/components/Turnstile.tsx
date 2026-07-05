// Cloudflare Turnstile widget for the auth screen. Renders only where a sitekey
// is configured (VITE_TURNSTILE_SITEKEY); the parent decides whether to show it.
// The token is single-use, so the parent remounts this component (via a `key`)
// after a failed submit to force a fresh challenge.
import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
const api = (): TurnstileApi | undefined =>
  (window as unknown as { turnstile?: TurnstileApi }).turnstile;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<void> | null = null;

/** Load the Turnstile script once, shared across mounts. */
function loadScript(): Promise<void> {
  if (api()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('turnstile blocked')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function Turnstile({ sitekey, onToken, onClear }: {
  sitekey: string;
  onToken: (token: string) => void;
  onClear: () => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  // Latest callbacks without re-rendering the widget (which would reset it).
  const cbs = useRef({ onToken, onClear });
  cbs.current = { onToken, onClear };

  useEffect(() => {
    let cancelled = false;
    loadScript().then(() => {
      const ts = api();
      if (cancelled || !ts || !container.current) return;
      widgetId.current = ts.render(container.current, {
        sitekey,
        theme: 'dark',
        callback: (t: string) => cbs.current.onToken(t),
        'expired-callback': () => cbs.current.onClear(),
        'error-callback': () => cbs.current.onClear(),
      });
    }).catch(() => { /* script blocked: the server still gates, this just won't help */ });
    return () => {
      cancelled = true;
      const ts = api();
      if (widgetId.current && ts) { try { ts.remove(widgetId.current); } catch { /* already gone */ } }
      widgetId.current = null;
    };
  }, [sitekey]);

  return <div ref={container} className="auth-turnstile" />;
}
