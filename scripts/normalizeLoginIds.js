'use strict';

/**
 * normalizeLoginIds.js — identifier case migration.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless you pass --apply.
 *
 *   node scripts/auditLoginIdCase.js          # 1. inspect (read-only)
 *   node scripts/normalizeLoginIds.js         # 2. dry run — shows every write
 *   node scripts/normalizeLoginIds.js --apply # 3. execute
 *
 * Safety rules this script enforces:
 *   - It never deletes a document.
 *   - It never overwrites a document that would collide with another after
 *     normalization; those are reported and skipped, for a human to resolve.
 *   - It skips exempt values (role sentinels such as 'superadmin', and any
 *     value containing '@', which is an email used as a login identifier).
 *   - It updates via the raw driver, bypassing Mongoose middleware, so no
 *     unrelated hook fires mid-migration.
 *
 * Take a backup first — `npm run backup:db`.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const TARGETS = {
  owners:              ['loginId'],
  tenants:             ['loginId', 'ownerLoginId'],
  properties:          ['ownerLoginId'],
  employees:           ['loginId', 'parentLoginId'],
  enquiries:           ['ownerLoginId'],
  complaints:          ['ownerLoginId', 'tenantLoginId'],
  maintenancetasks:    ['ownerLoginId'],
  staffattendances:    ['ownerLoginId'],
  staffsalaries:       ['ownerLoginId'],
  staffshifts:         ['ownerLoginId'],
  paymenttransactions: ['owner_id'],
};

// Fields carrying a unique index — a post-normalization collision here is fatal
// and must be resolved by hand, not by the migration.
const UNIQUE_FIELDS = new Set(['owners.loginId', 'tenants.loginId', 'employees.loginId']);

const ALLOWED_NON_CANONICAL = new Set(['superadmin', 'admin', 'system', 'n/a', '']);
const isExempt = (value) =>
  ALLOWED_NON_CANONICAL.has(String(value).toLowerCase()) || String(value).includes('@');

const canonical = (value) => String(value).trim().toUpperCase();

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;

  console.log(`Database : ${mongoose.connection.name}`);
  console.log(`Mode     : ${APPLY ? '*** APPLY — WILL WRITE ***' : 'dry run (no writes)'}\n`);

  let planned = 0;
  let written = 0;
  let skipped = 0;

  for (const [collName, fields] of Object.entries(TARGETS)) {
    const exists = await db.listCollections({ name: collName }).hasNext();
    if (!exists) continue;
    const coll = db.collection(collName);

    for (const field of fields) {
      const key = `${collName}.${field}`;
      const cursor = coll.find(
        { [field]: { $type: 'string', $ne: '' } },
        { projection: { [field]: 1 } }
      );

      const ops = [];
      const collisions = [];

      while (await cursor.hasNext()) {
        const doc = await cursor.next();
        const value = doc[field];
        if (isExempt(value)) continue;

        const target = canonical(value);
        if (target === value) continue; // already canonical

        if (UNIQUE_FIELDS.has(key)) {
          // Would this normalization land on a value another document already holds?
          const clash = await coll.findOne(
            { [field]: target, _id: { $ne: doc._id } },
            { projection: { _id: 1 } }
          );
          if (clash) {
            collisions.push({ _id: doc._id, from: value, to: target, clashesWith: clash._id });
            continue;
          }
        }

        ops.push({
          updateOne: { filter: { _id: doc._id }, update: { $set: { [field]: target } } },
        });
      }

      if (collisions.length > 0) {
        skipped += collisions.length;
        console.log(`⚠  ${key}: ${collisions.length} COLLISION(S) SKIPPED — resolve by hand:`);
        for (const c of collisions.slice(0, 20)) {
          console.log(`     _id=${c._id}  ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}  clashes with _id=${c.clashesWith}`);
        }
      }

      if (ops.length === 0) {
        if (collisions.length === 0) console.log(`   ${key}: already canonical`);
        continue;
      }

      planned += ops.length;
      console.log(`${APPLY ? '→' : ' '}  ${key}: ${ops.length} document(s) to normalize`);

      if (APPLY) {
        // Unordered so one failure does not abort the rest of the batch.
        const result = await coll.bulkWrite(ops, { ordered: false });
        written += result.modifiedCount;
        console.log(`     modified ${result.modifiedCount}`);
      }
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`Planned updates : ${planned}`);
  console.log(`Applied updates : ${APPLY ? written : 0}`);
  console.log(`Skipped (collision) : ${skipped}`);
  if (!APPLY && planned > 0) {
    console.log('\nDry run only. Re-run with --apply to write these changes.');
  }
  if (skipped > 0) {
    console.log('\nCollisions were skipped, not merged. Decide per case which record');
    console.log('is authoritative before re-running.');
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
