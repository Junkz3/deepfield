// Production server for a plain VM: serves the static build and proxies the
// agent API to Vultr Serverless Inference. Zero npm dependencies.
// The API key stays on the server; the browser only ever talks to /api/agent.
//
//   VULTR_INFERENCE_API_KEY=... VULTR_BASE_URL=https://api.vultrinference.com/v1 \
//   node deploy/server.mjs   (PORT=8080 by default, serves ./dist)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AuthStore, clearSessionCookie, parseCookies, sessionCookie, STORE_MAX_BYTES } from './auth.mjs';
import { sendMail } from './mailer.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = process.env.DIST ?? 'dist';
const KEY = process.env.VULTR_INFERENCE_API_KEY;
const BASE = process.env.VULTR_BASE_URL ?? 'https://api.vultrinference.com/v1';
// Optional private-demo lock: when set, inference requires the access key
// (the app forwards ?key=<token> from its URL). Static pages stay public,
// credits do not.
const DEMO_TOKEN = process.env.DEMO_TOKEN;
// Optional Cloudflare Turnstile on signup/login. When TURNSTILE_SECRET is set,
// both endpoints require a widget token verified server-side; unset = no captcha
// (dev, or a deployment that opts out). The sitekey is public and lives in the
// client build (VITE_TURNSTILE_SITEKEY); only the secret stays here.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
// Multi-user mode: AUTH_ENABLED=1 turns on signup/login, per-user stores
// and per-account daily inference quotas. Anyone can register and test,
// nobody can drain the Vultr credits.
const AUTH_ENABLED = process.env.AUTH_ENABLED === '1';
const auth = AUTH_ENABLED
  ? new AuthStore(process.env.DATA_DIR ?? './data', {
    userDailyLimit: Number(process.env.USER_DAILY_LIMIT ?? 150),
    globalDailyLimit: Number(process.env.GLOBAL_DAILY_LIMIT ?? 5000),
  })
  : null;
if (!KEY) { console.error('VULTR_INFERENCE_API_KEY is required'); process.exit(1); }

// Transactional mail (email verification, password reset) rides the SMTP
// submission port of an existing relay; SPF/DKIM/DMARC live there. Without
// SMTP configured, signups are auto-verified so a bare deployment still works.
const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 465),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.MAIL_FROM ?? 'noreply@repairmind.io',
  fromName: 'Deepfield',
};
const MAIL_ENABLED = Boolean(SMTP.host && SMTP.user && SMTP.pass);
const ORIGIN = process.env.APP_ORIGIN ?? 'https://deepfield.repairmind.io';
if (AUTH_ENABLED && !MAIL_ENABLED) console.warn('SMTP_* not set: signups will be auto-verified, password reset disabled');

// The HTML alternative mirrors the app's dark control-room look (tokens.css
// values inlined; email clients ignore stylesheets). The plain-text part is
// the source of truth and must stay complete on its own.
function authEmailHtml({ heading, body, cta, url, note }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background-color:#0b0f14;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0f14;padding:36px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background-color:#11161d;border:1px solid #232c37;border-radius:12px;"><tr><td style="padding:36px 40px;font-family:Arial,Helvetica,sans-serif;">
<img src="${ORIGIN}/logo-email.png" width="28" height="28" alt="Deepfield" style="display:block;border:0;">
<h1 style="margin:16px 0 4px;font-size:22px;line-height:1.2;color:#dee7ef;">Deepfield</h1>
<p style="margin:0 0 24px;font-size:11px;color:#6e7d8d;letter-spacing:0.12em;">DOCUMENT-UNIVERSE WORKSPACES</p>
<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#dee7ef;">${heading}</p>
<p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#8b99a8;">${body}</p>
<a href="${url}" style="display:inline-block;background-color:#ffb454;color:#0b0f14;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 26px;border-radius:8px;">${cta}</a>
<p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#6e7d8d;">Or paste this link into your browser:<br>
<a href="${url}" style="color:#ffb454;text-decoration:none;word-break:break-all;">${url}</a></p>
<p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6e7d8d;">${note}</p>
</td></tr></table>
<p style="margin:20px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#4d5a68;">Deepfield, the agent that shows its evidence. Sent from ${ORIGIN.replace(/^https?:\/\//, '')}</p>
</td></tr></table>
</body></html>`;
}

async function sendAuthMail(kind, to, token) {
  const msg = kind === 'verify'
    ? {
      to,
      subject: 'Verify your email for Deepfield',
      text: `Welcome to Deepfield.\n\nConfirm this email address to unlock the agent on your account:\n\n  ${ORIGIN}/api/auth/verify?token=${token}\n\nThe link is valid for 24 hours. If you did not create this account, you can ignore this message.\n`,
      html: authEmailHtml({
        heading: 'Welcome to Deepfield.',
        body: 'Confirm this email address to unlock the agent on your account.',
        cta: 'Verify email',
        url: `${ORIGIN}/api/auth/verify?token=${token}`,
        note: 'The link is valid for 24 hours. If you did not create this account, you can ignore this message.',
      }),
    }
    : {
      to,
      subject: 'Reset your Deepfield password',
      text: `Someone asked to reset the password for this Deepfield account.\n\nSet a new password here:\n\n  ${ORIGIN}/?reset=${token}\n\nThe link is valid for 1 hour and works once. If this was not you, you can ignore this message: your password is unchanged.\n`,
      html: authEmailHtml({
        heading: 'Password reset requested.',
        body: 'Someone asked to reset the password for this Deepfield account. If this was you, set a new password below.',
        cta: 'Set new password',
        url: `${ORIGIN}/?reset=${token}`,
        note: 'The link is valid for 1 hour and works once. If this was not you, you can ignore this message: your password is unchanged.',
      }),
    };
  try {
    await sendMail(/** @type {any} */ (SMTP), msg);
    return true;
  } catch (e) {
    console.error(`mail ${kind} to ${to} failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const ALLOWED_PATHS = new Set(['/chat/completions', '/rerank', '/audio/speech']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
};

// Fixed-window rate limit per IP, mirrors functions/api/agent.ts.
const WINDOW_MS = 60_000, MAX_PER_WINDOW = 60;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip) ?? { start: now, n: 0 };
  if (now - h.start > WINDOW_MS) { h.start = now; h.n = 0; }
  h.n += 1;
  hits.set(ip, h);
  return h.n > MAX_PER_WINDOW;
}

async function readRaw(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const readBody = async (req, limit) => (await readRaw(req, limit)).toString('utf8');

// Verify a Turnstile token with Cloudflare. Fails closed: a missing token or an
// unreachable verifier both return false, so a captcha-gated endpoint never
// opens on error. Returns true immediately when the feature is off.
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || token.length === 0) return false;
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip && ip !== 'unknown') form.set('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// Speech relay (tools/tts-relay) listens on localhost only; the browser talks
// same-origin HTTPS here, so phones get the mic and NVIDIA voice too. Relay
// down = instant 502: the app hides the mic and TTS falls back to Vultr.
const RELAY_BASE = process.env.RELAY_URL ?? 'http://127.0.0.1:8123';
const RELAY_PATHS = new Set(['/health', '/tts', '/asr']);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const ip = req.socket.remoteAddress ?? 'unknown';
    const sessionUser = auth ? auth.verifySession(parseCookies(req.headers.cookie).rc_session) : null;

    // --- accounts (only when AUTH_ENABLED=1) ---
    if (auth && url.pathname.startsWith('/api/auth/') && req.method === 'POST') {
      if (limited(ip)) { json(res, 429, { error: 'rate limited' }); return; }
      const secure = req.headers['x-forwarded-proto'] === 'https';
      let payload = {};
      try { payload = JSON.parse(await readBody(req, 64 * 1024)); } catch { /* empty body is fine for logout */ }
      if (url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login') {
        if (!(await verifyTurnstile(payload.turnstileToken, ip))) {
          json(res, 403, { error: 'captcha check failed, please try again' });
          return;
        }
        const r = url.pathname === '/api/auth/signup'
          ? auth.signup(payload.email, payload.password)
          : auth.login(payload.email, payload.password);
        if (!r.ok) { json(res, r.code, { error: r.error }); return; }
        const email = String(payload.email).trim().toLowerCase();
        if ('verifyToken' in r) {
          // Fresh signup: prove the mailbox before the agent unlocks. With no
          // relay configured the account is usable right away instead.
          if (MAIL_ENABLED) await sendAuthMail('verify', email, r.verifyToken);
          else auth.verifyEmail(r.verifyToken);
        }
        json(res, 200, { email, verified: auth.infoOf(r.userId)?.verified === true }, {
          'set-cookie': sessionCookie(auth.issueSession(r.userId), secure),
        });
        return;
      }
      if (url.pathname === '/api/auth/logout') {
        auth.revokeSession(parseCookies(req.headers.cookie).rc_session);
        json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie });
        return;
      }
      if (url.pathname === '/api/auth/resend') {
        if (!sessionUser) { json(res, 401, { error: 'sign in first' }); return; }
        const info = auth.infoOf(sessionUser);
        if (!info) { json(res, 401, { error: 'sign in first' }); return; }
        if (info.verified) { json(res, 200, { ok: true, verified: true }); return; }
        const token = auth.issueVerifyToken(sessionUser);
        // No token means the cooldown is active; the mail already went out.
        if (token && MAIL_ENABLED) await sendAuthMail('verify', info.email, token);
        json(res, 200, { ok: true, verified: false });
        return;
      }
      if (url.pathname === '/api/auth/request-reset') {
        // Always 200 so responses never reveal whether an account exists.
        const token = auth.issueResetToken(payload.email);
        if (token && MAIL_ENABLED) {
          await sendAuthMail('reset', String(payload.email).trim().toLowerCase(), token);
        }
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/auth/reset') {
        const r = auth.resetPassword(payload.token, payload.password);
        if (!r.ok) { json(res, r.code, { error: r.error }); return; }
        json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie });
        return;
      }
      json(res, 404, { error: 'unknown auth endpoint' });
      return;
    }

    // The link in the verification email lands here, then back in the app.
    if (auth && url.pathname === '/api/auth/verify' && req.method === 'GET') {
      if (limited(ip)) { json(res, 429, { error: 'rate limited' }); return; }
      const r = auth.verifyEmail(url.searchParams.get('token') ?? '');
      res.writeHead(302, { location: r.ok ? '/?verified=1' : '/?verified=0' });
      res.end();
      return;
    }

    if (url.pathname === '/api/me' && req.method === 'GET') {
      if (!auth) { json(res, 200, { auth: false }); return; }
      const info = sessionUser ? auth.infoOf(sessionUser) : null;
      if (!info) { json(res, 401, { auth: true }); return; }
      json(res, 200, { auth: true, email: info.email, verified: info.verified, quota: auth.usageOf(sessionUser) });
      return;
    }

    if (auth && url.pathname === '/api/me/store') {
      if (!sessionUser) { json(res, 401, { error: 'sign in first' }); return; }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(auth.readStore(sessionUser));
        return;
      }
      if (req.method === 'PUT') {
        const r = auth.writeStore(sessionUser, await readBody(req, STORE_MAX_BYTES + 1024));
        json(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/agent') {
      if (limited(ip)) { res.writeHead(429).end('rate limited'); return; }
      const { path, body, token } = JSON.parse(await readBody(req));
      if (auth) {
        // Signed-in, email-verified users only, inside their daily budget.
        if (!sessionUser) { json(res, 401, { error: 'sign in to use the agent' }); return; }
        if (auth.infoOf(sessionUser)?.verified !== true) {
          json(res, 403, { error: 'verify your email to use the agent' });
          return;
        }
        const q = auth.consume(sessionUser);
        if (!q.allowed) { json(res, 429, { error: q.reason }); return; }
      } else if (DEMO_TOKEN && token !== DEMO_TOKEN) {
        json(res, 401, { error: 'access key required: open the app with ?key=<your access key>' });
        return;
      }
      if (!ALLOWED_PATHS.has(path)) { res.writeHead(400).end('path not allowed'); return; }
      const upstream = await fetch(BASE + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Relay the upstream content-type and raw bytes: /audio/speech streams
      // binary audio, so text() + a forced application/json would corrupt it.
      // JSON paths (/chat/completions, /rerank) pass through byte-identical.
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    if (url.pathname.startsWith('/relay/')) {
      const sub = url.pathname.slice('/relay'.length);
      if (!RELAY_PATHS.has(sub)) { res.writeHead(404).end(); return; }
      if (limited(`relay:${ip}`)) { res.writeHead(429).end('rate limited'); return; }
      try {
        const upstream = await fetch(RELAY_BASE + sub + url.search, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
          body: req.method === 'POST' ? await readRaw(req, 12 * 1024 * 1024) : undefined,
          signal: AbortSignal.timeout(40_000),
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.writeHead(502).end('speech relay unavailable');
      }
      return;
    }

    // Static files with SPA fallback.
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(normalize(DIST))) { res.writeHead(403).end(); return; }
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(DIST, 'index.html');
    }
    const data = await readFile(file);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400',
    };
    // Full-corpus docs.json is tens of MB of text: gzip compressible types.
    const compressible = /json|javascript|text|svg/.test(type);
    if (compressible && (req.headers['accept-encoding'] ?? '').includes('gzip')) {
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip' });
      res.end(gzipSync(data));
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch (e) {
    res.writeHead(500).end(`server error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
});

server.listen(PORT, () => console.log(`Deepfield serving ${DIST} on :${PORT}`));
