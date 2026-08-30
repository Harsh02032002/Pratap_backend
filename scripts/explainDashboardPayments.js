'use strict';

/**
 * explainDashboardPayments.js — READ-ONLY before/after comparison.
 *
 *   node scripts/explainDashboardPayments.js ROOMHY3259
 *
 * For each converted total it runs BOTH implementations against the same live
 * data and reports:
 *
 *   • the OLD path — find() + reduce() in Node — with its explain() plan,
 *     document count and the number it produced;
 *   • the NEW path — $match + $group/$sum — with its explain() plan and number.
 *
 * It asserts the two numbers match. Any mismatch is a correctness regression
 * and must be investigated before the change ships.
 *
 * Reads only. explain() does not execute writes.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const loginId = (process.argv[2] || '').trim().toUpperCase();
if (!loginId) {
  console.error('Usage: node scripts/explainDashboardPayments.js <OWNER_LOGIN_ID>');
  process.exit(1);
}

const planOf = (explain) => {
  const stages = [];
  let s = explain?.executionStats?.executionStages
    || explain?.stages?.[0]?.$cursor?.executionStats?.executionStages;
  const ex = explain?.executionStats || explain?.stages?.[0]?.$cursor?.executionStats || {};
  while (s) { stages.push(s.stage); s = s.inputStage; }
  return {
    stage: stages.includes('IXSCAN') ? 'IXSCAN' : (stages.includes('COLLSCAN') ? 'COLLSCAN' : (stages[0] || '?')),
    keys: ex.totalKeysExamined ?? '?',
    docs: ex.totalDocsExamined ?? '?',
    returned: ex.nReturned ?? '?',
    ms: ex.executionTimeMillis ?? '?',
  };
};

const row = (label, p) =>
  `  ${label.padEnd(7)} ${String(p.stage).padEnd(9)} keys=${String(p.keys).padStart(8)} ` +
  `docs=${String(p.docs).padStart(8)} returned=${String(p.returned).padStart(7)} ${String(p.ms).padStart(6)}ms`;

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('MONGO_URI is not set.'); process.exit(1); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const PaymentTransaction = require('../models/PaymentTransaction');
  const RentPayment = require('../models/RentPayment');
  const Enquiry = require('../models/Enquiry');
  const Owner = require('../models/Owner');
  const Property = require('../models/Property');

  const ownerDoc = await Owner.findOne({ loginId }).select('_id').lean();
  const props = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id').lean();
  const propertyIds = props.map((p) => p._id);

  const cases = [
    {
      name: 'PaymentTransaction → owner_amount',
      Model: PaymentTransaction,
      match: { owner_id: loginId },
      field: 'owner_amount',
      oldSum: (docs) => docs.reduce((s, t) => s + (t.owner_amount || 0), 0),
    },
    ownerDoc && {
      name: 'RentPayment → amount',
      Model: RentPayment,
      match: { ownerId: ownerDoc._id },
      field: 'amount',
      oldSum: (docs) => docs.reduce((s, r) => s + (r.amount || 0), 0),
    },
    {
      name: 'Enquiry → paidAmount',
      Model: Enquiry,
      match: {
        $or: [{ propertyId: { $in: propertyIds } }, { ownerLoginId: loginId }],
        status: { $in: ['accepted', 'approved', 'active'] },
      },
      field: 'paidAmount',
      oldSum: (docs) => docs.reduce((s, e) => s + (e.paidAmount || 0), 0),
    },
  ].filter(Boolean);

  console.log(`Database: ${mongoose.connection.name}   Owner: ${loginId}\n`);
  let mismatches = 0;

  for (const c of cases) {
    // OLD path
    const oldDocs = await c.Model.find(c.match).select(c.field).lean();
    const oldPlan = planOf(await c.Model.find(c.match).select(c.field).explain('executionStats'));
    const oldTotal = c.oldSum(oldDocs);

    // NEW path
    const pipeline = [{ $match: c.match }, { $group: { _id: null, total: { $sum: `$${c.field}` } } }];
    const [newRow] = await c.Model.aggregate(pipeline);
    const newTotal = newRow?.total ?? 0;
    const newPlan = planOf(await c.Model.aggregate(pipeline).explain('executionStats'));

    console.log(c.name);
    console.log(row('BEFORE', oldPlan) + `   docsToNode=${oldDocs.length}  total=${oldTotal}`);
    console.log(row('AFTER', newPlan) + `   docsToNode=1  total=${newTotal}`);

    if (oldTotal !== newTotal) {
      mismatches++;
      console.log(`  ❌ MISMATCH: ${oldTotal} (old) vs ${newTotal} (new)`);
    } else {
      console.log(`  ✅ totals match (${newTotal}); documents transferred to Node: ${oldDocs.length} → 1`);
    }
    if (newPlan.stage === 'COLLSCAN') {
      console.log(`  ⚠ $match is a COLLSCAN — check the index backing ${JSON.stringify(Object.keys(c.match))}`);
    }
    console.log('');
  }

  console.log(mismatches === 0
    ? '✅ every converted total matches the original implementation.'
    : `❌ ${mismatches} mismatch(es) — do not ship.`);

  await mongoose.disconnect();
  process.exit(mismatches === 0 ? 0 : 1);
})().catch((err) => { console.error('explain run failed:', err); process.exit(1); });
