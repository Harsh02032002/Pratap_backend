'use strict';

/**
 * authRevocation.test.js — security regression suite for the force-logout /
 * account-deactivation vulnerability.
 *
 *   node --test tests/authRevocation.test.js
 *
 * The property under test, stated once:
 *
 *   A valid signature on an unexpired JWT must NOT by itself authorize a
 *   request once the account behind it has been deactivated, deleted, blocked,
 *   suspended, or force-logged-out.
 *
 * Every test captures a REAL token for a REAL account, performs the revoking
 * action, then replays that exact same token over HTTP and asserts it is now
 * refused. Tokens are minted through utils/sessionToken.js — the same helper
 * the login routes now call — so the claim shape under test is the production
 * claim shape.
 *
 * JWT_SECRET is set here, before anything requires the middleware: nothing in
 * the require chain loads dotenv, and middleware/authMiddleware.js throws
 * without it (which its own catch would turn into an indistinguishable 401,
 * hiding whether a test failed for the right reason).
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
  await mongoose.connect(replSet.getUri('authRevocationTest'));
});

test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

const User = require('../models/user');
const Employee = require('../models/Employee');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const AreaManager = require('../models/AreaManager');
const PropertyManager = require('../models/PropertyManager');
const Property = require('../models/Property');

const { protect, optionalProtect, protectPasswordReset, authorize } = require('../middleware/authMiddleware');
const { signSessionToken } = require('../utils/sessionToken');

const JWT_SECRET = process.env.JWT_SECRET;

// ── The probe app ───────────────────────────────────────────────────────────
// A throwaway Express app, never server.js (which connects to the real Atlas
// MONGO_URI on require). `/probe` is the central enforcement point with nothing
// else in the way, so a failure here is unambiguously the auth gate and not some
// business rule inside a real controller. One real router is exercised too, in
// the route-coverage group at the bottom.
function startProbeApp() {
  const app = express();
  app.use(express.json());
  app.get('/probe', protect, (req, res) => res.json({ ok: true, role: req.user.role, id: String(req.user._id) }));
  app.get('/probe-admin', protect, authorize('superadmin'), (req, res) => res.json({ ok: true }));
  app.get('/probe-optional', optionalProtect, (req, res) => res.json({ ok: true, authenticated: !!req.user }));
  app.post('/probe-reset', protectPasswordReset, (req, res) => res.json({ ok: true, resetLoginId: req.resetLoginId }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const probe = (base, token, path = '/probe') => fetch(`${base}${path}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

/** Boots the probe app for one test and tears it down after it. */
async function withApp(t) {
  const { server, base } = await startProbeApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return base;
}

let seq = 0;
const uid = (p) => `${p}-${process.pid}-${++seq}`;

// ════════════════════════════════════════════════════════════════════════════
// GROUP A — Deactivation revokes an already-issued token, for every account type
// ════════════════════════════════════════════════════════════════════════════

test('A-01 User/superadmin: deactivating the account rejects its existing token', async (t) => {
  const base = await withApp(t);
  const user = await User.create({ name: 'SA', phone: '9000000101', password: 'x', role: 'superadmin', loginId: uid('RH-SA') });
  const token = signSessionToken({ id: user._id, role: user.role }, user);

  const before = await probe(base, token);
  assert.equal(before.status, 200, JSON.stringify(await before.json()));

  await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

  const after = await probe(base, token);
  const body = await after.json();
  assert.equal(after.status, 401, JSON.stringify(body));
  assert.equal(body.sessionEnded, true, 'must be refused by the revocation gate, not some other 401');
});

test('A-02 Employee: deactivating the account rejects its existing token', async (t) => {
  const base = await withApp(t);
  const emp = await Employee.create({ name: 'Staff', phone: '9000000102', loginId: uid('RH-EMP'), role: 'employee' });
  const token = signSessionToken({ id: emp._id }, emp);

  assert.equal((await probe(base, token)).status, 200);
  await Employee.updateOne({ _id: emp._id }, { $set: { isActive: false } });

  const after = await probe(base, token);
  assert.equal(after.status, 401);
  assert.equal((await after.json()).sessionEnded, true);
});

test('A-03 Owner: deactivating the account rejects its existing token', async (t) => {
  const base = await withApp(t);
  const owner = await Owner.create({ name: 'Owner', loginId: uid('RH-OWN') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  assert.equal((await probe(base, token)).status, 200);
  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });

  const after = await probe(base, token);
  assert.equal(after.status, 401);
  assert.equal((await after.json()).sessionEnded, true);
});

test('A-04 Tenant: suspending the account rejects its existing token (Tenant has no isActive field)', async (t) => {
  const base = await withApp(t);
  const tenant = await Tenant.create({ name: 'Tenant', phone: '9000000104', loginId: uid('RH-TNT'), status: 'active' });
  const token = signSessionToken({ id: tenant._id, role: 'tenant' }, tenant);

  assert.equal((await probe(base, token)).status, 200);
  await Tenant.updateOne({ _id: tenant._id }, { $set: { status: 'suspended' } });

  const after = await probe(base, token);
  assert.equal(after.status, 401);
  assert.equal((await after.json()).sessionEnded, true);
});

test('A-05 AreaManager: deactivating the account rejects its existing token', async (t) => {
  const base = await withApp(t);
  const am = await AreaManager.create({
    name: 'AM', phone: '9000000105', loginId: uid('RH-AM'), role: 'areamanager',
    email: `${uid('am')}@example.test`, password: 'not-used-by-jwt-path',
  });
  const token = signSessionToken({ id: am._id }, am);

  assert.equal((await probe(base, token)).status, 200);
  await AreaManager.updateOne({ _id: am._id }, { $set: { isActive: false } });

  assert.equal((await probe(base, token)).status, 401);
});

test('A-06 PropertyManager: a { managerId } token with no `id` claim is also revoked', async (t) => {
  const base = await withApp(t);
  const property = await Property.create({ title: 'PM Property', ownerLoginId: uid('RH-PMOWN') });
  const pm = await PropertyManager.create({
    name: 'PM', loginId: uid('RH-PM'), phone: '9000000106',
    assignedProperty: property._id, ownerLoginId: 'RH-PMOWN',
    email: `${uid('pm')}@example.test`, password: 'not-used-by-jwt-path',
  });
  // The real PM claim shape: managerId + loginId + propertyId, and no `id`.
  const token = signSessionToken({ managerId: pm._id, loginId: pm.loginId, propertyId: property._id }, pm);

  const before = await probe(base, token);
  assert.equal(before.status, 200, JSON.stringify(await before.json()));

  await PropertyManager.updateOne({ _id: pm._id }, { $set: { status: 'inactive' } });

  const after = await probe(base, token);
  assert.equal(after.status, 401);
  assert.equal((await after.json()).sessionEnded, true);
});

test('A-07 soft delete (isDeleted) rejects an existing token', async (t) => {
  const base = await withApp(t);
  const owner = await Owner.create({ name: 'Owner Del', loginId: uid('RH-OWNDEL') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  assert.equal((await probe(base, token)).status, 200);
  await Owner.updateOne({ _id: owner._id }, { $set: { isDeleted: true } });

  assert.equal((await probe(base, token)).status, 401);
});

test('A-08 AVAILABILITY GUARD: status "pending" is NOT a revoked state', async (t) => {
  // User.status and Tenant.status both DEFAULT to 'pending'. If the gate demanded
  // status === 'active' it would lock out a large part of the real user base, so
  // this guards against "fixing" the check into a positive assertion.
  const base = await withApp(t);
  const user = await User.create({ name: 'Pending', phone: '9000000108', password: 'x', role: 'tenant', loginId: uid('RH-PEND') });
  assert.equal(user.status, 'pending', 'precondition: status defaults to pending');

  const token = signSessionToken({ id: user._id, role: user.role }, user);
  const res = await probe(base, token);
  assert.equal(res.status, 200, 'a pending-but-not-revoked account must still authenticate');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP B — Force logout
// ════════════════════════════════════════════════════════════════════════════

test('B-01 force logout ends every live session for the account', async (t) => {
  const base = await withApp(t);
  const emp = await Employee.create({ name: 'Multi', phone: '9000000201', loginId: uid('RH-FL'), role: 'employee' });

  // Two separate sessions, as from two devices.
  const sessionA = signSessionToken({ id: emp._id }, emp);
  const sessionB = signSessionToken({ id: emp._id }, emp);
  assert.equal((await probe(base, sessionA)).status, 200);
  assert.equal((await probe(base, sessionB)).status, 200);

  await Employee.revokeSessions({ _id: emp._id });

  assert.equal((await probe(base, sessionA)).status, 401, 'session A must be dead');
  assert.equal((await probe(base, sessionB)).status, 401, 'session B must be dead too (documented policy: all sessions)');
});

test('B-02 after a force logout the account can still start a fresh session', async (t) => {
  const base = await withApp(t);
  const emp = await Employee.create({ name: 'Fresh', phone: '9000000202', loginId: uid('RH-FL2'), role: 'employee' });
  const old = signSessionToken({ id: emp._id }, emp);

  await Employee.revokeSessions({ _id: emp._id });
  assert.equal((await probe(base, old)).status, 401);

  // What the login route now does: reload the account, mint against its CURRENT
  // tokenVersion. This is the regression guard for the lockout bug that a
  // tv-less mint site would cause.
  const reloaded = await Employee.findById(emp._id);
  const fresh = signSessionToken({ id: reloaded._id }, reloaded);
  assert.equal((await probe(base, fresh)).status, 200, 'a still-active account must be able to log back in');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP C — Token validation: no fallback path may accept a bad token
// ════════════════════════════════════════════════════════════════════════════

test('C-01 missing, malformed, wrong-secret and expired tokens are all refused', async (t) => {
  const base = await withApp(t);
  const user = await User.create({ name: 'Val', phone: '9000000301', password: 'x', role: 'tenant', loginId: uid('RH-VAL') });

  assert.equal((await probe(base, null)).status, 401, 'no token');
  assert.equal((await probe(base, 'not-a-jwt')).status, 401, 'malformed');
  assert.equal((await probe(base, jwt.sign({ id: String(user._id) }, 'a-completely-different-secret'))).status, 401, 'wrong signature');
  assert.equal((await probe(base, jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: '-1s' }))).status, 401, 'expired');
  assert.equal(
    (await probe(base, jwt.sign({ id: String(user._id), tv: 0 }, JWT_SECRET, { algorithm: 'none' }))).status,
    401,
    'alg=none must not be accepted',
  );
});

test('C-02 a hard-deleted account cannot authenticate (the old token-claims fallback is gone)', async (t) => {
  const base = await withApp(t);
  const user = await User.create({ name: 'Gone', phone: '9000000302', password: 'x', role: 'tenant', loginId: uid('RH-GONE') });
  const token = signSessionToken({ id: user._id, role: user.role }, user);
  assert.equal((await probe(base, token)).status, 200);

  await User.deleteOne({ _id: user._id });

  const after = await probe(base, token);
  assert.equal(after.status, 401, 'protect() used to fabricate a req.user from the token claims here');
});

test('C-03 PRIVILEGE ESCALATION: a token asserting a role for a non-existent account is refused', async (t) => {
  // The old fallback trusted `decoded.role`, so a validly signed token naming no
  // real account satisfied authorize('superadmin') on its own say-so.
  const base = await withApp(t);
  const forged = jwt.sign(
    { id: new mongoose.Types.ObjectId().toString(), role: 'superadmin', loginId: 'NOBODY' },
    JWT_SECRET,
  );

  assert.equal((await probe(base, forged)).status, 401, 'no account => no identity');
  assert.equal((await probe(base, forged, '/probe-admin')).status, 401, 'and certainly no superadmin');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP D — Reactivation must not resurrect revoked tokens
// ════════════════════════════════════════════════════════════════════════════

test('D-01 deactivate then reactivate: the old token stays dead, a new one works', async (t) => {
  const base = await withApp(t);
  const owner = await Owner.create({ name: 'React', loginId: uid('RH-REACT') });
  const stolen = signSessionToken({ id: owner._id, role: 'owner' }, owner);
  assert.equal((await probe(base, stolen)).status, 200);

  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });
  assert.equal((await probe(base, stolen)).status, 401);

  // Reactivation: the status check alone would start passing again here. The
  // token generation is what keeps the pre-deactivation token dead.
  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: true } });

  assert.equal((await probe(base, stolen)).status, 401, 'a token issued before the deactivation must never work again');

  const reloaded = await Owner.findById(owner._id);
  const fresh = signSessionToken({ id: reloaded._id, role: 'owner' }, reloaded);
  assert.equal((await probe(base, fresh)).status, 200, 'but a genuine new login must work');
});

test('D-02 the token generation is bumped by every revoking write path', async (t) => {
  // save(), updateOne() and findOneAndUpdate() are all used to deactivate
  // accounts somewhere in this repo, so all three must bump.
  const viaSave = await Owner.create({ name: 'S', loginId: uid('RH-BUMP-S') });
  viaSave.isActive = false;
  await viaSave.save();
  assert.equal((await Owner.findById(viaSave._id)).tokenVersion, 1, 'save() path');

  const viaUpdate = await Owner.create({ name: 'U', loginId: uid('RH-BUMP-U') });
  await Owner.updateOne({ _id: viaUpdate._id }, { $set: { isActive: false } });
  assert.equal((await Owner.findById(viaUpdate._id)).tokenVersion, 1, 'updateOne() path');

  const viaFoau = await Tenant.create({ name: 'F', phone: '9000000402', loginId: uid('RH-BUMP-F'), status: 'active' });
  await Tenant.findOneAndUpdate({ _id: viaFoau._id }, { $set: { status: 'suspended' } });
  assert.equal((await Tenant.findById(viaFoau._id)).tokenVersion, 1, 'findOneAndUpdate() path');

  // And a NON-revoking write must not bump, or ordinary edits would log people out.
  const untouched = await Owner.create({ name: 'N', loginId: uid('RH-BUMP-N') });
  await Owner.updateOne({ _id: untouched._id }, { $set: { name: 'Renamed' } });
  assert.equal((await Owner.findById(untouched._id)).tokenVersion, 0, 'a harmless edit must not revoke sessions');
});

test('D-03 deactivation records deactivatedAt, which stops login auto-heal resurrecting it', async (t) => {
  const user = await User.create({ name: 'Heal', phone: '9000000403', password: 'x', role: 'owner', loginId: uid('RH-HEAL') });
  assert.equal(user.deactivatedAt, null);

  await User.updateOne({ _id: user._id }, { $set: { isActive: false } });
  const after = await User.findById(user._id);
  assert.ok(after.deactivatedAt instanceof Date, 'the login auto-heal branches key off this to refuse resurrection');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP F — Concurrency and ordering
// ════════════════════════════════════════════════════════════════════════════

test('F-01 concurrent requests are all refused once the deactivation has committed', async (t) => {
  const base = await withApp(t);
  const emp = await Employee.create({ name: 'Race', phone: '9000000501', loginId: uid('RH-RACE'), role: 'employee' });
  const token = signSessionToken({ id: emp._id }, emp);

  // 20 in flight before: every one authorized.
  const before = await Promise.all(Array.from({ length: 20 }, () => probe(base, token)));
  assert.ok(before.every((r) => r.status === 200), 'all pre-deactivation requests authorized');

  await Employee.updateOne({ _id: emp._id }, { $set: { isActive: false } });

  // The linearization point is the commit above. Everything after it is refused.
  const after = await Promise.all(Array.from({ length: 20 }, () => probe(base, token)));
  assert.ok(after.every((r) => r.status === 401), 'every post-commit request refused, with no stale-cache window');
});

test('F-02 simultaneous deactivations do not lose a token-generation increment', async (t) => {
  const emp = await Employee.create({ name: 'Conc', phone: '9000000502', loginId: uid('RH-CONC'), role: 'employee' });

  // $inc server-side, so these cannot clobber each other the way a
  // read-modify-write would.
  await Promise.all(Array.from({ length: 5 }, () => Employee.revokeSessions({ _id: emp._id })));

  assert.equal((await Employee.findById(emp._id)).tokenVersion, 5, 'all five increments survived');
});

test('F-03 the lookup-hint cache cannot serve a stale account status', async (t) => {
  // middleware/authMiddleware.js caches WHICH COLLECTION an id resolved to for
  // 5 minutes. It must never cache the document, or deactivation would take up
  // to 5 minutes to bite. Repeated hits warm that cache; the status must still
  // apply instantly.
  const base = await withApp(t);
  const owner = await Owner.create({ name: 'Hint', loginId: uid('RH-HINT') });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await probe(base, token)).status, 200, 'warming the hint cache');
  }

  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });
  assert.equal((await probe(base, token)).status, 401, 'the hint must not have cached the account document');
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP G — Alternate entry points and bypasses
// ════════════════════════════════════════════════════════════════════════════

test('G-01 BYPASS CHAIN: a session token cannot be used as a password-reset token', async (t) => {
  // protectPasswordReset used to verify only the signature. The route behind it
  // mints a brand-new 7-day session token, so a revoked employee could use an
  // old session token to reset their password and get a fresh valid session.
  const base = await withApp(t);
  const emp = await Employee.create({ name: 'Reset', phone: '9000000601', loginId: uid('RH-RST'), role: 'employee' });
  const sessionToken = signSessionToken({ id: emp._id }, emp);

  const res = await fetch(`${base}/probe-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ newPassword: 'whatever' }),
  });
  assert.equal(res.status, 401, 'a session token must not satisfy the password-reset guard');
});

test('G-02 a genuine password-reset token still works', async (t) => {
  const base = await withApp(t);
  const resetToken = jwt.sign({ loginId: 'RH-RST-OK', purpose: 'password_reset' }, JWT_SECRET, { expiresIn: '15m' });

  const res = await fetch(`${base}/probe-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resetToken}` },
    body: JSON.stringify({ newPassword: 'whatever' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.resetLoginId, 'RH-RST-OK');
});

test('G-03 optionalProtect never attaches a revoked account as req.user', async (t) => {
  const base = await withApp(t);
  const user = await User.create({ name: 'Opt', phone: '9000000603', password: 'x', role: 'tenant', loginId: uid('RH-OPT') });
  const token = signSessionToken({ id: user._id, role: user.role }, user);

  const before = await (await probe(base, token, '/probe-optional')).json();
  assert.equal(before.authenticated, true);

  await User.updateOne({ _id: user._id }, { $set: { isActive: false } });

  const after = await (await probe(base, token, '/probe-optional')).json();
  assert.equal(after.authenticated, false, 'revoked => anonymous, never an identity');
});

test('G-04 ROUTE COVERAGE: the gate holds on a real protect-guarded router, not just the probe', async (t) => {
  const tenantRoutes = require('../routes/tenantRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/tenants', tenantRoutes);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const owner = await Owner.create({ name: 'Real', loginId: uid('RH-REAL') });
  const property = await Property.create({ title: 'Real Property', ownerLoginId: owner.loginId });
  const tenant = await Tenant.create({
    name: 'Real Tenant', phone: '9000000604', property: property._id,
    roomNo: 'R1', agreedRent: 8000, loginId: uid('RH-REALT'), status: 'active',
  });
  const token = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  const url = `${base}/api/tenants/${tenant._id}/transfer`;
  const body = JSON.stringify({ newRoomNo: 'R2', newBedNo: '1', newAgreedRent: 9000 });
  const call = () => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  });

  // Not asserting the transfer SUCCEEDS (that is roomTransferGaps.test.js's job)
  // — only that an active owner gets past auth, and a revoked one does not.
  const before = await call();
  assert.notEqual(before.status, 401, 'an active owner must get past the auth gate');

  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });

  const after = await call();
  assert.equal(after.status, 401, 'a deactivated owner must be refused on a real endpoint');
  assert.equal((await after.json()).sessionEnded, true);
});

test('D-04 a deliberate reactivation clears deactivatedAt but never rolls back the token generation', async (t) => {
  // Mirrors the write the reactivate endpoints now perform (they sit behind
  // protect + authorize('superadmin'); this asserts the data invariant they rely on).
  const base = await withApp(t);
  const owner = await Owner.create({ name: 'ReactEP', loginId: uid('RH-REP') });
  const stolen = signSessionToken({ id: owner._id, role: 'owner' }, owner);

  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: false } });
  const deactivated = await Owner.findById(owner._id);
  assert.ok(deactivated.deactivatedAt instanceof Date);
  assert.equal(deactivated.tokenVersion, 1);

  // The deliberate reactivation.
  await Owner.updateOne({ _id: owner._id }, { $set: { isActive: true, deactivatedAt: null } });
  const reactivated = await Owner.findById(owner._id);

  assert.equal(reactivated.deactivatedAt, null, 'login auto-heal must work normally again');
  assert.equal(reactivated.tokenVersion, 1, 'the generation must NOT be rolled back');
  assert.equal((await probe(base, stolen)).status, 401, 'and the pre-deactivation token stays dead');
});
