'use strict';
// Validates the classification LOGIC in scripts/analyze-room-history-backfill.js
// against controlled fixtures. This never connects to real data — the script
// itself has no write path at all (see its file header), and this test only
// exercises `classifyTenant`, exported for exactly this purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri('backfillAnalysisTest'));
});

test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

const Room = require('../models/Room');
const RentInvoice = require('../models/RentInvoice');
const RoomAssignmentHistory = require('../models/RoomAssignmentHistory');
const { classifyTenant } = require('../scripts/analyze-room-history-backfill');

async function makeProperty() { return new mongoose.Types.ObjectId(); }
async function makeRoom(propertyId, title) { return Room.create({ property: propertyId, title, price: 8000 }); }
async function makeInvoice({ tenantId, propertyId, billingMonth, unitId, rentAmount = 8000 }) {
  return RentInvoice.create({
    invoiceNumber: `INV-${billingMonth}-${tenantId}`.slice(0, 40) + Math.random().toString(36).slice(2, 6),
    ownerId: new mongoose.Types.ObjectId(), propertyId, tenantId, unitId, billingMonth,
    rentAmount, dueDate: new Date(`${billingMonth}-01`), totalDue: rentAmount, outstandingAmount: 0,
  });
}

test('fixture 1: tenant with one known historical room -> DETERMINISTIC, one segment', async () => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'FIX1-A');
  const tenantId = new mongoose.Types.ObjectId();
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-06', unitId: room._id });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-07', unitId: room._id });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-08', unitId: room._id });

  const result = await classifyTenant(tenantId, RentInvoice, Room);
  assert.equal(result.status, 'DETERMINISTIC');
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].roomNo, 'FIX1-A');
  assert.equal(result.segments[0].fromMonth, '2026-06');
  assert.equal(result.segments[0].toMonth, '2026-08');
  assert.equal(result.segments[0].invoiceCount, 3);
});

test('fixture 2: multiple provable room assignments -> DETERMINISTIC, multiple segments', async () => {
  const propertyId = await makeProperty();
  const roomA = await makeRoom(propertyId, 'FIX2-A');
  const roomB = await makeRoom(propertyId, 'FIX2-B');
  const tenantId = new mongoose.Types.ObjectId();
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-06', unitId: roomA._id, rentAmount: 8000 });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-07', unitId: roomA._id, rentAmount: 8000 });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-08', unitId: roomB._id, rentAmount: 10000 });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-09', unitId: roomB._id, rentAmount: 10000 });

  const result = await classifyTenant(tenantId, RentInvoice, Room);
  assert.equal(result.status, 'DETERMINISTIC');
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].roomNo, 'FIX2-A');
  assert.equal(result.segments[0].toMonth, '2026-07');
  assert.equal(result.segments[1].roomNo, 'FIX2-B');
  assert.equal(result.segments[1].fromMonth, '2026-08');
  assert.equal(result.segments[1].agreedRent, 10000);
});

test('fixture 3a: ambiguous — missing unitId', async () => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'FIX3A');
  const tenantId = new mongoose.Types.ObjectId();
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-06', unitId: room._id });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-07', unitId: null });

  const result = await classifyTenant(tenantId, RentInvoice, Room);
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reason, 'missing_unitId');
});

test('fixture 3b: ambiguous — unitId points at a deleted room', async () => {
  const propertyId = await makeProperty();
  const tenantId = new mongoose.Types.ObjectId();
  const deletedRoomId = new mongoose.Types.ObjectId();
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-06', unitId: deletedRoomId });

  const result = await classifyTenant(tenantId, RentInvoice, Room);
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reason, 'unitId_room_deleted');
});

test('fixture 3c: ambiguous — gap in billing-month sequence', async () => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'FIX3C');
  const tenantId = new mongoose.Types.ObjectId();
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-06', unitId: room._id });
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-08', unitId: room._id });

  const result = await classifyTenant(tenantId, RentInvoice, Room);
  assert.equal(result.status, 'AMBIGUOUS');
  assert.equal(result.reason, 'billing_month_gap');
});

test('fixture 4: no reconstructable history -> NO_HISTORY', async () => {
  const tenantId = new mongoose.Types.ObjectId();
  const result = await classifyTenant(tenantId, RentInvoice, Room);
  assert.equal(result.status, 'NO_HISTORY');
  assert.equal(result.invoiceCount, 0);
});

test('fixture 5: tenant transferred post-deploy is recognized as already covered', async () => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'FIX5');
  const tenantId = new mongoose.Types.ObjectId();
  await RoomAssignmentHistory.create({
    tenantId, propertyId, roomId: room._id, roomNo: 'FIX5', agreedRent: 8000,
    effectiveFrom: new Date('2026-09-01T00:00:00Z'), effectiveTo: null, reason: 'transfer',
  });
  const alreadyHasHistory = await RoomAssignmentHistory.exists({ tenantId });
  assert.ok(alreadyHasHistory);
});

test('the script never writes anything', async () => {
  const propertyId = await makeProperty();
  const room = await makeRoom(propertyId, 'NOWRITE');
  const tenantId = new mongoose.Types.ObjectId();
  await makeInvoice({ tenantId, propertyId, billingMonth: '2026-06', unitId: room._id });

  const invoiceCountBefore = await RentInvoice.countDocuments();
  const historyCountBefore = await RoomAssignmentHistory.countDocuments();
  await classifyTenant(tenantId, RentInvoice, Room);
  await classifyTenant(new mongoose.Types.ObjectId(), RentInvoice, Room);
  assert.equal(await RentInvoice.countDocuments(), invoiceCountBefore);
  assert.equal(await RoomAssignmentHistory.countDocuments(), historyCountBefore);
});

test('the script module has no write/apply code path at all', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../scripts/analyze-room-history-backfill.js'), 'utf8'
  );
  // The string "--apply" appears in a comment explaining there's no such
  // flag — check there's no CODE that checks for it (args.includes/=== etc.),
  // not just absence of the substring anywhere in the file.
  assert.doesNotMatch(src, /args\.(includes|indexOf)\(['"]--apply['"]\)/);
  assert.doesNotMatch(src, /RoomAssignmentHistory\.(create|insertMany|updateOne|updateMany|findOneAndUpdate)/);
  assert.doesNotMatch(src, /RentInvoice\.(create|insertMany|updateOne|updateMany|findOneAndUpdate)/);
});
