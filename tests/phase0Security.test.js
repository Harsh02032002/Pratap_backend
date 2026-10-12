'use strict';

/**
 * phase0Security.test.js — adversarial tests for the Phase-0 gaps:
 * wallet/withdrawal/refund/payment authorization, Socket.IO handshake identity,
 * visit deletion, and SSE stream revocation.
 *
 *   node --test tests/phase0Security.test.js
 *
 * Every test here attacks the fix rather than demonstrating the happy path:
 * missing token, wrong role, a STAFF token against an admin-only money route,
 * one owner reaching for another owner's wallet, a withdrawal from an empty
 * wallet, a replayed refund, and a socket claiming to be somebody else.
 *
 * Routers are mounted into throwaway Express apps — never server.js, which
 * connects to the real Atlas MONGO_URI on require.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-a-real-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const express = require('express');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;
test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri('phase0SecurityTest'));
});
test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

const User = require('../models/user');
const Owner = require('../models/Owner');
const Employee = require('../models/Employee');
const Tenant = require('../models/Tenant');
const PaymentTransaction = require('../models/PaymentTransaction');
const { signSessionToken } = require('../utils/sessionToken');

let seq = 0;
const uid = (p) => `${p}-${process.pid}-${++seq}`;

async function mount(path, routerPath) {
  const app = express();
  app.use(express.json());
  app.use(path, require(routerPath));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const call = (base, path, { token, method = 'GET', body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP H — Wallet and withdrawals
// ════════════════════════════════════════════════════════════════════════════

test('H-01 every wallet route rejects an unauthenticated request', async (t) => {
  const { server, base } = await mount('/api/wallet', '../routes/walletRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const probes = [
    ['GET', '/api/wallet/owner/balance'],
    ['POST', '/api/wallet/owner/withdraw-instant'],
    ['GET', '/api/wallet/admin/balance'],
    ['POST', '/api/wallet/admin/withdraw-instant'],
  ];
  for (const [method, path] of probes) {
    const res = await call(base, path, { method, body: method === 'POST' ? { amount: 100 } : undefined });
    assert.equal(res.status, 401, `${method} ${path} must require authentication`);
  }
});

test('H-02 an owner token cannot reach the ADMIN platform wallet', async (t) => {
  const { server, base } = await mount('/api/wallet', '../routes/walletRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const owner = await Owner.create({ name: 'W Owner', loginId: uid('RH-W-OWN') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  assert.equal((await call(base, '/api/wallet/admin/balance', { token })).status, 403);
  assert.equal(
    (await call(base, '/api/wallet/admin/withdraw-instant', { token, method: 'POST', body: { amount: 500 } })).status,
    403,
  );
});

test('H-03 PRIVILEGE TRAP: a STAFF token cannot reach the admin wallet', async (t) => {
  // authorize('superadmin') expands to admit employee/staff/manager/areamanager,
  // so it alone would have let any staff account withdraw platform commission.
  // requirePlatformAdmin is what makes this 403.
  const { server, base } = await mount('/api/wallet', '../routes/walletRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const emp = await Employee.create({ name: 'Staffer', phone: '9100000001', loginId: uid('RH-W-EMP'), role: 'employee' });
  const token = signSessionToken({ id: emp._id }, emp);

  assert.equal((await call(base, '/api/wallet/admin/balance', { token })).status, 403, 'staff must not read the platform wallet');
  assert.equal(
    (await call(base, '/api/wallet/admin/withdraw-instant', { token, method: 'POST', body: { amount: 500 } })).status,
    403,
    'staff must not withdraw platform commission',
  );
});

test('H-04 OWNERSHIP: owner A passing owner B\'s loginId cannot touch B\'s wallet', async (t) => {
  const { server, base } = await mount('/api/wallet', '../routes/walletRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const victim = await Owner.create({
    name: 'Victim', loginId: uid('RH-W-VICTIM'),
    availableBalance: 50000, walletBalance: 50000,
    bankDetails: { accountNumber: '111122223333', ifsc: 'HDFC0001234' },
  });
  const attacker = await Owner.create({ name: 'Attacker', loginId: uid('RH-W-ATT'), availableBalance: 0, walletBalance: 0 });
  const attackerToken = signSessionToken({ id: attacker._id, role: 'owner' }, attacker);

  // The body names the victim. Identity must come from the session instead.
  const res = await call(base, '/api/wallet/owner/withdraw-instant', {
    token: attackerToken, method: 'POST',
    body: { loginId: victim.loginId, amount: 10000 },
  });

  assert.notEqual(res.status, 200, 'must not succeed');
  const after = await Owner.findById(victim._id);
  assert.equal(after.availableBalance, 50000, "the victim's balance must be untouched");
  assert.equal(after.withdrawnBalance || 0, 0, 'and no withdrawal recorded against them');
});

test('H-05 an empty wallet cannot be drained (the zero-balance bypass)', async (t) => {
  // The old guard was `numAmount > currentAvailable && currentAvailable > 0`,
  // which skipped the limit entirely when the balance was exactly 0.
  const { server, base } = await mount('/api/wallet', '../routes/walletRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const owner = await Owner.create({
    name: 'Empty', loginId: uid('RH-W-EMPTY'),
    availableBalance: 0, walletBalance: 0,
    bankDetails: { accountNumber: '999988887777', ifsc: 'HDFC0001234' },
  });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  const res = await call(base, '/api/wallet/owner/withdraw-instant', {
    token, method: 'POST', body: { amount: 25000 },
  });
  const body = await res.json();

  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body.message), /Insufficient/i);
  const after = await Owner.findById(owner._id);
  assert.equal(after.withdrawnBalance || 0, 0, 'nothing may be recorded as withdrawn');
});

test('H-06 a deactivated owner cannot use the wallet at all', async (t) => {
  const { server, base } = await mount('/api/wallet', '../routes/walletRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const owner = await Owner.create({ name: 'Revoked', loginId: uid('RH-W-REV'), availableBalance: 1000, walletBalance: 1000 });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);
  assert.notEqual((await call(base, '/api/wallet/owner/balance', { token })).status, 401);

  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });

  const res = await call(base, '/api/wallet/owner/balance', { token });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).sessionEnded, true);
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP I — Refunds, payment history, and the flows that must stay open
// ════════════════════════════════════════════════════════════════════════════

async function adminToken() {
  const admin = await User.create({
    name: 'Platform Admin', phone: `91${Math.floor(10000000 + Math.random() * 89999999)}`,
    password: 'x', role: 'superadmin', loginId: uid('RH-P-SA'), status: 'active',
  });
  return { admin, token: signSessionToken({ id: admin._id, role: admin.role }, admin) };
}

test('I-01 refund and history reject unauthenticated callers', async (t) => {
  const { server, base } = await mount('/api/payments', '../routes/payuPaymentRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  assert.equal((await call(base, '/api/payments/refund', { method: 'POST', body: { orderId: 'X' } })).status, 401);
  assert.equal((await call(base, '/api/payments/history')).status, 401);
});

test('I-02 PRIVILEGE TRAP: a staff token cannot refund or read platform history', async (t) => {
  const { server, base } = await mount('/api/payments', '../routes/payuPaymentRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const emp = await Employee.create({ name: 'P Staff', phone: '9100000002', loginId: uid('RH-P-EMP'), role: 'employee' });
  const token = signSessionToken({ id: emp._id }, emp);

  assert.equal((await call(base, '/api/payments/refund', { token, method: 'POST', body: { orderId: 'X' } })).status, 403);
  assert.equal((await call(base, '/api/payments/history', { token })).status, 403);
});

test('I-03 a refund cannot be replayed, and cannot exceed what was captured', async (t) => {
  const { server, base } = await mount('/api/payments', '../routes/payuPaymentRoutes');
  t.after(() => new Promise((r) => server.close(r)));
  const { token } = await adminToken();

  const orderId = uid('ORDER');
  await PaymentTransaction.create({
    order_id: orderId, cf_order_id: orderId, amount: 5000, status: 'PAID',
    booking_amount: 5000, commission_percentage: 10, commission_amount: 500, owner_amount: 4500,
  });

  // Over-refund is refused.
  const over = await call(base, '/api/payments/refund', { token, method: 'POST', body: { orderId, amount: 9999 } });
  assert.equal(over.status, 400, 'cannot refund more than was captured');
  assert.equal((await PaymentTransaction.findOne({ order_id: orderId })).status, 'PAID', 'and nothing changed');

  // A valid partial refund succeeds and is recorded with attribution.
  const ok = await call(base, '/api/payments/refund', { token, method: 'POST', body: { orderId, amount: 2000, reason: 'test' } });
  assert.equal(ok.status, 200, JSON.stringify(await ok.json()));
  const tx = await PaymentTransaction.findOne({ order_id: orderId });
  // 'Refunded' is the enum's value; the handler used to write 'REFUNDED',
  // which failed schema validation and made every refund a 500.
  assert.equal(tx.status, 'Refunded');
  assert.equal(tx.refund_amount, 2000);
  assert.equal(tx.refund_reason, 'test', 'refund_reason now has a schema path and persists');
  assert.ok(tx.refunded_by, 'the acting admin is recorded');

  // Replay is refused.
  const replay = await call(base, '/api/payments/refund', { token, method: 'POST', body: { orderId, amount: 2000 } });
  assert.equal(replay.status, 409, 'the same transaction must not refund twice');
});

test('I-04 a non-PAID transaction cannot be flipped straight to REFUNDED', async (t) => {
  const { server, base } = await mount('/api/payments', '../routes/payuPaymentRoutes');
  t.after(() => new Promise((r) => server.close(r)));
  const { token } = await adminToken();

  const orderId = uid('PENDING');
  await PaymentTransaction.create({
    order_id: orderId, cf_order_id: orderId, amount: 1000, status: 'PENDING',
    booking_amount: 1000, commission_percentage: 10, commission_amount: 100, owner_amount: 900,
  });

  const res = await call(base, '/api/payments/refund', { token, method: 'POST', body: { orderId } });
  assert.equal(res.status, 409);
  assert.equal((await PaymentTransaction.findOne({ order_id: orderId })).status, 'PENDING');
});

test('I-05 REGRESSION: the externally-called and link-token payment flows stay open', async (t) => {
  // These must NOT become 401. /response is a browser form-POST redirect from
  // PayU, and /create-order is reached by the emailed onboarding payment page
  // and the public website checkout, neither of which has a panel session.
  const { server, base } = await mount('/api/payments', '../routes/payuPaymentRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  for (const [method, path] of [['POST', '/api/payments/response'], ['GET', '/api/payments/response']]) {
    // redirect: 'manual' — this endpoint legitimately answers 302 back to the
    // frontend, and following it would try to reach a dev server that is not up.
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      redirect: 'manual',
      ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
    });
    assert.notEqual(res.status, 401, `${method} ${path} must remain reachable for PayU`);
    assert.ok(res.status >= 200 && res.status < 400, `${method} ${path} answered ${res.status}`);
  }

  const order = await call(base, '/api/payments/create-order', { method: 'POST', body: {} });
  assert.notEqual(order.status, 401, 'anonymous onboarding/website checkout must still reach create-order');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP J — Visit deletion
// ════════════════════════════════════════════════════════════════════════════

test('J-01 visit deletion requires authentication and a staff/admin role', async (t) => {
  const { server, base } = await mount('/api/visits', '../routes/visitDataRoutes');
  t.after(() => new Promise((r) => server.close(r)));

  const target = uid('VISIT');

  // Unauthenticated.
  assert.equal((await call(base, `/api/visits/${target}`, { method: 'DELETE' })).status, 401);

  // Authenticated but wrong role.
  const tenant = await Tenant.create({ name: 'V Tenant', phone: '9100000003', loginId: uid('RH-V-TNT'), status: 'active' });
  const tenantToken = signSessionToken({ id: tenant._id, role: 'tenant' }, tenant);
  assert.equal((await call(base, `/api/visits/${target}`, { token: tenantToken, method: 'DELETE' })).status, 403);

  // Platform admin gets through the gate (404 because no such visit exists).
  const { token } = await adminToken();
  const res = await call(base, `/api/visits/${target}`, { token, method: 'DELETE' });
  assert.equal(res.status, 404, 'an authorized caller passes auth and reaches the handler');
});

test('J-02 the unreachable duplicate DELETE handler is gone', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'routes', 'visitDataRoutes.js'), 'utf8');
  const count = (src.match(/^router\.delete\('\/:visitId'/gm) || []).length;
  assert.equal(count, 1, 'exactly one DELETE /:visitId registration, and it is the guarded one');
  assert.match(src, /router\.delete\('\/:visitId',\s*protect,/, 'and it carries protect');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP K — Socket.IO handshake identity
// ════════════════════════════════════════════════════════════════════════════

const { attachSocketAuth, identityFor, tokenFromHandshake } = require('../socket/socketAuth');

/** Captures the io.use() middleware so it can be driven directly. */
function captureHandshakeMiddleware() {
  let fn = null;
  const fakeIo = { use: (f) => { fn = f; }, fetchSockets: async () => [] };
  attachSocketAuth(fakeIo);
  assert.ok(fn, 'attachSocketAuth must register an io.use() middleware');
  return fn;
}

const runHandshake = (fn, handshake) => new Promise((resolve) => {
  const socket = { handshake, data: {}, disconnect() {}, emit() {} };
  fn(socket, (err) => resolve({ err, socket }));
});

test('K-01 a socket handshake with no token is rejected', async () => {
  const fn = captureHandshakeMiddleware();
  const { err, socket } = await runHandshake(fn, { auth: {}, headers: {}, query: {} });
  assert.ok(err, 'connection must be refused');
  assert.equal(socket.data.auth, undefined);
});

test('K-02 a forged or wrong-secret socket token is rejected', async () => {
  const fn = captureHandshakeMiddleware();
  const owner = await Owner.create({ name: 'S Owner', loginId: uid('RH-S-OWN') });

  for (const bad of [
    'garbage',
    jwt.sign({ id: String(owner._id) }, 'a-completely-different-secret'),
    jwt.sign({ id: String(owner._id) }, process.env.JWT_SECRET, { expiresIn: '-1s' }),
  ]) {
    const { err } = await runHandshake(fn, { auth: { token: bad }, headers: {}, query: {} });
    assert.ok(err, 'must refuse');
  }
});

test('K-03 a deactivated account cannot open a socket', async () => {
  const fn = captureHandshakeMiddleware();
  const owner = await Owner.create({ name: 'S Revoked', loginId: uid('RH-S-REV') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  const good = await runHandshake(fn, { auth: { token }, headers: {}, query: {} });
  assert.equal(good.err, undefined, 'an active account connects');

  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });

  const after = await runHandshake(fn, { auth: { token }, headers: {}, query: {} });
  assert.ok(after.err, 'a revoked account must be refused');
  assert.equal(after.err.data.sessionEnded, true);
});

test('K-04 IMPERSONATION: the socket identity comes from the database, not the client', async () => {
  const fn = captureHandshakeMiddleware();
  const owner = await Owner.create({ name: 'Real Owner', loginId: uid('RH-S-REAL') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  // The handshake also carries a forged identity. It must be ignored entirely.
  const { err, socket } = await runHandshake(fn, {
    auth: { token, login_id: 'SUPER_ADMIN', role: 'superadmin', name: 'Totally The Admin' },
    headers: {},
    query: { login_id: 'SUPER_ADMIN', role: 'superadmin' },
  });

  assert.equal(err, undefined);
  assert.equal(socket.data.auth.loginId, owner.loginId, 'identity is the real account');
  assert.equal(socket.data.auth.role, 'owner', 'role is the DB role, not the claimed superadmin');
  assert.notEqual(socket.data.auth.role, 'superadmin');
  assert.equal(socket.data.auth.name, 'Real Owner');
});

test('K-05 join_room ignores the client payload and uses the authorized identity', async () => {
  const initChatSocket = require('../socket/chatSocket');

  // Minimal io/socket doubles that record what the handler does.
  const handlers = {};
  const joined = [];
  const emitted = [];
  const fakeIo = { on: (evt, cb) => { if (evt === 'connection') handlers.connection = cb; }, to: () => ({ emit() {} }) };
  initChatSocket(fakeIo);
  assert.ok(handlers.connection, 'chatSocket must register a connection handler');

  const socketHandlers = {};
  const socket = {
    id: 'sock-1',
    data: { auth: { accountId: 'a1', loginId: 'RH-TRUE-OWNER', chatId: 'RH-TRUE-OWNER', role: 'owner', name: 'True Owner', rooms: ['RH-TRUE-OWNER'] } },
    on: (evt, cb) => { socketHandlers[evt] = cb; },
    join: (room) => joined.push(room),
    emit: (evt, payload) => emitted.push({ evt, payload }),
    disconnect() {},
  };
  handlers.connection(socket);
  assert.ok(socketHandlers.join_room, 'join_room handler must exist');

  // The attacker's payload claims to be somebody else entirely.
  socketHandlers.join_room({ login_id: 'RH-VICTIM', role: 'superadmin', name: 'Victim', aliases: ['RH-VICTIM', 'SUPER_ADMIN'] });

  assert.ok(joined.includes('RH-TRUE-OWNER'), 'joined its own room');
  assert.ok(!joined.includes('RH-VICTIM'), "must NOT join the victim's room");
  assert.ok(!joined.includes('SUPER_ADMIN'), 'must not join a claimed alias room');
  assert.equal(socket.userRole, 'owner', 'role is server-derived, not the claimed superadmin');
  assert.equal(socket.userLogin, 'RH-TRUE-OWNER');

  const joinedEvt = emitted.find((e) => e.evt === 'joined');
  assert.equal(joinedEvt.payload.login_id, 'RH-TRUE-OWNER', 'the authorized identity is echoed back');
});

test('K-06 join_room without an authenticated handshake is refused', async () => {
  const initChatSocket = require('../socket/chatSocket');
  const handlers = {};
  const fakeIo = { on: (evt, cb) => { if (evt === 'connection') handlers.connection = cb; }, to: () => ({ emit() {} }) };
  initChatSocket(fakeIo);

  const socketHandlers = {};
  let disconnected = false;
  const emitted = [];
  const socket = {
    id: 'sock-2', data: {}, // no auth
    on: (evt, cb) => { socketHandlers[evt] = cb; },
    join: () => { throw new Error('must not join any room'); },
    emit: (evt, p) => emitted.push({ evt, p }),
    disconnect: () => { disconnected = true; },
  };
  handlers.connection(socket);
  socketHandlers.join_room({ login_id: 'ANYONE', role: 'superadmin' });

  assert.ok(disconnected, 'an unauthenticated socket must be disconnected');
  assert.ok(emitted.some((e) => e.evt === 'error'));
});

test('K-07 handshake token is read from auth, header and query', () => {
  assert.equal(tokenFromHandshake({ auth: { token: 'Bearer abc' } }), 'abc');
  assert.equal(tokenFromHandshake({ auth: {}, headers: { authorization: 'Bearer hdr' } }), 'hdr');
  assert.equal(tokenFromHandshake({ auth: {}, headers: {}, query: { token: 'qry' } }), 'qry');
  assert.equal(tokenFromHandshake({ auth: {}, headers: {}, query: {} }), null);
});

test('K-08 room membership is derived server-side from the account', () => {
  const id = identityFor({ _id: 'x1', loginId: 'ROOMHYWEB541955', email: 'person@example.com', name: 'P', role: 'tenant' });
  assert.ok(id.rooms.length > 0, 'rooms are computed, not supplied');
  assert.ok(id.rooms.some((r) => /roomhyweb541955/i.test(r)), 'includes the account id form');
  assert.equal(id.role, 'tenant');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP L — SSE streams end when the session is revoked
// ════════════════════════════════════════════════════════════════════════════

test('L-01 a revoked SSE stream is terminated on the next revalidation pass', async () => {
  const sse = require('../utils/sseManager');

  const owner = await Owner.create({ name: 'SSE Owner', loginId: uid('RH-SSE') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  // Minimal req/res doubles standing in for an open EventSource response.
  const written = [];
  let ended = false;
  const res = {
    writeHead() {},
    write: (chunk) => { written.push(String(chunk)); return true; },
    end: () => { ended = true; },
  };
  const listeners = {};
  const req = { headers: { authorization: `Bearer ${token}` }, on: (evt, cb) => { listeners[evt] = cb; } };

  sse.addClient(req, res, owner.loginId);
  assert.ok(sse._clients().some((c) => c.ownerLoginId === owner.loginId.toUpperCase()), 'stream registered');

  // While the account is active the pass only pings.
  await sse._revalidateAndPing();
  assert.equal(ended, false, 'an authorized stream stays open');
  assert.ok(written.some((w) => w.includes(': ping')), 'and is kept alive by the heartbeat');

  // Revoke, then run one pass.
  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });
  await sse._revalidateAndPing();

  assert.equal(ended, true, 'the stream must be closed once the account is revoked');
  assert.ok(written.some((w) => w.includes('session_ended')), 'and the client is told why');
  assert.ok(!sse._clients().some((c) => c.ownerLoginId === owner.loginId.toUpperCase()), 'and dropped from the set');
});

test('L-02 the SSE client record captures a token so revalidation has an input', async () => {
  const sse = require('../utils/sseManager');
  const owner = await Owner.create({ name: 'SSE Tok', loginId: uid('RH-SSE2') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  const res = { writeHead() {}, write() { return true; }, end() {} };
  const req = { headers: { authorization: `Bearer ${token}` }, on() {} };
  sse.addClient(req, res, owner.loginId);

  const client = sse._clients().find((c) => c.ownerLoginId === owner.loginId.toUpperCase());
  assert.ok(client.token, 'token captured');
  assert.equal(client.token, token);
  // Clean up so this stream does not linger into other tests.
  sse._clients().forEach((c) => { if (c === client) c.res.end(); });
});
