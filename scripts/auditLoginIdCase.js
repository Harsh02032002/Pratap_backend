'use strict';

/**
 * auditLoginIdCase.js — READ-ONLY.
 *
 * Reports whether any identifier field holds a value that is not already in its
 * canonical (trimmed, uppercase) form, and flags the case where normalizing
 * would create a duplicate on a unique index.
 *
 * Run this BEFORE deploying the exact-match query changes. If it reports zero
 * non-canonical values, the migration is unnecessary and the switch from
 * case-insensitive regex to equality is a pure win with no behaviour change.
 *
 *   node scripts/auditLoginIdCase.js
 *
 * Writes nothing. Safe to run against production.
 */

require('dotenv').config();
const mongoose = require('mongoose');

// collection → [fields to audit]. Collection names are the real Mongo names
// (lowercase plural) so this runs through the driver and does not depend on
// the Mongoose schema setters we are auditing for.
const TARGETS = {
  owners:            ['loginId'],
  tenants:           ['loginId', 'ownerLoginId'],
  properties:        ['ownerLoginId'],
  employees:         ['loginId', 'parentLoginId'],
  enquiries:         ['ownerLoginId'],
  complaints:        ['ownerLoginId', 'tenantLoginId'],
  maintenancetasks:  ['ownerLoginId'],
  staffattendances:  ['ownerLoginId'],
  staffsalaries:     ['ownerLoginId'],
  staffshifts:       ['ownerLoginId'],
  paymenttransactions: ['owner_id'],
  notifications:     ['toLoginId'],
  rentpayments:      [],
};

// Values that are legitimately not uppercase identifiers and must be ignored.
// `toLoginId` doubles as a role sentinel; `loginId` on the users collection can
// hold an email address for website accounts.
const ALLOWED_NON_CANONICAL = new Set(['superadmin', 'admin', 'system', 'n/a', '']);

const isExempt = (value) =>
  ALLOWED_NON_CANONICAL.has(String(value).toLowerCase()) || String(value).includes('@');

async function auditField(db, collName, field) {
  const coll = db.collection(collName);

  // $toUpper/$trim in an aggregation compares each stored value against its own
  // canonical form without loading the collection into the app.
  const offenders = await coll.aggregate([
    { $match: { [field]: { $type: 'string', $ne: '' } } },
    {
      $project: {
        value: `$${field}`,
        canonical: { $toUpper: { $trim: { input: `$${field}` } } },
      },
    },
    { $match: { $expr: { $ne: ['$value', '$canonical'] } } },
    { $group: { _id: { value: '$value', canonical: '$canonical' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 200 },
  ]).toArray();

  const real = offenders.filter((o) => !isExempt(o._id.value));
  const exempt = offenders.filter((o) => isExempt(o._id.value));
  return { real, exempt };
}

/**
 * After normalization two distinct rows could collapse onto the same value.
 * That only breaks something where the field carries a unique index, but it is
 * always worth reporting — silently merging identities is never acceptable.
 */
async function findCollisions(db, collName, field) {
  const coll = db.collection(collName);
  return coll.aggregate([
    { $match: { [field]: { $type: 'string', $ne: '' } } },
    { $group: { _id: { $toUpper: { $trim: { input: `$${field}` } } }, variants: { $addToSet: `$${field}` }, ids: { $push: '$_id' } } },
    { $match: { $expr: { $gt: [{ $size: '$variants' }, 1] } } },
    { $limit: 100 },
  ]).toArray();
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.name}\n`);

  let totalReal = 0;
  let totalCollisions = 0;

  for (const [collName, fields] of Object.entries(TARGETS)) {
    for (const field of fields) {
      let exists;
      try {
        exists = await db.listCollections({ name: collName }).hasNext();
      } catch (_) {
        exists = false;
      }
      if (!exists) {
        console.log(`SKIP  ${collName}.${field} — collection not present`);
        continue;
      }

      const total = await db.collection(collName).countDocuments({ [field]: { $type: 'string', $ne: '' } });
      const { real, exempt } = await auditField(db, collName, field);
      const collisions = await findCollisions(db, collName, field);

      totalReal += real.length;
      totalCollisions += collisions.length;

      const status = real.length === 0 ? 'CLEAN' : 'DIRTY';
      console.log(`${status.padEnd(5)} ${collName}.${field}  (${total} docs with a value)`);

      if (real.length > 0) {
        console.log(`      ${real.length} distinct non-canonical value(s):`);
        for (const o of real.slice(0, 15)) {
          console.log(`        ${JSON.stringify(o._id.value)} → ${JSON.stringify(o._id.canonical)}  ×${o.count}`);
        }
        if (real.length > 15) console.log(`        … and ${real.length - 15} more`);
      }
      if (exempt.length > 0) {
        console.log(`      ${exempt.length} exempt value(s) ignored (role sentinel / email): ` +
          exempt.slice(0, 5).map((o) => JSON.stringify(o._id.value)).join(', '));
      }
      if (collisions.length > 0) {
        console.log(`      ⚠ ${collisions.length} COLLISION GROUP(S) — normalizing would merge these:`);
        for (const c of collisions.slice(0, 10)) {
          console.log(`        ${JSON.stringify(c._id)} ← ${JSON.stringify(c.variants)} (${c.ids.length} docs)`);
        }
      }
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`Non-canonical fields found : ${totalReal}`);
  console.log(`Collision groups found     : ${totalCollisions}`);
  if (totalReal === 0) {
    console.log('\nAll identifiers are already canonical. The exact-match query');
    console.log('changes are behaviour-preserving; no migration is needed.');
  } else if (totalCollisions > 0) {
    console.log('\nDo NOT run the migration yet. Resolve the collision groups above');
    console.log('by hand first — normalizing them would merge separate records.');
  } else {
    console.log('\nRun `node scripts/normalizeLoginIds.js` (dry-run by default) next.');
  }

  await mongoose.disconnect();
  process.exit(totalCollisions > 0 ? 2 : 0);
})().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
