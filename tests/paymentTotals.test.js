'use strict';

/**
 * Result-equivalence tests for the find()+reduce() → $group/$sum conversion.
 *
 * SCOPE AND HONESTY NOTE
 * ──────────────────────
 * No MongoDB instance (real or in-memory) is available in this environment, so
 * these tests do NOT execute the pipelines against a database. They:
 *
 *   1. evaluate each pipeline with a faithful in-memory implementation of the
 *      exact operators used ($sum, $ifNull, $cond, $eq, $floor, $add, $multiply),
 *   2. run the ORIGINAL JavaScript reduce() against the same fixtures, and
 *   3. assert the two produce identical numbers.
 *
 * That verifies the pipeline shape and the equivalence reasoning. It does not
 * verify MongoDB's own behaviour or query plans — see the report's
 * "still required" section.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const svc = require('../services/paymentTotalsService');
const PaymentTransaction = require('../models/PaymentTransaction');
const RentPayment = require('../models/RentPayment');
const Enquiry = require('../models/Enquiry');

// ─────────────────────────────────────────────────────────────────────────────
// A faithful evaluator for the aggregation operators this service uses.
// ─────────────────────────────────────────────────────────────────────────────

function evalExpr(expr, doc) {
  if (typeof expr === 'number') return expr;
  if (typeof expr === 'string') {
    if (!expr.startsWith('$')) return expr;
    return expr.slice(1).split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
  }
  if (expr == null || typeof expr !== 'object') return expr;

  const [op] = Object.keys(expr);
  const arg = expr[op];
  switch (op) {
    case '$ifNull': {
      const v = evalExpr(arg[0], doc);
      return v === null || v === undefined ? evalExpr(arg[1], doc) : v;
    }
    case '$cond': {
      const [cond, t, f] = arg;
      return evalExpr(cond, doc) ? evalExpr(t, doc) : evalExpr(f, doc);
    }
    case '$eq': return evalExpr(arg[0], doc) === evalExpr(arg[1], doc);
    case '$add': return arg.reduce((a, e) => a + evalExpr(e, doc), 0);
    case '$multiply': return arg.reduce((a, e) => a * evalExpr(e, doc), 1);
    case '$floor': return Math.floor(evalExpr(arg, doc));
    default: throw new Error(`evaluator does not implement ${op}`);
  }
}

/** Runs a [{ $match }, { $group }] pipeline over an array of docs. */
function runPipeline(pipeline, docs) {
  let rows = docs;
  for (const stage of pipeline) {
    if (stage.$match) continue; // filtering is asserted separately, via mocks
    if (stage.$group) {
      const spec = stage.$group;
      if (rows.length === 0) return [];
      const out = { _id: null };
      for (const [key, acc] of Object.entries(spec)) {
        if (key === '_id') continue;
        if (!('$sum' in acc)) throw new Error(`unsupported accumulator in ${key}`);
        const inner = acc.$sum;
        out[key] = rows.reduce((total, doc) => {
          if (inner === 1) return total + 1;
          const v = evalExpr(inner, doc);
          return total + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        }, 0);
      }
      rows = [out];
    }
  }
  return rows;
}

/** Captures the pipeline a service call builds, and feeds it fixture docs. */
function withFixtures(t, Model, docs) {
  let captured = null;
  t.mock.method(Model, 'aggregate', async (pipeline) => {
    captured = pipeline;
    return runPipeline(pipeline, docs);
  });
  return () => captured;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. sumPaymentTransactions — replaces  find().select('owner_amount') + reduce
// ─────────────────────────────────────────────────────────────────────────────

const oldTxReduce = (docs) => docs.reduce((sum, t) => sum + (t.owner_amount || 0), 0);

const TX_CASES = [
  ['no transactions', []],
  ['one transaction', [{ owner_amount: 5000 }]],
  ['multiple transactions', [{ owner_amount: 5000 }, { owner_amount: 2500 }, { owner_amount: 125 }]],
  ['decimal amounts', [{ owner_amount: 1234.56 }, { owner_amount: 0.44 }]],
  ['zero amount', [{ owner_amount: 0 }, { owner_amount: 100 }]],
  ['missing field', [{}, { owner_amount: 300 }]],
  ['null field', [{ owner_amount: null }, { owner_amount: 300 }]],
  ['all zero', [{ owner_amount: 0 }, { owner_amount: 0 }]],
  ['large set', Array.from({ length: 5000 }, (_, i) => ({ owner_amount: i }))],
];

for (const [label, docs] of TX_CASES) {
  test(`EQUIVALENCE sumPaymentTransactions — ${label}`, async (t) => {
    withFixtures(t, PaymentTransaction, docs);
    const actual = await svc.sumPaymentTransactions({ owner_id: 'ROOMHY1' });
    assert.strictEqual(actual, oldTxReduce(docs), `${label}: aggregation must match the old reduce`);
    assert.strictEqual(typeof actual, 'number');
  });
}

test('sumPaymentTransactions returns 0 (not undefined) when nothing matches', async (t) => {
  withFixtures(t, PaymentTransaction, []);
  assert.strictEqual(await svc.sumPaymentTransactions({ owner_id: 'NOBODY' }), 0);
});

test('sumPaymentTransactions passes the caller filter through as $match verbatim', async (t) => {
  const captured = withFixtures(t, PaymentTransaction, []);
  const filter = { owner_id: 'ROOMHY1', property_id: 'PROP9' };
  await svc.sumPaymentTransactions(filter);
  assert.deepStrictEqual(captured()[0], { $match: filter }, 'owner/property scoping must not be altered');
  assert.deepStrictEqual(captured()[1].$group.total, { $sum: '$owner_amount' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. sumRentPayments — replaces  find().select('amount') + reduce
// ─────────────────────────────────────────────────────────────────────────────

const oldRentPaymentReduce = (docs) => docs.reduce((sum, r) => sum + (r.amount || 0), 0);

for (const [label, docs] of [
  ['no payments', []],
  ['one payment', [{ amount: 7000 }]],
  ['multiple payments', [{ amount: 7000 }, { amount: 3500 }]],
  ['decimals', [{ amount: 99.99 }, { amount: 0.01 }]],
  ['zero amount', [{ amount: 0 }, { amount: 50 }]],
  ['missing/null', [{}, { amount: null }, { amount: 10 }]],
]) {
  test(`EQUIVALENCE sumRentPayments — ${label}`, async (t) => {
    withFixtures(t, RentPayment, docs);
    const actual = await svc.sumRentPayments({ ownerId: new mongoose.Types.ObjectId() });
    assert.strictEqual(actual, oldRentPaymentReduce(docs));
  });
}

test('sumRentPayments preserves owner + property scoping', async (t) => {
  const captured = withFixtures(t, RentPayment, []);
  const ownerId = new mongoose.Types.ObjectId();
  const propertyId = new mongoose.Types.ObjectId();
  await svc.sumRentPayments({ ownerId, propertyId });
  assert.deepStrictEqual(captured()[0], { $match: { ownerId, propertyId } });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. sumEnquiryPaidAmounts — status filtering must stay at the call site
// ─────────────────────────────────────────────────────────────────────────────

test('EQUIVALENCE sumEnquiryPaidAmounts matches the old reduce', async (t) => {
  const docs = [{ paidAmount: 2000 }, { paidAmount: 0 }, {}, { paidAmount: 1500.5 }];
  withFixtures(t, Enquiry, docs);
  const actual = await svc.sumEnquiryPaidAmounts({ status: { $in: ['accepted'] } });
  assert.strictEqual(actual, docs.reduce((s, e) => s + (e.paidAmount || 0), 0));
});

test('sumEnquiryPaidAmounts keeps the accepted/approved/active status filter intact', async (t) => {
  const captured = withFixtures(t, Enquiry, []);
  const filter = {
    $or: [{ propertyId: { $in: [] } }, { ownerLoginId: 'ROOMHY1' }],
    status: { $in: ['accepted', 'approved', 'active'] },
  };
  await svc.sumEnquiryPaidAmounts(filter);
  assert.deepStrictEqual(captured()[0], { $match: filter },
    'cancelled/rejected enquiries must stay excluded by the caller filter');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. getAdminTransactionTotals — four metrics from one $group
// ─────────────────────────────────────────────────────────────────────────────

// The original implementation, verbatim, for comparison.
function oldAdminReduces(transactions) {
  return {
    totalRevenue: transactions.reduce((acc, t) => acc + (t.total_amount || t.booking_amount || 0), 0),
    totalCommission: transactions.reduce(
      (acc, t) => acc + (t.commission || Math.round((t.total_amount || t.booking_amount || 0) * 0.05)), 0),
    totalOwnerHeld: transactions.filter((t) => t.wallet_status === 'held')
      .reduce((acc, t) => acc + (t.owner_amount || Math.round((t.total_amount || 0) * 0.95)), 0),
    totalOwnerAvailable: transactions.filter((t) => t.wallet_status === 'available')
      .reduce((acc, t) => acc + (t.owner_amount || Math.round((t.total_amount || 0) * 0.95)), 0),
  };
}

const ADMIN_CASES = [
  ['empty collection', []],
  ['single held transaction', [{ booking_amount: 10000, owner_amount: 9500, wallet_status: 'held' }]],
  ['mixed wallet statuses', [
    { booking_amount: 10000, owner_amount: 9500, wallet_status: 'held' },
    { booking_amount: 20000, owner_amount: 19000, wallet_status: 'available' },
    { booking_amount: 5000, owner_amount: 4750, wallet_status: 'released' },
  ]],
  ['zero amounts', [{ booking_amount: 0, owner_amount: 0, wallet_status: 'held' }]],
  ['missing owner_amount', [{ booking_amount: 1000, wallet_status: 'available' }]],
  // Rounding boundary: booking_amount * 0.05 lands on exactly .5, where
  // MongoDB's $round (half-to-even) would disagree with JS Math.round.
  ['half-cent rounding boundary', [
    { booking_amount: 10, owner_amount: 9, wallet_status: 'held' },   // 0.5
    { booking_amount: 30, owner_amount: 28, wallet_status: 'held' },  // 1.5
    { booking_amount: 50, owner_amount: 47, wallet_status: 'held' },  // 2.5
    { booking_amount: 70, owner_amount: 66, wallet_status: 'held' },  // 3.5
  ]],
  ['decimal booking amounts', [{ booking_amount: 1234.56, owner_amount: 1172.83, wallet_status: 'available' }]],
  ['large set', Array.from({ length: 3000 }, (_, i) => ({
    booking_amount: i * 7,
    owner_amount: Math.round(i * 7 * 0.95),
    wallet_status: i % 2 ? 'held' : 'available',
  }))],
];

for (const [label, docs] of ADMIN_CASES) {
  test(`EQUIVALENCE getAdminTransactionTotals — ${label}`, async (t) => {
    withFixtures(t, PaymentTransaction, docs);
    const actual = await svc.getAdminTransactionTotals();
    const expected = oldAdminReduces(docs);

    assert.strictEqual(actual.totalRevenue, expected.totalRevenue, 'totalRevenue');
    assert.strictEqual(actual.totalCommission, expected.totalCommission, 'totalCommission');
    assert.strictEqual(actual.totalOwnerHeld, expected.totalOwnerHeld, 'totalOwnerHeld');
    assert.strictEqual(actual.totalOwnerAvailable, expected.totalOwnerAvailable, 'totalOwnerAvailable');
    assert.strictEqual(actual.transactionCount, docs.length, 'transactionCount');
  });
}

test('getAdminTransactionTotals returns zeros, not undefined, on an empty collection', async (t) => {
  withFixtures(t, PaymentTransaction, []);
  assert.deepStrictEqual(await svc.getAdminTransactionTotals(), {
    totalRevenue: 0, totalCommission: 0, totalOwnerHeld: 0, totalOwnerAvailable: 0, transactionCount: 0,
  });
});

test('commission uses $floor(x+0.5), never $round — they differ at exactly .5', () => {
  const src = read('services/paymentTotalsService.js');
  assert.match(src, /\$floor/, 'must use $floor to replicate Math.round half-up');
  assert.ok(!/\$round/.test(src.replace(/^\s*\*.*$/gm, '')),
    '$round rounds half-to-even and would change commission totals');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Dashboard response contract
// ─────────────────────────────────────────────────────────────────────────────

test('sumRent still returns a plain number and keeps the enquiry status rule', () => {
  const src = read('routes/dashboardRoutes.js');
  assert.match(src, /function sumRent\(enquiries, txTotal, rentPaymentsTotal\)/);
  assert.match(src, /\['accepted', 'approved', 'active'\]/, 'enquiry status rule unchanged');
  assert.match(src, /return enquiriesTotal \+ txTotal \+ rentPaymentsTotal;/);
});

test('GET /owners/:loginId/rent still responds with { totalRent }', () => {
  const src = read('routes/ownerRoutes.js');
  assert.match(src, /return res\.json\(\{ totalRent \}\);/);
});

test('admin wallet response keeps its metrics field names', () => {
  const src = read('controllers/walletController.js');
  for (const field of ['totalRevenue', 'totalCommission', 'totalOwnerHeld',
    'totalOwnerAvailable', 'totalAdminWithdrawn', 'availableAdminBalance']) {
    assert.ok(src.includes(field), `metrics.${field} must still be returned`);
  }
  assert.match(src, /payoutHistory: history/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Static regression guard — the anti-pattern must not come back
// ─────────────────────────────────────────────────────────────────────────────

test('no converted endpoint fetches payment documents just to sum them', () => {
  const banned = [
    ['routes/dashboardRoutes.js', /PaymentTransaction\.find\(|RentPayment\.find\(/],
    ['routes/ownerRoutes.js', /PaymentTransaction\.find\(\{ owner_id: loginId \}\)/],
  ];
  for (const [rel, pattern] of banned) {
    const offenders = read(rel).split('\n')
      .filter((l) => pattern.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    assert.deepStrictEqual(offenders, [], `${rel} reintroduced a document fetch for an aggregate-only total`);
  }
});

test('admin wallet no longer loads the entire PaymentTransaction collection', () => {
  const src = read('controllers/walletController.js');
  assert.ok(!/PaymentTransaction\.find\(\)/.test(src),
    'PaymentTransaction.find() with no filter loads every transaction into memory');
});

test('the aggregation service never uses .find() to compute a total', () => {
  const src = read('services/paymentTotalsService.js');
  // Strip comments first — the doc block deliberately quotes the old
  // find()+reduce() pattern to explain what this module replaced.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.find\(/.test(code), 'executable code must not fetch documents to compute a total');
  assert.match(code, /\$group/);
  assert.match(code, /\$sum/);
});
