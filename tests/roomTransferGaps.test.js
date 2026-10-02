'use strict';
// Gap-closing regression tests for the room-transfer system, written after
// the initial 8-test suite (tests/roomTransfer.test.js) to cover:
// idempotency, transaction rollback, the new partial-unique index's exact
// boundaries, electricity edge cases, validation, and the digital check-in
// security fix. Uses the same in-memory replica-set pattern as
// roomTransfer.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri('roomTransferGapsTest'));
  // Mongoose builds indexes in the BACKGROUND after connecting (autoIndex),
  // without the app waiting for them — this test intentionally exercises the
  // raw DB-level unique constraint, so it must wait for that build to finish
  // or it races ahead of the index and the constraint silently isn't there
  // yet. (This same gap exists for a real deploy — see the production report.)
  await require('../models/RoomAssignmentHistory').init();
});

test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const RentInvoice = require('../models/RentInvoice');
const RoomAssignmentHistory = require('../models/RoomAssignmentHistory');
const ElectricityMeter = require('../models/ElectricityMeter');

const roomAssignmentService = require('../services/roomAssignmentService');
const { transferTenant, TransferValidationError } = require('../services/roomTransferService');
const { generateMonthlyInvoices } = require('../services/invoiceService');
const { syncElectricityToInvoice, findAllTenantsInRoom } = require('../services/tenantDuesService');
const electricityController = require('../controllers/electricityController');
const express = require('express');
const http = require('node:http');

async function makeProperty() { return new mongoose.Types.ObjectId(); }
async function makeRoom(propertyId, title, price, unitCost = 0) {
  return Room.create({ property: propertyId, title, price, electricity: { unitCost } });
}
async function makeTenant({ propertyId, room, roomNo, agreedRent, loginId, moveInDate }) {
  return Tenant.create({
    name: 'Test Tenant', phone: '9000000001', property: propertyId, room: room._id, roomNo,
    agreedRent, loginId, status: 'active', moveInDate: moveInDate || new Date('2020-01-01T00:00:00Z'),
  });
}
function fakeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ── Work 9: idempotency ─────────────────────────────────────────────────────

test('idempotency: submitting the same transfer twice is rejected, not duplicated', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'IDEM-A', 8000);
  const roomB = await makeRoom(propertyId, 'IDEM-B', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'IDEM-A', agreedRent: 8000, loginId: 'RH-T-IDEM' });
  await roomAssignmentService.recordOnboarding({
    tenantId: tenant._id, propertyId, roomId: roomA._id, roomNo: 'IDEM-A', agreedRent: 8000, effectiveFrom: new Date('2026-08-01T00:00:00Z'),
  });

  await transferTenant({ tenant, newRoom: roomB, newAgreedRent: 10000, transferDate: new Date('2026-09-20T00:00:00Z'), performedBy: 'test' });

  // Re-fetch the SAME tenant doc fresh (as a second, independent HTTP request would).
  const freshRoomB = await Room.findById(roomB._id);
  const tenantAfterFirst = await Tenant.findById(tenant._id);
  await assert.rejects(
    () => transferTenant({ tenant: tenantAfterFirst, newRoom: freshRoomB, newAgreedRent: 10000, transferDate: new Date('2026-09-20T00:00:00Z'), performedBy: 'test' }),
    (err) => {
      assert.ok(err instanceof TransferValidationError);
      assert.match(err.message, /already assigned/);
      return true;
    }
  );

  const rows = await RoomAssignmentHistory.find({ tenantId: tenant._id }).sort({ effectiveFrom: 1 });
  assert.equal(rows.length, 2, 'exactly one onboarding row + one transfer row — the retried request must not add a third');
});

// ── Work 10: transaction rollback ───────────────────────────────────────────

test('transaction rollback: a failure after room updates leaves nothing changed', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'ROLLBACK-A', 8000);
  const roomB = await makeRoom(propertyId, 'ROLLBACK-B', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'ROLLBACK-A', agreedRent: 8000, loginId: 'RH-T-ROLLBACK', });
  tenant.bedNo = '1'; await tenant.save();
  roomA.bedAssignments = [{ tenantId: tenant._id, tenantName: tenant.name, tenantLoginId: tenant.loginId, assignedAt: new Date() }];
  await roomA.save();

  // Force a failure INSIDE the transaction, after the room bed-assignment
  // writes but conceptually mid-flow, by making the history write reject —
  // simulate this by passing an invalid propertyId type that fails schema
  // validation on RoomAssignmentHistory.create (required ObjectId field).
  const originalRecordTransfer = roomAssignmentService.recordTransfer;
  roomAssignmentService.recordTransfer = async () => { throw new Error('simulated failure mid-transfer'); };
  try {
    await assert.rejects(
      () => transferTenant({ tenant, newRoom: roomB, newBedNo: '1', newAgreedRent: 10000, transferDate: new Date('2026-09-20T00:00:00Z'), performedBy: 'test' }),
      /simulated failure/
    );
  } finally {
    roomAssignmentService.recordTransfer = originalRecordTransfer;
  }

  const tenantAfter = await Tenant.findById(tenant._id);
  const roomAAfter = await Room.findById(roomA._id);
  const roomBAfter = await Room.findById(roomB._id);
  const historyAfter = await RoomAssignmentHistory.find({ tenantId: tenant._id });

  assert.equal(String(tenantAfter.room), String(roomA._id), 'tenant must still be on the ORIGINAL room after rollback');
  assert.equal(tenantAfter.agreedRent, 8000, 'rent must not have changed');
  assert.equal(roomAAfter.bedAssignments[0]?.tenantId && String(roomAAfter.bedAssignments[0].tenantId), String(tenant._id), 'old room bed slot must still show the tenant — not freed');
  assert.equal((roomBAfter.bedAssignments || []).length, 0, 'new room must show no partial bed assignment');
  assert.equal(historyAfter.length, 0, 'no partial history row must exist');
});

// ── Work 4: index review ────────────────────────────────────────────────────

test('index: a genuinely sequential re-transfer (closed old, new open) succeeds', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'IDX-A', 8000);
  const roomB = await makeRoom(propertyId, 'IDX-B', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'IDX-A', agreedRent: 8000, loginId: 'RH-T-IDX-OK' });
  await roomAssignmentService.recordOnboarding({
    tenantId: tenant._id, propertyId, roomId: roomA._id, roomNo: 'IDX-A', agreedRent: 8000, effectiveFrom: new Date('2026-08-01T00:00:00Z'),
  });
  // This is exactly what recordTransfer does internally: close then open.
  // Confirms the unique partial index does not block a legitimate sequence.
  await assert.doesNotReject(() =>
    roomAssignmentService.recordTransfer({
      tenantId: tenant._id, propertyId, roomId: roomB._id, roomNo: 'IDX-B', agreedRent: 10000, transferDate: new Date('2026-09-20T00:00:00Z'),
    })
  );
  const open = await RoomAssignmentHistory.findOne({ tenantId: tenant._id, effectiveTo: null });
  assert.equal(String(open.roomId), String(roomB._id));
});

test('index: two simultaneously-open assignments for the same tenant are rejected at the DB level', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'IDX-C', 8000);
  const roomB = await makeRoom(propertyId, 'IDX-D', 10000);
  const tenantId = new mongoose.Types.ObjectId();
  await RoomAssignmentHistory.create({
    tenantId, propertyId, roomId: roomA._id, roomNo: 'IDX-C', agreedRent: 8000,
    effectiveFrom: new Date('2026-08-01T00:00:00Z'), effectiveTo: null, reason: 'onboarding',
  });
  // Directly attempt a SECOND open row for the same tenant, bypassing the
  // service's close-then-open logic entirely — this is what the unique
  // partial index must catch even if application code has a bug.
  await assert.rejects(
    () => RoomAssignmentHistory.create({
      tenantId, propertyId, roomId: roomB._id, roomNo: 'IDX-D', agreedRent: 10000,
      effectiveFrom: new Date('2026-09-01T00:00:00Z'), effectiveTo: null, reason: 'transfer',
    }),
    (err) => { assert.equal(err.code, 11000, 'must fail as a duplicate-key error'); return true; }
  );
});

test('index: two different tenants can each have an open assignment to the SAME room (shared/multi-bed room)', async () => {
  // The index is scoped to {tenantId}, not {roomId} — the app already
  // supports multi-bed rooms via Room.bedAssignments, and nothing here
  // should invent a global "one tenant per room" rule.
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'SHARED-1', 6000);
  await assert.doesNotReject(() => RoomAssignmentHistory.create({
    tenantId: new mongoose.Types.ObjectId(), propertyId, roomId: room._id, roomNo: 'SHARED-1', bedNo: '1',
    agreedRent: 6000, effectiveFrom: new Date('2026-08-01T00:00:00Z'), effectiveTo: null, reason: 'onboarding',
  }));
  await assert.doesNotReject(() => RoomAssignmentHistory.create({
    tenantId: new mongoose.Types.ObjectId(), propertyId, roomId: room._id, roomNo: 'SHARED-1', bedNo: '2',
    agreedRent: 6000, effectiveFrom: new Date('2026-08-01T00:00:00Z'), effectiveTo: null, reason: 'onboarding',
  }));
});

// ── Work 13: validation ─────────────────────────────────────────────────────

test('validation: transferring to the room the tenant is already in is rejected, not silently accepted', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'VAL-A', 8000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'VAL-A', agreedRent: 8000, loginId: 'RH-T-VAL1' });
  await assert.rejects(
    () => transferTenant({ tenant, newRoom: roomA, newAgreedRent: 8000, performedBy: 'test' }),
    TransferValidationError
  );
});

test('validation: transferring into an already-occupied bed is rejected', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'VAL-B-old', 8000);
  const roomB = await makeRoom(propertyId, 'VAL-B-new', 10000);
  const occupantId = new mongoose.Types.ObjectId();
  roomB.bedAssignments = [{ tenantId: occupantId, tenantName: 'Someone Else', tenantLoginId: 'RH-OTHER', assignedAt: new Date() }];
  await roomB.save();
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'VAL-B-old', agreedRent: 8000, loginId: 'RH-T-VAL2' });
  await assert.rejects(
    () => transferTenant({ tenant, newRoom: roomB, newBedNo: '1', newAgreedRent: 10000, performedBy: 'test' }),
    (err) => { assert.ok(err instanceof TransferValidationError); assert.match(err.message, /already occupied/); return true; }
  );
});

// ── Work 6: old invoice without roomNo ──────────────────────────────────────

test('backward compatibility: an invoice with no roomNo (pre-fix data) does not crash the display path', async () => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'OLDINV', 8000);
  const tenant = await makeTenant({ propertyId, room, roomNo: 'OLDINV', agreedRent: 8000, loginId: 'RH-T-OLDINV' });
  // Simulate a pre-fix invoice: created directly, bypassing generateMonthlyInvoices,
  // with no roomNo field at all (as every invoice looked before this change).
  const oldInvoice = await RentInvoice.create({
    invoiceNumber: 'INV-OLD-1', ownerId: new mongoose.Types.ObjectId(), propertyId, tenantId: tenant._id,
    billingMonth: '2025-01', rentAmount: 7000, dueDate: new Date('2025-01-01'), totalDue: 7000, outstandingAmount: 0,
  });
  assert.equal(oldInvoice.roomNo, '', 'schema default keeps this an empty string, never undefined/null — safe for direct string display');
  // The exact expression tenantdashboard.jsx's ReceiptTemplate uses.
  const displayValue = oldInvoice.roomNo ? `Room ${oldInvoice.roomNo}` : 'Room information unavailable';
  assert.equal(displayValue, 'Room information unavailable');
});

// ── Work 7: electricity edge cases ──────────────────────────────────────────

test('electricity Case A: usage stays with the tenant who used it even after the room becomes empty', async () => {
  const propertyId = await makeProperty();
  const ownerId = new mongoose.Types.ObjectId();
  const roomA = await makeRoom(propertyId, 'ELEC-A-CASE-A', 8000, 10);
  const roomB = await makeRoom(propertyId, 'ELEC-B-CASE-A', 10000, 12);
  const tenantA = await makeTenant({ propertyId, room: roomA, roomNo: 'ELEC-A-CASE-A', agreedRent: 8000, loginId: 'RH-T-CASEA' });
  await roomAssignmentService.recordOnboarding({ tenantId: tenantA._id, propertyId, roomId: roomA._id, roomNo: 'ELEC-A-CASE-A', agreedRent: 8000, effectiveFrom: new Date('2026-08-01T00:00:00Z') });
  await generateMonthlyInvoices(ownerId, '2026-09', [{ tenantId: tenantA._id, propertyId, unitId: roomA._id, rentAmount: 8000 }]);

  const readRes = fakeRes();
  await electricityController.updateMeterReading({ body: { propertyId: String(propertyId), roomNo: 'ELEC-A-CASE-A', billingMonth: '2026-09', currentReading: 50, previousReading: 0 } }, readRes);

  await roomAssignmentService.recordTransfer({ tenantId: tenantA._id, propertyId, roomId: roomB._id, roomNo: 'ELEC-B-CASE-A', agreedRent: 10000, transferDate: new Date('2026-09-25T00:00:00Z') });
  // Room A is now empty — no one moves in.

  const sync = await syncElectricityToInvoice(propertyId, 'ELEC-A-CASE-A', '2026-09', readRes.body.reading);
  assert.equal(sync.synced, true, 'usage must still be billed, even though the room is now vacant');
  assert.equal(sync.results[0].tenantId.toString(), tenantA._id.toString());
});

test('electricity Case B: usage is not reassigned to whoever moves into the room afterward', async () => {
  const propertyId = await makeProperty();
  const ownerId = new mongoose.Types.ObjectId();
  const roomA = await makeRoom(propertyId, 'ELEC-A-CASE-B', 8000, 10);
  const roomB = await makeRoom(propertyId, 'ELEC-B-CASE-B', 10000, 12);
  const tenantA = await makeTenant({ propertyId, room: roomA, roomNo: 'ELEC-A-CASE-B', agreedRent: 8000, loginId: 'RH-T-CASEB-A' });
  await roomAssignmentService.recordOnboarding({ tenantId: tenantA._id, propertyId, roomId: roomA._id, roomNo: 'ELEC-A-CASE-B', agreedRent: 8000, effectiveFrom: new Date('2026-08-01T00:00:00Z') });
  await generateMonthlyInvoices(ownerId, '2026-09', [{ tenantId: tenantA._id, propertyId, unitId: roomA._id, rentAmount: 8000 }]);

  const readRes = fakeRes();
  await electricityController.updateMeterReading({ body: { propertyId: String(propertyId), roomNo: 'ELEC-A-CASE-B', billingMonth: '2026-09', currentReading: 60, previousReading: 0 } }, readRes);

  await roomAssignmentService.recordTransfer({ tenantId: tenantA._id, propertyId, roomId: roomB._id, roomNo: 'ELEC-B-CASE-B', agreedRent: 10000, transferDate: new Date('2026-09-25T00:00:00Z') });

  const tenantB = await makeTenant({ propertyId, room: roomA, roomNo: 'ELEC-A-CASE-B', agreedRent: 8000, loginId: 'RH-T-CASEB-B', moveInDate: new Date('2026-09-27T00:00:00Z') });
  await roomAssignmentService.recordOnboarding({ tenantId: tenantB._id, propertyId, roomId: roomA._id, roomNo: 'ELEC-A-CASE-B', agreedRent: 8000, effectiveFrom: new Date('2026-09-27T00:00:00Z') });

  const sync = await syncElectricityToInvoice(propertyId, 'ELEC-A-CASE-B', '2026-09', readRes.body.reading);
  assert.equal(sync.results.length, 1);
  assert.equal(sync.results[0].tenantId.toString(), tenantA._id.toString(), 'Tenant A keeps the usage');
  const tenantBInvoice = await RentInvoice.findOne({ tenantId: tenantB._id, billingMonth: '2026-09' });
  assert.equal(tenantBInvoice, null, 'Tenant B must not be billed for Tenant A\'s September usage');
});

test('electricity Case C: two tenants sharing a multi-bed room still split the bill — unchanged existing behavior', async () => {
  const propertyId = await makeProperty();
  const ownerId = new mongoose.Types.ObjectId();
  const room = await makeRoom(propertyId, 'ELEC-SHARED', 5000, 10);
  const tenant1 = await makeTenant({ propertyId, room, roomNo: 'ELEC-SHARED', agreedRent: 5000, loginId: 'RH-T-SHARE-1' });
  const tenant2 = await makeTenant({ propertyId, room, roomNo: 'ELEC-SHARED', agreedRent: 5000, loginId: 'RH-T-SHARE-2' });
  await roomAssignmentService.recordOnboarding({ tenantId: tenant1._id, propertyId, roomId: room._id, roomNo: 'ELEC-SHARED', agreedRent: 5000, effectiveFrom: new Date('2026-08-01T00:00:00Z') });
  await roomAssignmentService.recordOnboarding({ tenantId: tenant2._id, propertyId, roomId: room._id, roomNo: 'ELEC-SHARED', agreedRent: 5000, effectiveFrom: new Date('2026-08-01T00:00:00Z') });
  await generateMonthlyInvoices(ownerId, '2026-09', [
    { tenantId: tenant1._id, propertyId, unitId: room._id, rentAmount: 5000 },
    { tenantId: tenant2._id, propertyId, unitId: room._id, rentAmount: 5000 },
  ]);
  const readRes = fakeRes();
  await electricityController.updateMeterReading({ body: { propertyId: String(propertyId), roomNo: 'ELEC-SHARED', billingMonth: '2026-09', currentReading: 100, previousReading: 0 } }, readRes);
  const sync = await syncElectricityToInvoice(propertyId, 'ELEC-SHARED', '2026-09', readRes.body.reading);
  assert.equal(sync.splitAmong, 2, 'existing split-by-occupant-count behavior must be unchanged');
  assert.equal(sync.perTenantShare, 500, '1000 total / 2 tenants');
});

test('electricity Case D: no assignment history exists for the room — falls back to live occupancy, documented', async () => {
  const propertyId = await makeProperty();
  const ownerId = new mongoose.Types.ObjectId();
  const room = await makeRoom(propertyId, 'ELEC-NOHISTORY', 8000, 10);
  const tenant = await makeTenant({ propertyId, room, roomNo: 'ELEC-NOHISTORY', agreedRent: 8000, loginId: 'RH-T-NOHIST' });
  // Deliberately NOT calling recordOnboarding — simulates a tenant who
  // predates RoomAssignmentHistory, with zero rows for this room.
  await generateMonthlyInvoices(ownerId, '2026-09', [{ tenantId: tenant._id, propertyId, unitId: room._id, rentAmount: 8000 }]);
  const readRes = fakeRes();
  await electricityController.updateMeterReading({ body: { propertyId: String(propertyId), roomNo: 'ELEC-NOHISTORY', billingMonth: '2026-09', currentReading: 40, previousReading: 0 } }, readRes);
  const sync = await syncElectricityToInvoice(propertyId, 'ELEC-NOHISTORY', '2026-09', readRes.body.reading);
  assert.equal(sync.synced, true, 'documented fallback: with no history rows, live occupancy is used, exactly as before this change');
  assert.equal(sync.results[0].tenantId.toString(), tenant._id.toString());
});

// ── Work 14: digital check-in security fix ──────────────────────────────────

test('digital check-in: first submission sets room/rent, a second submission cannot silently change them', async (t) => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'CHECKIN-A', 8000);
  const tenant = await makeTenant({ propertyId, room, roomNo: 'CHECKIN-A', agreedRent: 8000, loginId: 'RH-T-CHECKIN' });
  // digitalCheckin.profile.submittedAt is intentionally unset here — this
  // tenant has never completed the check-in profile step yet, even though
  // they were onboarded (this is the realistic case: assignTenant creates
  // the Tenant row; digital check-in is a separate step the tenant does
  // themselves afterward).

  const checkinRoutes = require('../routes/checkinRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/checkin', checkinRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // First submission: room/rent MUST be settable (this is the legitimate,
  // unauthenticated-by-design onboarding flow).
  const first = await fetch(`${base}/api/checkin/tenant/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      loginId: tenant.loginId, name: 'Test Tenant', dob: '2000-01-01', guardianNumber: '9999999999',
      moveInDate: '2026-08-01', roomNo: 'SHOULD-NOT-APPLY', agreedRent: 99999,
    }),
  });
  assert.equal(first.status, 200);
  const afterFirst = await Tenant.findById(tenant._id);
  assert.equal(afterFirst.roomNo, 'SHOULD-NOT-APPLY', 'first submission legitimately sets roomNo');
  assert.equal(afterFirst.agreedRent, 99999, 'first submission legitimately sets agreedRent');
  assert.ok(afterFirst.digitalCheckin.profile.submittedAt, 'submittedAt must now be recorded, gating future submissions');

  // Second submission with a DIFFERENT room/rent: must be silently ignored
  // for those two fields specifically (not an error — the rest of the
  // profile update, e.g. name, still succeeds).
  const second = await fetch(`${base}/api/checkin/tenant/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      loginId: tenant.loginId, name: 'Test Tenant Updated', dob: '2000-01-01', guardianNumber: '9999999999',
      moveInDate: '2026-08-01', roomNo: 'ATTACKER-ROOM', agreedRent: 1,
    }),
  });
  assert.equal(second.status, 200);
  const afterSecond = await Tenant.findById(tenant._id);
  assert.equal(afterSecond.roomNo, 'SHOULD-NOT-APPLY', 'a second submission must NOT change roomNo');
  assert.equal(afterSecond.agreedRent, 99999, 'a second submission must NOT change agreedRent');
  assert.equal(afterSecond.name, 'Test Tenant Updated', 'non-billing profile fields still update normally');
});

test('digital check-in: the authorized transfer endpoint can still change room after check-in is complete', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'CHECKIN-B-old', 8000);
  const roomB = await makeRoom(propertyId, 'CHECKIN-B-new', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'CHECKIN-B-old', agreedRent: 8000, loginId: 'RH-T-CHECKIN2' });
  tenant.digitalCheckin = { profile: { submittedAt: new Date() } };
  await tenant.save();

  await transferTenant({ tenant, newRoom: roomB, newAgreedRent: 10000, transferDate: new Date('2026-09-20T00:00:00Z'), performedBy: 'owner-test' });
  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'CHECKIN-B-new', 'the authorized transfer path is unaffected by the check-in first-submission-only guard');
  assert.equal(after.agreedRent, 10000);
});

// ── Performance: RoomAssignmentHistory must not introduce N+1 queries ──────
// Moved into this file (rather than its own) so the room-transfer test suite
// boots one shared in-memory MongoDB replica set instead of several — running
// 4 separate MongoMemoryReplSet instances concurrently (one per test file)
// caused a real, observed "Instance failed to start within 10000ms" failure
// under resource contention when the full suite ran together. That was a
// test-infrastructure timing issue, not a logic bug — the test itself passed
// cleanly every time it ran in isolation.

function countQueriesDuring(fn) {
  const calls = [];
  mongoose.set('debug', (collectionName, method) => { calls.push(`${collectionName}.${method}`); });
  return Promise.resolve(fn()).finally(() => mongoose.set('debug', false)).then(() => calls);
}

async function seedPerfTenants(count, propertyId, rooms, batchTag) {
  const tenants = [];
  for (let i = 0; i < count; i++) {
    const room = rooms[i % rooms.length];
    const tenant = await Tenant.create({
      name: `Perf Tenant ${i}`, phone: `9${batchTag}${String(i).padStart(5, '0')}`,
      property: propertyId, room: room._id, roomNo: room.title, agreedRent: room.price,
      loginId: `RH-PERF-${batchTag}-${i}`, status: 'active', moveInDate: new Date('2020-01-01T00:00:00Z'),
    });
    if (i % 2 === 0) {
      await roomAssignmentService.recordOnboarding({
        tenantId: tenant._id, propertyId, roomId: room._id, roomNo: room.title,
        agreedRent: room.price, effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      });
    }
    tenants.push({ tenantId: tenant._id, propertyId, unitId: room._id, rentAmount: room.price });
  }
  return tenants;
}

test('generateMonthlyInvoices: query count scales with unique ROOMS, not with tenant count', async () => {
  // 10 tenants (one per room) vs 50 (five per room) — BOTH touch the exact
  // same 10 rooms, so PenaltyConfig's per-unique-room cascade (10 rooms x 3
  // fallback queries, memoized — pre-existing, unrelated to this work) costs
  // the SAME in both runs. Tenant count is the only variable that changes.
  // If RoomAssignmentHistory resolution were N+1, this is exactly where it
  // would show up: 10x the tenants, but query count should not move, because
  // getAssignmentsForBillingMonthBatch fetches all of them in one $in query.
  const propertyId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  const rooms = await Promise.all(
    Array.from({ length: 10 }, (_, i) => Room.create({ property: propertyId, title: `PERF-${i}`, price: 8000 + i * 500 }))
  );

  const smallBatch = await seedPerfTenants(10, propertyId, rooms, 'small');
  const queriesForSmall = await countQueriesDuring(() => generateMonthlyInvoices(ownerId, '2026-06', smallBatch));

  const bigBatch = await seedPerfTenants(50, propertyId, rooms, 'big');
  const queriesForBig = await countQueriesDuring(() => generateMonthlyInvoices(ownerId, '2026-07', bigBatch));

  assert.equal(await RentInvoice.countDocuments({ tenantId: { $in: smallBatch.map(t => t.tenantId) } }), 10);
  assert.equal(await RentInvoice.countDocuments({ tenantId: { $in: bigBatch.map(t => t.tenantId) } }), 50);

  console.log(`[perf] 10 tenants / 10 rooms: ${queriesForSmall.length} DB operations`);
  console.log(`[perf] 50 tenants / 10 rooms: ${queriesForBig.length} DB operations`);

  const delta = queriesForBig.length - queriesForSmall.length;
  assert.ok(delta <= 5, `10x the tenants (same 10 rooms) added ${delta} extra DB operations — expected only a handful, which would indicate an N+1 regression if this grew with tenant count`);
});

// ── Authorization: real HTTP requests against the real router, real         ──
// ── protect/authorize middleware, real JWT verification.                    ──
//
// This mounts ONLY routes/tenantRoutes.js in a throwaway Express app — never
// server.js, which connects to the real Atlas MONGO_URI on require. This
// process is already connected to the in-memory replica set above (via
// mongoose's single global default connection), so every model call the
// router makes runs against that, never production data.
const jwt = require('jsonwebtoken');
const Owner = require('../models/Owner');
const Property = require('../models/Property');
const User = require('../models/user');

const JWT_SECRET = process.env.JWT_SECRET || 'roomhy_default_jwt_secret_key_2026';

async function startTenantRoutesApp() {
  const tenantRoutes = require('../routes/tenantRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/tenants', tenantRoutes);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function makeRealProperty(ownerLoginId) {
  return Property.create({ title: `Property of ${ownerLoginId}`, ownerLoginId });
}

async function transferRequest(base, token, tenantId, body) {
  return fetch(`${base}/api/tenants/${tenantId}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('authorization: the property owner who owns the tenant can transfer them', async (t) => {
  const owner = await Owner.create({ loginId: 'RH-AUTH-OWNER-1', name: 'Owner One' });
  const property = await makeRealProperty(owner.loginId);
  const roomA = await makeRoom(property._id, 'AUTH-A', 8000);
  const roomB = await makeRoom(property._id, 'AUTH-B', 10000);
  const tenant = await makeTenant({ propertyId: property._id, room: roomA, roomNo: 'AUTH-A', agreedRent: 8000, loginId: 'RH-AUTH-T1' });
  const token = jwt.sign({ id: String(owner._id) }, JWT_SECRET);

  const { server, base } = await startTenantRoutesApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await transferRequest(base, token, tenant._id, { newRoomNo: 'AUTH-B', newBedNo: '1', newAgreedRent: 10000, transferDate: '2026-09-20' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'AUTH-B');
});

test('authorization: an owner cannot transfer a tenant belonging to another owner\'s property', async (t) => {
  const owner1 = await Owner.create({ loginId: 'RH-AUTH-OWNER-2', name: 'Owner Two' });
  const owner2 = await Owner.create({ loginId: 'RH-AUTH-OWNER-3', name: 'Owner Three' });
  const property2 = await makeRealProperty(owner2.loginId); // tenant belongs to OWNER 2's property
  const roomA = await makeRoom(property2._id, 'AUTH2-A', 8000);
  const roomB = await makeRoom(property2._id, 'AUTH2-B', 10000);
  const tenant = await makeTenant({ propertyId: property2._id, room: roomA, roomNo: 'AUTH2-A', agreedRent: 8000, loginId: 'RH-AUTH-T2' });
  const token = jwt.sign({ id: String(owner1._id) }, JWT_SECRET); // OWNER 1's token

  const { server, base } = await startTenantRoutesApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await transferRequest(base, token, tenant._id, { newRoomNo: 'AUTH2-B', newBedNo: '1', newAgreedRent: 10000 });
  const body = await res.json();
  assert.equal(res.status, 403, JSON.stringify(body));
  assert.equal(body.success, false);
  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'AUTH2-A', 'no partial update — tenant must remain on the original room');
  const roomAAfter = await Room.findById(roomA._id);
  assert.equal((roomAAfter.bedAssignments || []).length, 0, 'no partial bed-assignment write either');
});

test('authorization: a tenant cannot call the transfer endpoint to change their own room/rent', async (t) => {
  const owner = await Owner.create({ loginId: 'RH-AUTH-OWNER-4', name: 'Owner Four' });
  const property = await makeRealProperty(owner.loginId);
  const roomA = await makeRoom(property._id, 'AUTH3-A', 8000);
  const roomB = await makeRoom(property._id, 'AUTH3-B', 15000);
  const tenant = await makeTenant({ propertyId: property._id, room: roomA, roomNo: 'AUTH3-A', agreedRent: 8000, loginId: 'RH-AUTH-T3' });
  const tenantToken = jwt.sign({ id: String(tenant._id) }, JWT_SECRET); // the tenant's OWN token

  const { server, base } = await startTenantRoutesApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await transferRequest(base, tenantToken, tenant._id, { newRoomNo: 'AUTH3-B', newBedNo: '1', newAgreedRent: 15000 });
  const body = await res.json();
  assert.equal(res.status, 403, JSON.stringify(body));
  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'AUTH3-A', 'a tenant must not be able to raise or lower their own rent via this endpoint');
  assert.equal(after.agreedRent, 8000);
});

test('authorization: an unauthenticated request (no token) is rejected, no partial update', async (t) => {
  const owner = await Owner.create({ loginId: 'RH-AUTH-OWNER-5', name: 'Owner Five' });
  const property = await makeRealProperty(owner.loginId);
  const roomA = await makeRoom(property._id, 'AUTH4-A', 8000);
  const roomB = await makeRoom(property._id, 'AUTH4-B', 10000);
  const tenant = await makeTenant({ propertyId: property._id, room: roomA, roomNo: 'AUTH4-A', agreedRent: 8000, loginId: 'RH-AUTH-T4' });

  const { server, base } = await startTenantRoutesApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await transferRequest(base, null, tenant._id, { newRoomNo: 'AUTH4-B' });
  const body = await res.json();
  assert.equal(res.status, 401, JSON.stringify(body));
  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'AUTH4-A');
});

test('authorization: a malformed/invalid token is rejected cleanly, not a 500', async (t) => {
  const owner = await Owner.create({ loginId: 'RH-AUTH-OWNER-6', name: 'Owner Six' });
  const property = await makeRealProperty(owner.loginId);
  const roomA = await makeRoom(property._id, 'AUTH5-A', 8000);
  const tenant = await makeTenant({ propertyId: property._id, room: roomA, roomNo: 'AUTH5-A', agreedRent: 8000, loginId: 'RH-AUTH-T5' });

  const { server, base } = await startTenantRoutesApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const garbage = await transferRequest(base, 'not-a-real-jwt', tenant._id, { newRoomNo: 'AUTH5-B' });
  assert.equal(garbage.status, 401);

  const wrongSecret = jwt.sign({ id: String(owner._id) }, 'a-completely-different-secret');
  const res2 = await transferRequest(base, wrongSecret, tenant._id, { newRoomNo: 'AUTH5-B' });
  assert.equal(res2.status, 401);

  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'AUTH5-A');
});

test('authorization: superadmin can transfer any tenant, matching the existing permission model', async (t) => {
  const superadminUser = await User.create({ name: 'Super Admin', phone: '9111111111', password: 'irrelevant-not-used-for-jwt-login', role: 'superadmin', loginId: 'RH-AUTH-SUPER-1' });
  const owner = await Owner.create({ loginId: 'RH-AUTH-OWNER-7', name: 'Owner Seven' });
  const property = await makeRealProperty(owner.loginId); // superadmin is NOT this property's owner
  const roomA = await makeRoom(property._id, 'AUTH6-A', 8000);
  const roomB = await makeRoom(property._id, 'AUTH6-B', 10000);
  const tenant = await makeTenant({ propertyId: property._id, room: roomA, roomNo: 'AUTH6-A', agreedRent: 8000, loginId: 'RH-AUTH-T6' });
  const token = jwt.sign({ id: String(superadminUser._id) }, JWT_SECRET);

  const { server, base } = await startTenantRoutesApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const res = await transferRequest(base, token, tenant._id, { newRoomNo: 'AUTH6-B', newBedNo: '1', newAgreedRent: 10000 });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const after = await Tenant.findById(tenant._id);
  assert.equal(after.roomNo, 'AUTH6-B', 'superadmin bypasses the per-owner ownership check, matching the existing model (no owner-scoping branch runs for non-owner roles)');
});
