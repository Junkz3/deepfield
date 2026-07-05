// Production monitor for the VM. Runs on a systemd timer (every ~10 min),
// reads the account store read-only, and mails the operator about signups,
// brute-force lockouts, quota pressure, service health, and a daily digest.
// Zero npm dependencies: it reuses the same SMTP client as the app server.
//
//   MONITOR_EMAIL=you@example.com SMTP_HOST=... node deploy/monitor.mjs
//
// State lives in data/monitor-state.json so nothing is ever mailed twice. The
// very first run seeds that baseline silently (no "N new signups" for accounts
// that already existed).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from './mailer.mjs';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const USERS_PATH = join(DATA_DIR, 'users.json');
const STATE_PATH = join(DATA_DIR, 'monitor-state.json');

const MONITOR_EMAIL = process.env.MONITOR_EMAIL;
const ORIGIN = process.env.APP_ORIGIN ?? 'https://deepfield.repairmind.io';
const GLOBAL_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 5000);
const QUOTA_ALERT_PCT = Number(process.env.MONITOR_QUOTA_PCT ?? 80);
const SIGNUP_SPIKE = Number(process.env.MONITOR_SIGNUP_SPIKE ?? 5); // new accounts in one run
const DIGEST_HOUR = Number(process.env.MONITOR_DIGEST_HOUR ?? 8);   // UTC hour for the daily digest
const HEALTH_STREAK = 2; // consecutive failures before alerting (anti-flapping)
const SERVER_URL = process.env.MONITOR_SERVER_URL ?? 'http://127.0.0.1:8080';
const RELAY_URL = process.env.MONITOR_RELAY_URL ?? 'http://127.0.0.1:8123';

const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 465),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.MAIL_FROM ?? 'noreply@repairmind.io',
  fromName: 'Deepfield Monitor',
};

const day = (now) => new Date(now).toISOString().slice(0, 10);

/** Stats for the daily digest, derived purely from the account store. */
export function buildStats(db, now) {
  const d = day(now);
  const users = Object.entries(db.users ?? {}).map(([email, u]) => ({ email, ...u }));
  const usage = db.usage ?? {};
  return {
    day: d,
    accounts: users.length,
    verified: users.filter((u) => u.verified === true).length,
    newToday: users.filter((u) => String(u.createdAt ?? '').slice(0, 10) === d).length,
    requestsToday: usage[`global:${d}`] ?? 0,
    globalLimit: GLOBAL_LIMIT,
    lockedNow: users.filter((u) => (u.lock?.until ?? 0) > now).length,
    sessions: Object.keys(db.sessions ?? {}).length,
  };
}

/**
 * Pure event detection: given the previous monitor state, the current account
 * store and the clock, return the events to mail and the state to persist.
 * `prev === null` means first run: seed the baseline, emit nothing.
 */
export function computeEvents(prev, db, now) {
  const d = day(now);
  const users = Object.entries(db.users ?? {}).map(([email, u]) => ({ email, ...u }));
  const currentIds = users.map((u) => u.id);
  const lockedNow = {};
  for (const u of users) if ((u.lock?.until ?? 0) > now) lockedNow[u.id] = u.lock.until;

  const nextState = {
    knownUserIds: currentIds,
    notifiedLocks: lockedNow,
    quotaAlertedDay: prev?.quotaAlertedDay,
    lastDigestDay: prev?.lastDigestDay,
    health: prev?.health ?? { serverStreak: 0, relayStreak: 0, serverDown: false, relayDown: false },
  };

  if (!prev) return { events: [], nextState }; // first run: baseline only

  const events = [];
  const known = new Set(prev.knownUserIds ?? []);
  const newUsers = users.filter((u) => !known.has(u.id));
  if (newUsers.length) events.push({ type: 'signup', users: newUsers });
  if (newUsers.length >= SIGNUP_SPIKE) events.push({ type: 'signup-spike', count: newUsers.length });

  const prevLocks = prev.notifiedLocks ?? {};
  const freshLocks = users.filter((u) => lockedNow[u.id] && prevLocks[u.id] !== lockedNow[u.id]);
  if (freshLocks.length) events.push({ type: 'lockout', users: freshLocks });

  const globalUsed = (db.usage ?? {})[`global:${d}`] ?? 0;
  if (globalUsed >= (GLOBAL_LIMIT * QUOTA_ALERT_PCT) / 100 && prev.quotaAlertedDay !== d) {
    events.push({ type: 'quota', used: globalUsed, limit: GLOBAL_LIMIT });
    nextState.quotaAlertedDay = d;
  }

  if (prev.lastDigestDay !== d && new Date(now).getUTCHours() >= DIGEST_HOUR) {
    events.push({ type: 'digest', stats: buildStats(db, now) });
    nextState.lastDigestDay = d;
  }

  return { events, nextState };
}

/** Ping a URL; any answer under 500 counts as "up" (401 from /api/me is fine). */
async function ping(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/** Update the health block in nextState and return transition events. */
async function healthEvents(nextState) {
  const [server, relay] = await Promise.all([ping(`${SERVER_URL}/api/me`), ping(`${RELAY_URL}/health`)]);
  const h = nextState.health;
  const out = [];
  for (const [name, ok, streakKey, downKey, label] of [
    [server, server, 'serverStreak', 'serverDown', 'web server'],
    [relay, relay, 'relayStreak', 'relayDown', 'speech relay'],
  ]) {
    h[streakKey] = ok ? 0 : (h[streakKey] ?? 0) + 1;
    if (!ok && h[streakKey] >= HEALTH_STREAK && !h[downKey]) {
      h[downKey] = true;
      out.push({ type: 'down', label });
    } else if (ok && h[downKey]) {
      h[downKey] = false;
      out.push({ type: 'up', label });
    }
  }
  return out;
}

/** Render one event to a plain-text mail. */
function render(ev) {
  switch (ev.type) {
    case 'signup':
      return {
        subject: `[Deepfield] ${ev.users.length} new signup${ev.users.length > 1 ? 's' : ''}`,
        text: `New account${ev.users.length > 1 ? 's' : ''} on ${ORIGIN}:\n\n`
          + ev.users.map((u) => `  ${u.email}  (${u.verified ? 'verified' : 'unverified'}, created ${u.createdAt ?? '?'})`).join('\n')
          + '\n',
      };
    case 'signup-spike':
      return {
        subject: `[Deepfield] Possible signup spam: ${ev.count} accounts at once`,
        text: `${ev.count} accounts were created within a single 10-minute window on ${ORIGIN}.\nThis may be automated signup abuse. The captcha and per-account lockout are active; review recent accounts.\n`,
      };
    case 'lockout':
      return {
        subject: `[Deepfield] Security: ${ev.users.length} account${ev.users.length > 1 ? 's' : ''} locked (brute-force)`,
        text: `These accounts hit the login-failure lockout (repeated wrong passwords):\n\n`
          + ev.users.map((u) => `  ${u.email}  (locked until ${new Date(u.lock.until).toISOString()})`).join('\n')
          + `\n\nThis is the brute-force protection doing its job; no action needed unless you see many.\n`,
      };
    case 'quota':
      return {
        subject: `[Deepfield] Global inference budget at ${Math.round((ev.used / ev.limit) * 100)}%`,
        text: `Today's shared inference budget is at ${ev.used}/${ev.limit} calls on ${ORIGIN}.\nOnce it is exhausted, the agent returns "come back tomorrow" to everyone until the daily reset.\n`,
      };
    case 'down':
      return {
        subject: `[Deepfield] ALERT: ${ev.label} is down`,
        text: `The ${ev.label} did not respond on ${HEALTH_STREAK} consecutive checks (${ORIGIN}).\nCheck the VM: systemctl status repaircenter tts-relay\n`,
      };
    case 'up':
      return {
        subject: `[Deepfield] Recovered: ${ev.label} is back`,
        text: `The ${ev.label} is responding again (${ORIGIN}).\n`,
      };
    case 'digest': {
      const s = ev.stats;
      return {
        subject: `[Deepfield] Daily report ${s.day}`,
        text: `Deepfield daily report for ${s.day} (${ORIGIN})\n\n`
          + `  Accounts total     ${s.accounts}  (${s.verified} verified)\n`
          + `  New today          ${s.newToday}\n`
          + `  Requests today     ${s.requestsToday} / ${s.globalLimit} global budget\n`
          + `  Locked right now   ${s.lockedNow}\n`
          + `  Active sessions    ${s.sessions}\n`,
      };
    }
    default:
      return null;
  }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeState(state) {
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_PATH);
}

async function main() {
  if (!MONITOR_EMAIL) { console.error('MONITOR_EMAIL not set: nothing to notify, exiting'); return; }
  if (!SMTP.host || !SMTP.user || !SMTP.pass) { console.error('SMTP_* not set: cannot send mail, exiting'); return; }

  const db = readJson(USERS_PATH, { users: {}, usage: {}, sessions: {} });
  const prev = readJson(STATE_PATH, null);
  const now = Date.now();

  const { events, nextState } = computeEvents(prev, db, now);
  const health = await healthEvents(nextState);
  const all = [...events, ...health];

  for (const ev of all) {
    const msg = render(ev);
    if (!msg) continue;
    try {
      await sendMail(/** @type {any} */ (SMTP), { to: MONITOR_EMAIL, ...msg });
      console.log(`mailed: ${msg.subject}`);
    } catch (e) {
      console.error(`monitor mail failed (${ev.type}):`, e instanceof Error ? e.message : e);
    }
  }

  writeState(nextState);
  if (!all.length) console.log('monitor: nothing to report');
}

// Only run when executed directly, so tests can import the pure functions.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('monitor crashed:', e); process.exit(1); });
}
