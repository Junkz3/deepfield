// Accounts, sessions, per-user stores and inference quotas for the VM
// server. Zero npm dependencies: node:crypto scrypt for passwords, HMAC
// signed cookies for sessions, atomic JSON files on disk for persistence.
// Enterprise posture, hackathon scale: no email verification or password
// reset yet (documented in the README path to production).
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthStore {
  /** @param {string} dataDir @param {{userDailyLimit?: number, globalDailyLimit?: number}} [opts] */
  constructor(dataDir, opts = {}) {
    this.dir = dataDir;
    this.userDailyLimit = opts.userDailyLimit ?? 150;
    this.globalDailyLimit = opts.globalDailyLimit ?? 5000;
    mkdirSync(join(dataDir, 'stores'), { recursive: true });
    this.dbPath = join(dataDir, 'users.json');
    try {
      this.db = JSON.parse(readFileSync(this.dbPath, 'utf8'));
    } catch {
      this.db = { users: {}, usage: {} };
    }
    const secretPath = join(dataDir, 'session-secret');
    try {
      this.secret = readFileSync(secretPath, 'utf8').trim();
    } catch {
      this.secret = randomBytes(32).toString('hex');
      writeFileSync(secretPath, this.secret, { mode: 0o600 });
    }
  }

  save() {
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.dbPath);
  }

  /** @returns {{ok: true, userId: string} | {ok: false, error: string, code: number}} */
  signup(email, password) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, error: 'a valid email is required', code: 400 };
    if (typeof password !== 'string' || password.length < 8) {
      return { ok: false, error: 'password must be at least 8 characters', code: 400 };
    }
    if (this.db.users[e]) return { ok: false, error: 'an account already exists for this email', code: 409 };
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    const userId = randomBytes(12).toString('hex');
    this.db.users[e] = { id: userId, salt, hash, createdAt: new Date().toISOString() };
    this.save();
    return { ok: true, userId };
  }

  /** @returns {{ok: true, userId: string} | {ok: false, error: string, code: number}} */
  login(email, password) {
    const e = String(email ?? '').trim().toLowerCase();
    const u = this.db.users[e];
    if (!u || typeof password !== 'string') return { ok: false, error: 'unknown email or wrong password', code: 401 };
    const hash = scryptSync(password, u.salt, 64);
    const stored = Buffer.from(u.hash, 'hex');
    if (hash.length !== stored.length || !timingSafeEqual(hash, stored)) {
      return { ok: false, error: 'unknown email or wrong password', code: 401 };
    }
    return { ok: true, userId: u.id };
  }

  emailOf(userId) {
    return Object.keys(this.db.users).find((e) => this.db.users[e].id === userId) ?? null;
  }

  // --- sessions: value = userId.expiryMs.hmac(userId.expiryMs) ---

  issueSession(userId) {
    const exp = Date.now() + SESSION_TTL_MS;
    const payload = `${userId}.${exp}`;
    const sig = createHmac('sha256', this.secret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }

  /** @returns {string | null} userId */
  verifySession(cookieValue) {
    if (typeof cookieValue !== 'string') return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 3) return null;
    const [userId, expStr, sig] = parts;
    const payload = `${userId}.${expStr}`;
    const expect = createHmac('sha256', this.secret).update(payload).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(expStr) < Date.now()) return null;
    return userId;
  }

  // --- inference quotas: per user per day, plus a global daily ceiling ---

  /** @returns {{allowed: boolean, used: number, limit: number, reason?: string}} */
  consume(userId) {
    const day = new Date().toISOString().slice(0, 10);
    const userKey = `${userId}:${day}`;
    const globalKey = `global:${day}`;
    const used = this.db.usage[userKey] ?? 0;
    const globalUsed = this.db.usage[globalKey] ?? 0;
    if (globalUsed >= this.globalDailyLimit) {
      return { allowed: false, used, limit: this.userDailyLimit, reason: 'the shared daily inference budget is exhausted, come back tomorrow' };
    }
    if (used >= this.userDailyLimit) {
      return { allowed: false, used, limit: this.userDailyLimit, reason: `daily limit reached (${this.userDailyLimit} inference calls per account)` };
    }
    this.db.usage[userKey] = used + 1;
    this.db.usage[globalKey] = globalUsed + 1;
    this.save();
    return { allowed: true, used: used + 1, limit: this.userDailyLimit };
  }

  usageOf(userId) {
    const day = new Date().toISOString().slice(0, 10);
    return { used: this.db.usage[`${userId}:${day}`] ?? 0, limit: this.userDailyLimit };
  }

  // --- per-user store: the light workspace manifest, size-capped ---

  storePath(userId) {
    return join(this.dir, 'stores', `${userId.replace(/[^a-z0-9]/gi, '')}.json`);
  }

  readStore(userId) {
    try {
      return readFileSync(this.storePath(userId), 'utf8');
    } catch {
      return '{}';
    }
  }

  /** @returns {{ok: boolean, error?: string}} */
  writeStore(userId, raw) {
    if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return { ok: false, error: 'store too large (2 MB cap)' };
    try { JSON.parse(raw); } catch { return { ok: false, error: 'store must be valid JSON' }; }
    const p = this.storePath(userId);
    writeFileSync(`${p}.tmp`, raw);
    renameSync(`${p}.tmp`, p);
    return { ok: true };
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, secure) {
  return `rc_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export const clearSessionCookie = 'rc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
