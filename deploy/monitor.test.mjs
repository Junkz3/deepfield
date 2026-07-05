// Unit tests for the monitor's pure detection logic.
//   node --test deploy/monitor.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeEvents } from './monitor.mjs';

const AT = (iso) => Date.parse(iso);
const user = (id, createdAt, extra = {}) => ({ id, createdAt, verified: true, ...extra });

test('first run seeds the baseline and emits nothing', () => {
  const db = { users: { 'a@x.com': user('u1', '2026-07-01') } };
  const { events, nextState } = computeEvents(null, db, AT('2026-07-05T10:00:00Z'));
  assert.deepEqual(events, []);
  assert.deepEqual(nextState.knownUserIds, ['u1']);
});

test('a new account triggers a signup event, once', () => {
  const now = AT('2026-07-05T10:00:00Z');
  const prev = { knownUserIds: ['u1'], notifiedLocks: {}, health: {} };
  const db = { users: { 'a@x.com': user('u1', '2026-07-01'), 'b@x.com': user('u2', '2026-07-05', { verified: false }) } };
  const r1 = computeEvents(prev, db, now);
  const signup = r1.events.find((e) => e.type === 'signup');
  assert.ok(signup);
  assert.equal(signup.users.length, 1);
  assert.equal(signup.users[0].email, 'b@x.com');
  // known now: no repeat
  const r2 = computeEvents(r1.nextState, db, now);
  assert.equal(r2.events.find((e) => e.type === 'signup'), undefined);
});

test('five or more new accounts at once flags a spike', () => {
  const now = AT('2026-07-05T10:00:00Z');
  const prev = { knownUserIds: [], notifiedLocks: {}, health: {} };
  const users = {};
  for (let i = 0; i < 5; i++) users[`u${i}@x.com`] = user(`u${i}`, '2026-07-05');
  const { events } = computeEvents(prev, { users }, now);
  assert.ok(events.find((e) => e.type === 'signup-spike' && e.count === 5));
});

test('a locked account alerts once, not every run', () => {
  const now = AT('2026-07-05T10:00:00Z');
  const until = now + 15 * 60 * 1000;
  const prev = { knownUserIds: ['u1'], notifiedLocks: {}, health: {} };
  const db = { users: { 'a@x.com': user('u1', '2026-07-01', { lock: { n: 0, until } }) } };
  const r1 = computeEvents(prev, db, now);
  assert.ok(r1.events.find((e) => e.type === 'lockout'));
  const r2 = computeEvents(r1.nextState, db, now + 1000);
  assert.equal(r2.events.find((e) => e.type === 'lockout'), undefined);
});

test('global budget over 80% alerts once per day', () => {
  const now = AT('2026-07-05T10:00:00Z');
  const prev = { knownUserIds: [], notifiedLocks: {}, health: {} };
  const db = { users: {}, usage: { 'global:2026-07-05': 4200 } }; // > 4000 (80% of default 5000)
  const r1 = computeEvents(prev, db, now);
  const q = r1.events.find((e) => e.type === 'quota');
  assert.ok(q);
  assert.equal(q.used, 4200);
  const r2 = computeEvents(r1.nextState, db, now);
  assert.equal(r2.events.find((e) => e.type === 'quota'), undefined);
});

test('daily digest fires once, only after the digest hour', () => {
  const db = { users: { 'a@x.com': user('u1', '2026-07-05') }, usage: { 'global:2026-07-05': 10 } };
  const prev = { knownUserIds: ['u1'], notifiedLocks: {}, lastDigestDay: '2026-07-04', health: {} };
  // before hour 8 UTC: nothing
  assert.equal(computeEvents(prev, db, AT('2026-07-05T06:00:00Z')).events.find((e) => e.type === 'digest'), undefined);
  // after hour 8: digest with correct stats
  const r = computeEvents(prev, db, AT('2026-07-05T09:00:00Z'));
  const dg = r.events.find((e) => e.type === 'digest');
  assert.ok(dg);
  assert.equal(dg.stats.newToday, 1);
  assert.equal(dg.stats.accounts, 1);
  assert.equal(dg.stats.requestsToday, 10);
  // already sent today: no repeat
  const r2 = computeEvents(r.nextState, db, AT('2026-07-05T09:00:00Z'));
  assert.equal(r2.events.find((e) => e.type === 'digest'), undefined);
});
