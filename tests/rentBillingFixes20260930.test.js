'use strict';
// Regression tests for the rent/billing/payment (R-series) audit fix pass
// (2026-09-30, second half): the 5 financeController aggregation rewrites
// (getPlatformPayoutSummary already existed in rentController; the finance
// ones are getRevenueTracking, getRoomhyMonthlyRevenue, getOwnerMonthlyRevenue,
// getProfitLoss, getCashflowDashboard), listInvoices's real Mongo-level
// pagination + deleted-tenant exclusion, and the shared admin-balance helper
// used by both getAdminWalletBalance and withdrawAdminEarningsInstant.
// Uses the same in-memory replica-set pattern as tests/auditFixes20260930.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

test.before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri('rentBillingFixesTest'));
});

test.after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

// These aggregations are platform-wide (no owner/tenant scope to isolate by),
// so unlike the scoped-query tests elsewhere, leftover documents from an
// earlier test in this same run would silently pollute every sum. Clear via
// the Mongoose models themselves rather than guessed raw collection name
// strings (RentInvoice's real collection is 'rent_invoices', not the default
// 'rentinvoices' — guessing wrong here silently deletes nothing).
test.beforeEach(async () => {
  const RentPayment = require('../models/RentPayment');
  await Promise.all([
    Owner.deleteMany({}), Property.deleteMany({}), Tenant.deleteMany({}),
    RentInvoice.deleteMany({}), Rent.deleteMany({}), PaymentTransaction.deleteMany({}),
    RefundRequest.deleteMany({}), PayoutLog.deleteMany({}), PayoutRequest.deleteMany({}),
    RentPayment.deleteMany({}),
  ]);
});

const Owner = require('../models/Owner');
const Property = require('../models/Property');
const Tenant = require('../models/Tenant');
const RentInvoice = require('../models/RentInvoice');
const Rent = require('../models/Rent');
const PaymentTransaction = require('../models/PaymentTransaction');
const RefundRequest = require('../models/RefundRequest');
const PayoutLog = require('../models/PayoutLog');
const PayoutRequest = require('../models/PayoutRequest');

const financeController = require('../controllers/financeController');
const rentController = require('../controllers/rentController');
const rentCollectionController = require('../controllers/rentCollectionController');
const walletController = require('../controllers/walletController');

function fakeRes() {
  const res = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

let seq = 0;
const uniq = (p) => `${p}${Date.now()}${seq++}`;

async function makeOwner() {
  return Owner.create({ loginId: uniq('OWN'), name: 'Test Owner', email: `${uniq('owner')}@test.com`, phone: '9000000000' });
}
async function makeProperty(ownerLoginId) {
  return Property.create({ title: 'Test Property', ownerLoginId, city: 'Jaipur' });
}
async function makeTenant(propertyId, ownerLoginId, overrides = {}) {
  return Tenant.create({ name: 'Test Tenant', phone: '9111111111', property: propertyId, ownerLoginId, loginId: uniq('TEN'), status: 'active', ...overrides });
}
async function makeTx(overrides = {}) {
  return PaymentTransaction.create({
    booking_amount: 1000, commission_percentage: 10, commission_amount: 100, owner_amount: 900,
    status: 'Verified', payment_gateway: 'payu', ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getRevenueTracking — $group replaces a 3-field JS sum
// ─────────────────────────────────────────────────────────────────────────────

test('getRevenueTracking: $group sums match a hand-computed total', async () => {
  await makeTx({ booking_amount: 1000, commission_amount: 100, owner_amount: 900 });
  await makeTx({ booking_amount: 2000, commission_amount: 200, owner_amount: 1800 });
  await makeTx({ booking_amount: 500, commission_amount: 50, owner_amount: 450 });

  const req = {};
  const res = fakeRes();
  await financeController.getRevenueTracking(req, res);

  assert.equal(res.body.success, true);
  assert.equal(res.body.metrics.totalCollected, 3500);
  assert.equal(res.body.metrics.totalCommissions, 350);
  assert.equal(res.body.metrics.totalOwnerEarnings, 3150);
});

// ─────────────────────────────────────────────────────────────────────────────
// getRoomhyMonthlyRevenue — $month grouping, 1-12 vs JS 0-11 indexing
// ─────────────────────────────────────────────────────────────────────────────

test('getRoomhyMonthlyRevenue: buckets by calendar month correctly (index off-by-one check)', async () => {
  // January transaction — must land at data[0] ("Jan"), not data[1].
  await makeTx({ booking_amount: 5000, commission_amount: 500, payment_date: new Date('2026-01-15T00:00:00Z') });
  // December transaction — must land at data[11] ("Dec").
  await makeTx({ booking_amount: 7000, commission_amount: 700, payment_date: new Date('2026-12-20T00:00:00Z') });
  // No payment_date — must be excluded entirely (matches original
  // `if (!t.payment_date) return`). The schema defaults payment_date to
  // Date.now(), so a normal .create() can never actually produce a dateless
  // document — bypass Mongoose with a raw driver insert to construct one.
  await PaymentTransaction.collection.insertOne({
    booking_amount: 99999, commission_amount: 9999, commission_percentage: 10, owner_amount: 89999,
    status: 'Verified', payment_gateway: 'payu',
  });

  const req = {};
  const res = fakeRes();
  await financeController.getRoomhyMonthlyRevenue(req, res);

  assert.equal(res.body.success, true);
  const data = res.body.roomhyRevenue;
  assert.equal(data.length, 12);
  assert.equal(data[0].month, 'Jan');
  assert.equal(data[0].revenue, 5000);
  assert.equal(data[0].commission, 500);
  assert.equal(data[11].month, 'Dec');
  assert.equal(data[11].revenue, 7000);
  const totalAcrossMonths = data.reduce((s, m) => s + m.revenue, 0);
  assert.equal(totalAcrossMonths, 12000, 'the undated 99999 transaction must not be counted anywhere');
});

// ─────────────────────────────────────────────────────────────────────────────
// getOwnerMonthlyRevenue — $group by owner_name/owner_id/'Unknown Owner' precedence
// ─────────────────────────────────────────────────────────────────────────────

test('getOwnerMonthlyRevenue: groups by owner_name, falls back to owner_id, then Unknown Owner', async () => {
  await makeTx({ booking_amount: 1000, commission_amount: 100, owner_amount: 900, owner_name: 'Alice Owner', owner_id: 'OWN1' });
  await makeTx({ booking_amount: 2000, commission_amount: 200, owner_amount: 1800, owner_name: 'Alice Owner', owner_id: 'OWN1' });
  await makeTx({ booking_amount: 500, commission_amount: 50, owner_amount: 450, owner_name: '', owner_id: 'OWN2' });
  // NOTE: PaymentTransaction's own pre('save') hook (models/PaymentTransaction.js)
  // coerces an empty owner_id to the literal string 'N/A' before it ever
  // reaches this aggregation — so a real doc can never carry a truly-empty
  // owner_id, and the 'Unknown Owner' branch (both empty) is unreachable
  // through normal writes. This still exercises the owner_name-empty fallback,
  // it just lands on the hook's 'N/A' rather than 'Unknown Owner'.
  await makeTx({ booking_amount: 300, commission_amount: 30, owner_amount: 270, owner_name: '', owner_id: '' });

  const req = {};
  const res = fakeRes();
  await financeController.getOwnerMonthlyRevenue(req, res);

  assert.equal(res.body.success, true);
  const rows = res.body.ownerRevenue;
  const alice = rows.find(r => r.owner === 'Alice Owner');
  const own2 = rows.find(r => r.owner === 'OWN2');
  const na = rows.find(r => r.owner === 'N/A');
  assert.ok(alice, 'Alice Owner group must exist');
  assert.equal(alice.gross, 3000);
  assert.equal(alice.commission, 300);
  assert.equal(alice.net, 2700);
  assert.ok(own2, 'falls back to owner_id when owner_name is empty');
  assert.equal(own2.gross, 500);
  assert.ok(na, 'falls back to owner_id (here the schema-hook default \'N/A\') when owner_name is empty');
  assert.equal(na.gross, 300);
});

// ─────────────────────────────────────────────────────────────────────────────
// getProfitLoss — two collections, $group replacing two JS reduces
// ─────────────────────────────────────────────────────────────────────────────

test('getProfitLoss: revenue/commission from transactions minus processed refunds', async () => {
  await makeTx({ booking_amount: 1000, commission_amount: 100 });
  await makeTx({ booking_amount: 2000, commission_amount: 200 });
  await RefundRequest.create({
    booking_id: 'B1', user_id: 'U1', payment_id: 'P1', user_name: 'T1', user_phone: '9000000001',
    request_type: 'refund', refund_status: 'processed', refund_amount: 50,
  });
  await RefundRequest.create({
    booking_id: 'B2', user_id: 'U2', payment_id: 'P2', user_name: 'T2', user_phone: '9000000002',
    request_type: 'refund', refund_status: 'pending', refund_amount: 99999, // must NOT count — not 'processed'
  });

  const req = {};
  const res = fakeRes();
  await financeController.getProfitLoss(req, res);

  assert.equal(res.body.success, true);
  const pl = res.body.profitLoss;
  assert.equal(pl.grossRevenue, 3000);
  assert.equal(pl.commissionRevenue, 300);
  assert.equal(pl.outflowsRefunds, 50, 'the pending (non-processed) refund must be excluded');
  assert.equal(pl.netOperatingIncome, 250);
});

// ─────────────────────────────────────────────────────────────────────────────
// getCashflowDashboard — three collections, each grouped by their own date field
// ─────────────────────────────────────────────────────────────────────────────

test('getCashflowDashboard: inflow from transactions, outflow from payouts + refunds, same month bucket', async () => {
  await makeTx({ booking_amount: 4000, payment_date: new Date('2026-03-10T00:00:00Z') });
  await PayoutLog.create({
    transaction_id: 'TX1', owner_id: 'OWN1', amount: 1000, status: 'sandbox_success',
    created_at: new Date('2026-03-12T00:00:00Z'),
  });
  await PayoutLog.create({
    transaction_id: 'TX2', owner_id: 'OWN1', amount: 99999, status: 'failed', // must NOT count
    created_at: new Date('2026-03-12T00:00:00Z'),
  });
  await RefundRequest.create({
    booking_id: 'B3', user_id: 'U3', payment_id: 'P3', user_name: 'T3', user_phone: '9000000003',
    request_type: 'refund', refund_status: 'processed', refund_amount: 200, refund_date: new Date('2026-03-15T00:00:00Z'),
  });

  const req = {};
  const res = fakeRes();
  await financeController.getCashflowDashboard(req, res);

  assert.equal(res.body.success, true);
  const march = res.body.cashflow.find(m => m.month === 'Mar');
  assert.equal(march.inflow, 4000);
  assert.equal(march.outflow, 1200, 'payout (1000) + processed refund (200) = 1200; the pending payout must be excluded');
});

// ─────────────────────────────────────────────────────────────────────────────
// listInvoices — real Mongo-level pagination + deleted-tenant exclusion folded
// into the same stage (not applied after paginating)
// ─────────────────────────────────────────────────────────────────────────────

test('listInvoices: paginates at the Mongo level and excludes deleted-tenant invoices from BOTH the page and the total', async () => {
  const owner = await makeOwner();
  const property = await makeProperty(owner.loginId);
  const liveTenant = await makeTenant(property._id, owner.loginId);
  const deletedTenant = await makeTenant(property._id, owner.loginId, { isDeleted: true });

  // Distinct billingMonth per invoice — RentInvoice has a unique
  // {tenantId, billingMonth} index (one invoice per tenant per month), so
  // reusing the same month for one tenant's 5 invoices would collide.
  const makeInvoice = (tenantId, i) => RentInvoice.create({
    invoiceNumber: uniq('INV'), ownerId: owner._id, propertyId: property._id, tenantId,
    billingMonth: `2026-0${i}`, rentAmount: 1000, dueDate: new Date(`2026-0${i}-01T00:00:00Z`), status: 'PENDING',
  });

  // 5 invoices for the live tenant, 2 for the deleted tenant (should never appear).
  for (let i = 1; i <= 5; i++) await makeInvoice(liveTenant._id, i);
  await makeInvoice(deletedTenant._id, 6);
  await makeInvoice(deletedTenant._id, 7);

  const req = { user: { _id: owner._id, loginId: owner.loginId }, query: { page: '1', limit: '2' } };
  const res = fakeRes();
  await rentCollectionController.listInvoices(req, res);

  assert.equal(res.body.success, true);
  assert.equal(res.body.invoices.length, 2, 'page size respected at the Mongo level');
  assert.equal(res.body.total, 5, 'total must count only the live tenant\'s invoices, not the 7 raw rows');
  assert.equal(res.body.pages, 3);
  for (const inv of res.body.invoices) {
    assert.equal(String(inv.tenantId._id), String(liveTenant._id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// repairMissingPayments — an owner can no longer repair another owner's invoices
// ─────────────────────────────────────────────────────────────────────────────

test('repairMissingPayments: an authenticated owner only repairs their OWN paid invoices, not every owner\'s', async () => {
  const ownerA = await makeOwner();
  const ownerB = await makeOwner();
  const propA = await makeProperty(ownerA.loginId);
  const propB = await makeProperty(ownerB.loginId);
  const tenantA = await makeTenant(propA._id, ownerA.loginId);
  const tenantB = await makeTenant(propB._id, ownerB.loginId);

  const invA = await RentInvoice.create({
    invoiceNumber: uniq('INV'), ownerId: ownerA._id, propertyId: propA._id, tenantId: tenantA._id,
    billingMonth: '2026-09', rentAmount: 1000, totalDue: 1000, dueDate: new Date(), status: 'PAID',
  });
  const invB = await RentInvoice.create({
    invoiceNumber: uniq('INV'), ownerId: ownerB._id, propertyId: propB._id, tenantId: tenantB._id,
    billingMonth: '2026-09', rentAmount: 1000, totalDue: 1000, dueDate: new Date(), status: 'PAID',
  });

  const req = { user: { _id: ownerA._id, loginId: ownerA.loginId, role: 'owner' }, body: {} };
  const res = fakeRes();
  await rentCollectionController.repairMissingPayments(req, res);

  assert.equal(res.body.success, true);
  const RentPayment = require('../models/RentPayment');
  const paymentForA = await RentPayment.findOne({ invoiceId: invA._id });
  const paymentForB = await RentPayment.findOne({ invoiceId: invB._id });
  assert.ok(paymentForA, 'owner A\'s own invoice must have been repaired');
  assert.equal(paymentForB, null, 'owner B\'s invoice must NOT have been touched by owner A\'s repair call');
});

// ─────────────────────────────────────────────────────────────────────────────
// getRentsByOwner / getAllRents — Tenant lookup scoped correctly
// ─────────────────────────────────────────────────────────────────────────────

test('getRentsByOwner: active-tenant allow-list is scoped to this owner, not every tenant platform-wide', async () => {
  const ownerA = await makeOwner();
  const ownerB = await makeOwner();
  const propA = await makeProperty(ownerA.loginId);
  const propB = await makeProperty(ownerB.loginId);
  const tenantA = await makeTenant(propA._id, ownerA.loginId);
  const tenantB = await makeTenant(propB._id, ownerB.loginId);

  await Rent.create({ ownerLoginId: ownerA.loginId, tenantId: tenantA._id, collectionMonth: '2026-09', rentAmount: 1000, paymentStatus: 'pending' });
  // A Rent row that (by data error or otherwise) references owner A's loginId
  // but tenant B — must not surface once B is excluded from A's active-tenant set.
  await Rent.create({ ownerLoginId: ownerA.loginId, tenantId: tenantB._id, collectionMonth: '2026-09', rentAmount: 500, paymentStatus: 'pending' });

  const req = { params: { ownerLoginId: ownerA.loginId }, query: {}, user: { loginId: ownerA.loginId } };
  const res = fakeRes();
  await rentController.getRentsByOwner(req, res);

  assert.equal(res.body.success, true);
  assert.equal(res.body.rents.length, 1, 'only the rent tied to owner A\'s own active tenant should match the $or clause');
});

// ─────────────────────────────────────────────────────────────────────────────
// withdrawAdminEarningsInstant — shared balance function matches getAdminWalletBalance
// ─────────────────────────────────────────────────────────────────────────────

test('withdrawAdminEarningsInstant: available balance matches what getAdminWalletBalance reports (same shared function)', async () => {
  await makeTx({ booking_amount: 10000, commission_amount: 1000, status: 'Verified' });
  await PayoutRequest.create({ login_id: 'ADMIN', user_type: 'admin', status: 'SUCCESS', amount: 200 });

  const balRes = fakeRes();
  await walletController.getAdminWalletBalance({}, balRes);
  const expectedAvailable = balRes.body.metrics.availableAdminBalance;
  assert.ok(expectedAvailable > 0, 'sanity: there should be some available balance from the seeded transaction');

  // Ask to withdraw exactly 1 more than available — must be rejected, proving
  // withdrawAdminEarningsInstant is reading the SAME number getAdminWalletBalance
  // computed, not a stale/independent one from the old fake-req/res call.
  const req = { body: { amount: expectedAvailable + 1 } };
  const res = fakeRes();
  await walletController.withdrawAdminEarningsInstant(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Insufficient admin earnings/);
  assert.match(res.body.message, new RegExp(`₹${expectedAvailable}`), 'the rejection message must quote the exact same available amount');
});
