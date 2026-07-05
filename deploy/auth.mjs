// Accounts, sessions, per-user stores and inference quotas for the VM
// server. Zero npm dependencies: node:crypto scrypt for passwords, random
// server-side session tokens (revocable), hashed single-use email tokens
// for verification and password reset, atomic JSON files on disk.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const MAIL_COOLDOWN_MS = 60 * 1000;
// Per-account brute-force lockout, on top of the server's per-IP rate limit:
// after this many consecutive failures the account is refused for a cooldown,
// so a distributed attacker cannot grind passwords one IP at a time.
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Per-account store cap. Conversations (with attachments) grew past the old
// 2 MB ceiling and got silently rejected; 8 MB covers a heavy demo account.
// Exported so the HTTP body limit and the tests stay aligned with it.
export const STORE_MAX_BYTES = 8 * 1024 * 1024;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Fixed dummy credentials so a login for an unknown email still spends exactly
// one scrypt. Without this, "no such account" returns before hashing and "wrong
// password" returns after: the timing gap is an account-existence oracle.
const DUMMY_SALT = 'deepfield.constant.work.salt';
const DUMMY_HASH = scryptSync('x', DUMMY_SALT, 64);

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
    this.db.sessions ??= {};
    // Accounts created before email verification existed are grandfathered:
    // they proved nothing then, and locking them out now would be worse.
    for (const u of Object.values(this.db.users)) u.verified ??= true;
  }

  save() {
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.dbPath);
  }

  /** @returns {{ok: true, userId: string, verifyToken: string} | {ok: false, error: string, code: number}} */
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
    this.db.users[e] = { id: userId, salt, hash, createdAt: new Date().toISOString(), verified: false };
    const verifyToken = this.issueEmailToken(userId, 'verify', VERIFY_TTL_MS, { force: true });
    this.save();
    return { ok: true, userId, verifyToken: /** @type {string} */ (verifyToken) };
  }

  /** @returns {{ok: true, userId: string} | {ok: false, error: string, code: number}} */
  login(email, password) {
    const e = String(email ?? '').trim().toLowerCase();
    const u = this.db.users[e];
    const now = Date.now();
    // Locked out by too many recent failures: refuse without even hashing.
    if (u?.lock && u.lock.until > now) {
      return { ok: false, error: 'too many failed attempts, try again in a few minutes', code: 429 };
    }
    // Constant work: always run one scrypt, against the real record or the dummy
    // one, so an unknown email and a wrong password take the same time.
    const pw = typeof password === 'string' ? password : '';
    const salt = u ? u.salt : DUMMY_SALT;
    const expected = u ? Buffer.from(u.hash, 'hex') : DUMMY_HASH;
    const got = scryptSync(pw, salt, 64);
    const matches = got.length === expected.length && timingSafeEqual(got, expected);
    if (!u || typeof password !== 'string' || !matches) {
      if (u) this.registerFailedLogin(u, now);
      return { ok: false, error: 'unknown email or wrong password', code: 401 };
    }
    if (u.lock) { delete u.lock; this.save(); } // a good login clears the counter
    return { ok: true, userId: u.id };
  }

  /** Bump the failure counter; trip the lock (and reset the count) at the cap. */
  registerFailedLogin(u, now) {
    const lock = u.lock ?? { n: 0, until: 0 };
    lock.n += 1;
    if (lock.n >= LOGIN_MAX_FAILS) { lock.until = now + LOGIN_LOCK_MS; lock.n = 0; }
    u.lock = lock;
    this.save();
  }

  emailOf(userId) {
    return Object.keys(this.db.users).find((e) => this.db.users[e].id === userId) ?? null;
  }

  /** @returns {{email: string, verified: boolean} | null} */
  infoOf(userId) {
    const email = this.emailOf(userId);
    if (!email) return null;
    return { email, verified: this.db.users[email].verified === true };
  }

  // --- sessions: random opaque cookie, sha256(token) stored server-side.
  // Logout deletes one, a password reset deletes them all. ---

  issueSession(userId) {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.db.sessions)) {
      if (s.exp < now) delete this.db.sessions[k];
    }
    const token = randomBytes(32).toString('hex');
    this.db.sessions[sha256(token)] = { u: userId, exp: now + SESSION_TTL_MS };
    this.save();
    return token;
  }

  /** @returns {string | null} userId */
  verifySession(cookieValue) {
    if (typeof cookieValue !== 'string' || cookieValue.length < 32) return null;
    const s = this.db.sessions[sha256(cookieValue)];
    if (!s || s.exp < Date.now()) return null;
    return s.u;
  }

  revokeSession(cookieValue) {
    if (typeof cookieValue !== 'string') return;
    if (delete this.db.sessions[sha256(cookieValue)]) this.save();
  }

  revokeAllSessions(userId) {
    for (const [k, s] of Object.entries(this.db.sessions)) {
      if (s.u === userId) delete this.db.sessions[k];
    }
    this.save();
  }

  // --- email tokens: single-use, stored hashed on the user record with an
  // expiry. kind is 'verify' or 'reset'. A 60s per-account cooldown keeps
  // the resend button from turning the relay into a spam cannon. ---

  /** @returns {string | null} token, or null when cooling down */
  issueEmailToken(userId, kind, ttlMs, { force = false } = {}) {
    const email = this.emailOf(userId);
    if (!email) return null;
    const u = this.db.users[email];
    const now = Date.now();
    if (!force && now - (u.lastMailAt ?? 0) < MAIL_COOLDOWN_MS) return null;
    const token = randomBytes(32).toString('hex');
    u[kind] = { th: sha256(token), exp: now + ttlMs };
    u.lastMailAt = now;
    this.save();
    return token;
  }

  /** @returns {string | null} token, or null (no account / cooldown), never says which */
  issueResetToken(email) {
    const e = String(email ?? '').trim().toLowerCase();
    const u = this.db.users[e];
    if (!u) return null;
    return this.issueEmailToken(u.id, 'reset', RESET_TTL_MS);
  }

  issueVerifyToken(userId) {
    return this.issueEmailToken(userId, 'verify', VERIFY_TTL_MS);
  }

  /** @param {'verify' | 'reset'} kind @returns {string | null} the owning email */
  consumeEmailToken(kind, token) {
    if (typeof token !== 'string' || token.length < 32) return null;
    const th = sha256(token);
    const now = Date.now();
    for (const [email, u] of Object.entries(this.db.users)) {
      if (u[kind]?.th === th) {
        const live = u[kind].exp >= now;
        delete u[kind];
        this.save();
        return live ? email : null;
      }
    }
    return null;
  }

  /** @returns {{ok: boolean, email?: string}} */
  verifyEmail(token) {
    const email = this.consumeEmailToken('verify', token);
    if (!email) return { ok: false };
    this.db.users[email].verified = true;
    this.save();
    return { ok: true, email };
  }

  /** @returns {{ok: true, email: string} | {ok: false, error: string, code: number}} */
  resetPassword(token, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return { ok: false, error: 'password must be at least 8 characters', code: 400 };
    }
    const email = this.consumeEmailToken('reset', token);
    if (!email) return { ok: false, error: 'this reset link is invalid or has expired', code: 400 };
    const u = this.db.users[email];
    u.salt = randomBytes(16).toString('hex');
    u.hash = scryptSync(newPassword, u.salt, 64).toString('hex');
    // Owning the mailbox is the strongest proof we have: it also settles
    // verification, and every existing session dies with the old password.
    u.verified = true;
    this.revokeAllSessions(u.id);
    return { ok: true, email };
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
    if (typeof raw !== 'string' || raw.length > STORE_MAX_BYTES) return { ok: false, error: 'store too large (8 MB cap)' };
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
