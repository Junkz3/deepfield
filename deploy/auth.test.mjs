// Unit tests for the account store: sessions, verification, reset.
//   node --test deploy/
// Plain node:test so the deploy/ folder stays runnable with zero deps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, STORE_MAX_BYTES } from './auth.mjs';

const fresh = () => new AuthStore(mkdtempSync(join(tmpdir(), 'auth-test-')));

test('signup starts unverified, the emailed token verifies', () => {
  const store = fresh();
  const r = store.signup('user@example.com', 'password1');
  assert.equal(r.ok, true);
  assert.equal(store.infoOf(r.userId)?.verified, false);

  assert.equal(store.verifyEmail('not-a-token').ok, false);
  const v = store.verifyEmail(r.verifyToken);
  assert.equal(v.ok, true);
  assert.equal(v.email, 'user@example.com');
  assert.equal(store.infoOf(r.userId)?.verified, true);
  // single use
  assert.equal(store.verifyEmail(r.verifyToken).ok, false);
});

test('expired tokens are dead', () => {
  const store = fresh();
  const r = store.signup('user@example.com', 'password1');
  store.db.users['user@example.com'].verify.exp = Date.now() - 1;
  assert.equal(store.verifyEmail(r.verifyToken).ok, false);
});

test('sessions are opaque, revocable one by one and all at once', () => {
  const store = fresh();
  const r = store.signup('user@example.com', 'password1');
  const s1 = store.issueSession(r.userId);
  const s2 = store.issueSession(r.userId);
  assert.equal(store.verifySession(s1), r.userId);
  assert.equal(store.verifySession('forged-cookie-value-forged-cookie'), null);

  store.revokeSession(s1);
  assert.equal(store.verifySession(s1), null);
  assert.equal(store.verifySession(s2), r.userId);

  const s3 = store.issueSession(r.userId);
  store.revokeAllSessions(r.userId);
  assert.equal(store.verifySession(s2), null);
  assert.equal(store.verifySession(s3), null);
});

test('reset flow: token by mail, new password, all sessions revoked', () => {
  const store = fresh();
  const r = store.signup('user@example.com', 'password1');
  const session = store.issueSession(r.userId);

  assert.equal(store.issueResetToken('nobody@example.com'), null);
  // signup just stamped the mail cooldown; a real user waits it out
  store.db.users['user@example.com'].lastMailAt = 0;
  const token = store.issueResetToken('User@Example.com');
  assert.ok(token);

  assert.equal(store.resetPassword(token, 'short').ok, false);
  const done = store.resetPassword(token, 'password2');
  assert.equal(done.ok, true);

  assert.equal(store.login('user@example.com', 'password1').ok, false);
  assert.equal(store.login('user@example.com', 'password2').ok, true);
  assert.equal(store.verifySession(session), null);
  // owning the mailbox settles verification too
  assert.equal(store.infoOf(r.userId)?.verified, true);
  // single use
  assert.equal(store.resetPassword(token, 'password3').ok, false);
});

test('mail cooldown holds for a minute per account', () => {
  const store = fresh();
  const r = store.signup('user@example.com', 'password1');
  assert.equal(store.issueVerifyToken(r.userId), null);
  store.db.users['user@example.com'].lastMailAt = Date.now() - 61_000;
  assert.ok(store.issueVerifyToken(r.userId));
});

test('per-account store round-trips, is isolated, and enforces the size cap', () => {
  const store = fresh();
  const a = store.signup('a@example.com', 'password1').userId;
  const b = store.signup('b@example.com', 'password1').userId;

  // fresh account: empty JSON, never another account's data
  assert.equal(store.readStore(a), '{}');

  const convs = JSON.stringify({ conversations: { 'rc.conversations': [{ id: 'x', private: 'secret' }] } });
  assert.equal(store.writeStore(a, convs).ok, true);
  // round-trips for the owner
  assert.equal(store.readStore(a), convs);
  // isolation: b cannot see a's conversations, and a write by a never leaks to b
  assert.equal(store.readStore(b), '{}');
  store.writeStore(b, '{"conversations":{}}');
  assert.equal(store.readStore(a), convs);

  // survives a restart (atomic file on disk)
  const reopened = new AuthStore(store.dir);
  assert.equal(reopened.readStore(a), convs);

  // rejects invalid JSON and anything over the cap, without corrupting what is stored
  assert.equal(store.writeStore(a, 'not json').ok, false);
  assert.equal(store.writeStore(a, 'x'.repeat(STORE_MAX_BYTES + 1)).ok, false);
  assert.equal(store.readStore(a), convs);
});

test('state survives a restart, pre-verification accounts are grandfathered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
  const a = new AuthStore(dir);
  const r = a.signup('user@example.com', 'password1');
  const session = a.issueSession(r.userId);

  // a user record written before the verified flag existed
  const db = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));
  db.users['old@example.com'] = { id: 'olduser000000', salt: 'ab', hash: 'cd', createdAt: '2026-07-01' };
  writeFileSync(join(dir, 'users.json'), JSON.stringify(db));

  const b = new AuthStore(dir);
  assert.equal(b.verifySession(session), r.userId);
  assert.equal(b.infoOf(r.userId)?.verified, false);
  assert.equal(b.infoOf('olduser000000')?.verified, true);
});
