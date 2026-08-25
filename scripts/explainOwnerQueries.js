'use strict';

/**
 * explainOwnerQueries.js — READ-ONLY query-plan comparison.
 *
 * Runs each owner-dashboard query twice against the live database — once in the
 * old case-insensitive-regex form and once in the new exact-match form — and
 * prints the plan stage, keys examined, docs examined and execution time for
 * each. This is the evidence that the change did what it claims.
 *
 *   node scripts/explainOwnerQueries.js ROOMHY9999
 *
 * Reads only. `explain` does not execute writes and does not mutate anything.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const loginId = (process.argv[2] || '').trim().toUpperCase();
if (!loginId) {
  console.error('Usage: node scripts/explainOwnerQueries.js <OWNER_LOGIN_ID>');
  process.exit(1);
}

const summarize = (plan) => {
  const ex = plan.executionStats || {};
  const stages = [];
  let stage = ex.executionStages;
  while (stage) {
    stages.push(stage.stage);
    stage = stage.inputStage;
  }
  return {
    stage: stages.includes('IXSCAN') ? 'IXSCAN' : (stages.includes('COLLSCAN') ? 'COLLSCAN' : stages[0] || '?'),
    chain: stages.join(' ← '),
    nReturned: ex.nReturned,
    keysExamined: ex.totalKeysExamined,
    docsExamined: ex.totalDocsExamined,
    ms: ex.executionTimeMillis,
    indexName: plan.queryPlanner?.winningPlan?.inputStage?.indexName
      || plan.queryPlanner?.winningPlan?.inputStage?.inputStage?.indexName
      || '—',
  };
};

const row = (label, s) =>
  `  ${label.padEnd(10)} ${String(s.stage).padEnd(9)} ` +
  `keys=${String(s.keysExamined).padStart(7)} docs=${String(s.docsExamined).padStart(7)} ` +
  `returned=${String(s.nReturned).padStart(6)} ${String(s.ms).padStart(5)}ms  idx=${s.indexName}`;

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('MONGO_URI is not set.'); process.exit(1); }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  console.log(`Database: ${mongoose.connection.name}   Owner: ${loginId}\n`);

  const regex = new RegExp('^' + loginId + '$', 'i');

  const cases = [
    ['owners',              'loginId',      { loginId: regex },                                    { loginId }],
    ['properties',          'ownerLoginId', { ownerLoginId: regex, isDeleted: { $ne: true } },     { ownerLoginId: loginId, isDeleted: { $ne: true } }],
    ['enquiries',           'ownerLoginId', { ownerLoginId: regex },                               { ownerLoginId: loginId }],
    ['notifications',       'toLoginId',    { toLoginId: regex },                                  { toLoginId: loginId }],
    ['complaints',          'ownerLoginId', { ownerLoginId: regex },                               { ownerLoginId: loginId }],
    ['paymenttransactions', 'owner_id',     { owner_id: regex },                                   { owner_id: loginId }],
    ['tenants',             'ownerLoginId', { ownerLoginId: regex, isDeleted: { $ne: true } },     { ownerLoginId: loginId, isDeleted: { $ne: true } }],
  ];

  let improved = 0;
  for (const [collName, field, beforeFilter, afterFilter] of cases) {
    const exists = await db.listCollections({ name: collName }).hasNext();
    if (!exists) { console.log(`${collName}.${field}: collection not present — skipped\n`); continue; }

    const coll = db.collection(collName);
    const before = summarize(await coll.find(beforeFilter).explain('executionStats'));
    const after  = summarize(await coll.find(afterFilter).explain('executionStats'));

    console.log(`${collName}.${field}`);
    console.log(row('BEFORE', before));
    console.log(row('AFTER', after));

    if (before.stage === 'COLLSCAN' && after.stage === 'IXSCAN') {
      improved += 1;
      console.log(`  → COLLSCAN eliminated. Docs examined ${before.docsExamined} → ${after.docsExamined}.`);
    } else if (after.stage === 'COLLSCAN') {
      console.log(`  ⚠ still COLLSCAN — check that an index on "${field}" exists on this collection.`);
    }
    if (before.nReturned !== after.nReturned) {
      console.log(`  ⚠ RESULT COUNT CHANGED (${before.nReturned} → ${after.nReturned}).`);
      console.log('    Non-canonical values exist in this collection. Run');
      console.log('    scripts/auditLoginIdCase.js and migrate before deploying.');
    }
    console.log('');
  }

  console.log(`Queries moved from COLLSCAN to IXSCAN: ${improved}/${cases.length}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('explain run failed:', err); process.exit(1); });
