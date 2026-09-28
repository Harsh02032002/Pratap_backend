'use strict';
// Regression tests for tenant room-transfer billing correctness.
//
// Uses an in-memory MongoDB replica set (not a standalone instance) so the
// same transaction path the production Atlas cluster uses is actually
// exercised, per utils/dbHelper.runInTransaction's requirements.
//
// These test the SERVICE layer (roomAssignmentService, invoiceService,
// tenantDuesService, the electricity controller) directly rather than the
// HTTP route — the route is thin plumbing (auth, bed-assignment bookkeeping)
// around the same services, and hitting it would require standing up JWT
// auth fixtures that add setup cost without covering new logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri('roomTransferTest'));
});

test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Rent = require('../models/Rent');
const RentInvoice = require('../models/RentInvoice');

const RentPayment = require('../models/RentPayment');

const roomAssignmentService = require('../services/roomAssignmentService');
const { generateMonthlyInvoices } = require('../services/invoiceService');
const { syncElectricityToInvoice } = require('../services/tenantDuesService');
const { nextBillingMonth, istMonthStartUTC } = require('../utils/istDate');
const electricityController = require('../controllers/electricityController');
const { listPaymentsHandler, getTenantInvoiceSummary } = require('../controllers/rentCollectionController');

const OWNER_ID = new mongoose.Types.ObjectId();

function fakeRes() {
  const res = {};
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function makeProperty() {
  return new mongoose.Types.ObjectId();
}

async function makeRoom(propertyId, title, price, unitCost = 0) {
  return Room.create({ property: propertyId, title, price, electricity: { unitCost } });
}

async function makeTenant({ propertyId, room, roomNo, agreedRent, loginId, moveInDate }) {
  return Tenant.create({
    name: 'Test Tenant',
    phone: '9000000000',
    property: propertyId,
    room: room._id,
    roomNo,
    agreedRent,
    loginId,
    status: 'active',
    // isEligibleForBillingMonth falls back to createdAt (real wall-clock
    // "now") when moveInDate is absent — always set it explicitly here so
    // eligibility checks test the fictional scenario dates, not whatever day
    // the test happens to run on.
    moveInDate: moveInDate || new Date('2020-01-01T00:00:00Z'),
  });
}

test('mid-month transfer: September keeps old room/rent, October gets new — even if generated late', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'A101', 8000);
  const roomB = await makeRoom(propertyId, 'B202', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'A101', agreedRent: 8000, loginId: 'RH-T-MIDMONTH' });

  await roomAssignmentService.recordOnboarding({
    tenantId: tenant._id, propertyId, roomId: roomA._id, roomNo: 'A101', agreedRent: 8000,
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
  });

  // Transfer on September 20 — the business rule's own example.
  await roomAssignmentService.recordTransfer({
    tenantId: tenant._id, propertyId, roomId: roomB._id, roomNo: 'B202', agreedRent: 10000,
    transferDate: new Date('2026-09-20T00:00:00Z'),
  });
  // The route updates the tenant doc's live fields immediately (physical move).
  tenant.room = roomB._id; tenant.roomNo = 'B202'; tenant.agreedRent = 10000;
  await tenant.save();

  // Simulate a DELAYED September invoice generation happening AFTER the
  // transfer (e.g. via an on-demand electricity sync) — the caller here
  // passes the tenant's now-current (wrong-for-September) live values, the
  // way runMonthlyInvoiceGenerator's tenant list naively would. Assignment
  // history must override them.
  await generateMonthlyInvoices(OWNER_ID, '2026-09', [
    { tenantId: tenant._id, propertyId, unitId: tenant.room, rentAmount: tenant.agreedRent },
  ]);
  const septInvoice = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-09' });
  assert.equal(septInvoice.rentAmount, 8000, 'September must keep the OLD rent');
  assert.equal(septInvoice.roomNo, 'A101', 'September must keep the OLD room');
  assert.equal(String(septInvoice.unitId), String(roomA._id));

  // October, generated normally with the tenant's (now-correct) live values.
  await generateMonthlyInvoices(OWNER_ID, '2026-10', [
    { tenantId: tenant._id, propertyId, unitId: tenant.room, rentAmount: tenant.agreedRent },
  ]);
  const octInvoice = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-10' });
  assert.equal(octInvoice.rentAmount, 10000, 'October must use the NEW rent');
  assert.equal(octInvoice.roomNo, 'B202', 'October must use the NEW room');

  // Historical invoice must not have moved after October was generated.
  const septAgain = await RentInvoice.findById(septInvoice._id);
  assert.equal(septAgain.rentAmount, 8000);
  assert.equal(septAgain.roomNo, 'A101');
});

test('transfer on the 1st of the month: that month keeps the old rent, following month gets the new one', async () => {
  // Explicit rule (documented, not assumed): the calendar month the transfer
  // falls in always keeps the old assignment, regardless of which day within
  // that month it happens — including the 1st. New pricing starts the month
  // AFTER.
  const effective = nextBillingMonth(new Date('2026-10-01T04:00:00Z')); // early morning IST, still Oct 1 IST
  assert.equal(effective, '2026-11');
});

test('transfer on the last day of the month: IST boundary, not UTC, decides the month', async () => {
  // 2026-09-30T20:00:00Z is already 2026-10-01 01:30 IST — a naive UTC-based
  // .getMonth() would wrongly call this September.
  const lateSept = nextBillingMonth(new Date('2026-09-30T20:00:00Z'));
  assert.equal(lateSept, '2026-11', 'transfer instant is already October in IST, so new pricing starts November');

  // 2026-09-30T10:00:00Z is 2026-09-30 15:30 IST — genuinely still September.
  const stillSept = nextBillingMonth(new Date('2026-09-30T10:00:00Z'));
  assert.equal(stillSept, '2026-10');
});

test('legacy Rent: pending record for the transfer month is left alone; future pending record is updated', async () => {
  const loginId = 'RH-T-LEGACYRENT';
  await Rent.create({ tenantLoginId: loginId, rentAmount: 8000, totalDue: 8000, roomNumber: 'A101', collectionMonth: '2026-09', paymentStatus: 'pending' });
  await Rent.create({ tenantLoginId: loginId, rentAmount: 8000, totalDue: 8000, roomNumber: 'A101', collectionMonth: '2026-10', paymentStatus: 'pending' });

  const transferDate = new Date('2026-09-20T00:00:00Z');
  // Exactly the scoped query used in routes/tenantRoutes.js's transfer handler.
  await Rent.updateMany(
    { tenantLoginId: loginId, paymentStatus: 'pending', collectionMonth: { $gte: nextBillingMonth(transferDate) } },
    { $set: { rentAmount: 10000, totalDue: 10000, roomNumber: 'B202' } }
  );

  const sept = await Rent.findOne({ tenantLoginId: loginId, collectionMonth: '2026-09' });
  const oct = await Rent.findOne({ tenantLoginId: loginId, collectionMonth: '2026-10' });
  assert.equal(sept.rentAmount, 8000, 'the transfer-month pending record must NOT be silently changed');
  assert.equal(sept.roomNumber, 'A101');
  assert.equal(oct.rentAmount, 10000, 'a genuinely future pending record should pick up the new rent');
  assert.equal(oct.roomNumber, 'B202');
});

test('electricity: usage recorded before a transfer stays with the tenant who used it, not whoever moves in next', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'A101', 8000, 10); // ₹10/unit
  const roomB = await makeRoom(propertyId, 'B202', 10000, 12);

  const tenantA = await makeTenant({ propertyId, room: roomA, roomNo: 'A101', agreedRent: 8000, loginId: 'RH-T-ELEC-A' });
  await roomAssignmentService.recordOnboarding({
    tenantId: tenantA._id, propertyId, roomId: roomA._id, roomNo: 'A101', agreedRent: 8000,
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
  });
  // September's invoice already exists by the 20th (generated on the 1st, as
  // the real cron does) — this test is about attribution once a reading
  // comes in, not about the on-demand invoice-creation fallback, which needs
  // an owner lookup this fixture doesn't set up.
  await generateMonthlyInvoices(OWNER_ID, '2026-09', [{ tenantId: tenantA._id, propertyId, unitId: roomA._id, rentAmount: 8000 }]);

  // Sept 20: reading recorded for Room A while Tenant A is still there.
  const readRes = fakeRes();
  await electricityController.updateMeterReading(
    { body: { propertyId: String(propertyId), roomNo: 'A101', billingMonth: '2026-09', currentReading: 100, previousReading: 0 } },
    readRes
  );
  assert.equal(readRes.body.success, true);
  assert.equal(readRes.body.reading.totalBill, 1000); // 100 units * ₹10

  // Sept 25: Tenant A transfers out to Room B.
  await roomAssignmentService.recordTransfer({
    tenantId: tenantA._id, propertyId, roomId: roomB._id, roomNo: 'B202', agreedRent: 10000,
    transferDate: new Date('2026-09-25T00:00:00Z'),
  });
  tenantA.room = roomB._id; tenantA.roomNo = 'B202'; tenantA.agreedRent = 10000;
  await tenantA.save();

  // Sept 26: Tenant B moves into Room A.
  const tenantB = await makeTenant({ propertyId, room: roomA, roomNo: 'A101', agreedRent: 8000, loginId: 'RH-T-ELEC-B' });
  tenantB.moveInDate = new Date('2026-09-26T00:00:00Z');
  await tenantB.save();
  await roomAssignmentService.recordOnboarding({
    tenantId: tenantB._id, propertyId, roomId: roomA._id, roomNo: 'A101', agreedRent: 8000,
    effectiveFrom: istMonthStartUTC('2026-09'),
  });

  // September's Room A electricity must attribute to Tenant A, not Tenant B —
  // and Tenant B must not appear in September's split even though their
  // assignment row also nominally covers September (isEligibleForBillingMonth
  // excludes anyone who moved in during the billing month itself).
  const sync = await syncElectricityToInvoice(propertyId, 'A101', '2026-09', readRes.body.reading);
  assert.equal(sync.synced, true);
  assert.equal(sync.splitAmong, 1, 'only Tenant A should be billed for September Room A usage');
  const [result] = sync.results;
  assert.equal(String(result.tenantId), String(tenantA._id));

  const tenantAInvoice = await RentInvoice.findOne({ tenantId: tenantA._id, billingMonth: '2026-09' });
  assert.equal(tenantAInvoice.electricityBill, 1000);
  const tenantBInvoice = await RentInvoice.findOne({ tenantId: tenantB._id, billingMonth: '2026-09' });
  assert.equal(tenantBInvoice, null, 'Tenant B must not be billed for September Room A electricity at all');
});

test('multiple transfers (A -> B -> C): each month keeps its own room/rent independently', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'A1', 8000);
  const roomB = await makeRoom(propertyId, 'B1', 10000);
  const roomC = await makeRoom(propertyId, 'C1', 12000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'A1', agreedRent: 8000, loginId: 'RH-T-MULTI' });

  await roomAssignmentService.recordOnboarding({
    tenantId: tenant._id, propertyId, roomId: roomA._id, roomNo: 'A1', agreedRent: 8000,
    effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  });
  await generateMonthlyInvoices(OWNER_ID, '2026-09', [{ tenantId: tenant._id, propertyId, unitId: roomA._id, rentAmount: 8000 }]);

  await roomAssignmentService.recordTransfer({
    tenantId: tenant._id, propertyId, roomId: roomB._id, roomNo: 'B1', agreedRent: 10000,
    transferDate: new Date('2026-09-15T00:00:00Z'),
  });
  await generateMonthlyInvoices(OWNER_ID, '2026-10', [{ tenantId: tenant._id, propertyId, unitId: roomB._id, rentAmount: 10000 }]);

  await roomAssignmentService.recordTransfer({
    tenantId: tenant._id, propertyId, roomId: roomC._id, roomNo: 'C1', agreedRent: 12000,
    transferDate: new Date('2026-10-15T00:00:00Z'),
  });
  await generateMonthlyInvoices(OWNER_ID, '2026-11', [{ tenantId: tenant._id, propertyId, unitId: roomC._id, rentAmount: 12000 }]);

  const sept = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-09' });
  const oct = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-10' });
  const nov = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-11' });
  assert.equal(sept.rentAmount, 8000); assert.equal(sept.roomNo, 'A1');
  assert.equal(oct.rentAmount, 10000); assert.equal(oct.roomNo, 'B1');
  assert.equal(nov.rentAmount, 12000); assert.equal(nov.roomNo, 'C1');

  // The D transfer must not touch A/B/C's already-generated invoices.
  const roomD = await makeRoom(propertyId, 'D1', 15000);
  await roomAssignmentService.recordTransfer({
    tenantId: tenant._id, propertyId, roomId: roomD._id, roomNo: 'D1', agreedRent: 15000,
    transferDate: new Date('2026-11-15T00:00:00Z'),
  });
  const septAfter = await RentInvoice.findById(sept._id);
  const octAfter = await RentInvoice.findById(oct._id);
  const novAfter = await RentInvoice.findById(nov._id);
  assert.deepEqual([septAfter.rentAmount, septAfter.roomNo], [8000, 'A1']);
  assert.deepEqual([octAfter.rentAmount, octAfter.roomNo], [10000, 'B1']);
  assert.deepEqual([novAfter.rentAmount, novAfter.roomNo], [12000, 'C1']);
});

test('paid invoice/payment is never retroactively changed by a later transfer', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'PAID-A', 8000);
  const roomB = await makeRoom(propertyId, 'PAID-B', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'PAID-A', agreedRent: 8000, loginId: 'RH-T-PAID' });

  await roomAssignmentService.recordOnboarding({
    tenantId: tenant._id, propertyId, roomId: roomA._id, roomNo: 'PAID-A', agreedRent: 8000,
    effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  });
  await generateMonthlyInvoices(OWNER_ID, '2026-09', [{ tenantId: tenant._id, propertyId, unitId: roomA._id, rentAmount: 8000 }]);
  const invoice = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-09' });
  await RentInvoice.findByIdAndUpdate(invoice._id, { $set: { paidAmount: 8000, rentPaidAmount: 8000, status: 'PAID', outstandingAmount: 0 } });

  await roomAssignmentService.recordTransfer({
    tenantId: tenant._id, propertyId, roomId: roomB._id, roomNo: 'PAID-B', agreedRent: 10000,
    transferDate: new Date('2026-09-20T00:00:00Z'),
  });

  const after = await RentInvoice.findById(invoice._id);
  assert.equal(after.rentAmount, 8000);
  assert.equal(after.paidAmount, 8000);
  assert.equal(after.status, 'PAID');
  assert.equal(after.roomNo, 'PAID-A');
});

function fakeReq(overrides = {}) {
  return { params: {}, query: {}, body: {}, ...overrides };
}

test('full lifecycle: owner panel and tenant panel both show the correct historical room for each month', async () => {
  const propertyId = await makeProperty();
  const ownerId = new mongoose.Types.ObjectId();
  const roomA = await makeRoom(propertyId, 'PANEL-A', 8000);
  const roomB = await makeRoom(propertyId, 'PANEL-B', 10000);
  const tenant = await makeTenant({ propertyId, room: roomA, roomNo: 'PANEL-A', agreedRent: 8000, loginId: 'RH-T-PANEL' });

  // September: onboarded into Room A, invoice generated, tenant pays in full.
  await roomAssignmentService.recordOnboarding({
    tenantId: tenant._id, propertyId, roomId: roomA._id, roomNo: 'PANEL-A', agreedRent: 8000,
    effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  });
  await generateMonthlyInvoices(ownerId, '2026-09', [{ tenantId: tenant._id, propertyId, unitId: roomA._id, rentAmount: 8000 }]);
  const septInvoice = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-09' });
  await RentInvoice.findByIdAndUpdate(septInvoice._id, { $set: { paidAmount: 8000, rentPaidAmount: 8000, status: 'PAID', outstandingAmount: 0 } });
  await RentPayment.create({
    invoiceId: septInvoice._id, tenantId: tenant._id, propertyId, ownerId,
    amount: 8000, paymentMethod: 'cash', paymentDate: new Date('2026-09-05T00:00:00Z'),
  });

  // Mid-September: transfer to Room B.
  await roomAssignmentService.recordTransfer({
    tenantId: tenant._id, propertyId, roomId: roomB._id, roomNo: 'PANEL-B', agreedRent: 10000,
    transferDate: new Date('2026-09-20T00:00:00Z'),
  });
  tenant.room = roomB._id; tenant.roomNo = 'PANEL-B'; tenant.agreedRent = 10000;
  await tenant.save();

  // October: new invoice, new room, tenant pays.
  await generateMonthlyInvoices(ownerId, '2026-10', [{ tenantId: tenant._id, propertyId, unitId: tenant.room, rentAmount: tenant.agreedRent }]);
  const octInvoice = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth: '2026-10' });
  await RentPayment.create({
    invoiceId: octInvoice._id, tenantId: tenant._id, propertyId, ownerId,
    amount: 10000, paymentMethod: 'cash', paymentDate: new Date('2026-10-05T00:00:00Z'),
  });

  // ── Owner panel: exactly the controller function receipts.jsx calls ──────
  const ownerRes = fakeRes();
  await listPaymentsHandler(fakeReq({ user: { _id: ownerId, loginId: 'OWNER-PANEL-TEST' }, query: { limit: '50' } }), ownerRes);
  assert.equal(ownerRes.statusCode, 200);
  const payments = ownerRes.body.payments;
  const septPayment = payments.find(p => p.billingMonth === '2026-09');
  const octPayment = payments.find(p => p.billingMonth === '2026-10');
  assert.ok(septPayment, 'September payment must be in the owner panel list');
  assert.ok(octPayment, 'October payment must be in the owner panel list');
  assert.equal(septPayment.roomNo, 'PANEL-A', 'owner panel: September receipt must show Room A, not the tenant\'s current room');
  assert.equal(octPayment.roomNo, 'PANEL-B', 'owner panel: October receipt must show Room B');
  assert.equal(septPayment.rentAmount, 8000);
  assert.equal(octPayment.rentAmount, 10000);

  // ── Tenant panel: exactly the controller function tenantdashboard.jsx calls ──
  const tenantRes = fakeRes();
  await getTenantInvoiceSummary(fakeReq({ user: { loginId: tenant.loginId } }), tenantRes);
  assert.equal(tenantRes.statusCode, 200);
  const invoices = tenantRes.body.invoices || tenantRes.body.invoice ? tenantRes.body.invoices : [];
  const septInv = invoices.find(i => i.billingMonth === '2026-09');
  const octInv = invoices.find(i => i.billingMonth === '2026-10');
  assert.ok(septInv, 'September invoice must be in the tenant panel history');
  assert.ok(octInv, 'October invoice must be in the tenant panel history');
  assert.equal(septInv.roomNo, 'PANEL-A', 'tenant panel: September invoice must show Room A');
  assert.equal(octInv.roomNo, 'PANEL-B', 'tenant panel: October invoice must show Room B');

  // ── Historical integrity: re-check September is exactly as it was ────────
  const septAfter = await RentInvoice.findById(septInvoice._id);
  assert.equal(septAfter.rentAmount, 8000);
  assert.equal(septAfter.paidAmount, 8000);
  assert.equal(septAfter.status, 'PAID');
  assert.equal(septAfter.roomNo, 'PANEL-A');
  const septPaymentDoc = await RentPayment.findOne({ invoiceId: septInvoice._id });
  assert.equal(septPaymentDoc.amount, 8000);
});
