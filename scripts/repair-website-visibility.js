'use strict';
/**
 * repair-website-visibility.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time repair script for verified properties that never appeared on the
 * public website.
 *
 * Two root causes, both fixed in controllers/propertyController.js:
 *
 *   1. syncToApprovedProperty stamped ApprovedProperty.status = 'live', but the
 *      public endpoints (/api/approved-properties/public/approved and /all)
 *      filter on status === 'approved'. Every property published or edited from
 *      the Property Management panel was written straight into a hidden state.
 *
 *   2. Saving a property with owner: "" threw a CastError, so the whole update
 *      aborted before syncToApprovedProperty ever ran — leaving active + live
 *      properties with no ApprovedProperty row at all.
 *
 * This script repairs the rows already written by the buggy code:
 *   • flips ApprovedProperty rows stuck at status 'live' back to 'approved'
 *   • re-syncs live properties that have no ApprovedProperty row
 *
 * Usage:
 *   node scripts/repair-website-visibility.js --dry-run   (report only)
 *   node scripts/repair-website-visibility.js             (apply)
 *
 * Safe to re-run — already-repaired records are skipped automatically.
 * Rows explicitly taken offline (isLiveOnWebsite: false / status 'offline')
 * are never touched.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');

const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const { syncToApprovedProperty, isPropertyLive } = require('../controllers/propertyController');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(MONGO_URI);
  console.log(`Connected.${DRY_RUN ? '  [DRY RUN — nothing will be written]' : ''}\n`);

  // ── Step 1: rows stranded at status 'live' ────────────────────────────────
  const stranded = await ApprovedProperty.find({ status: 'live', isLiveOnWebsite: true })
    .select('visitId propertyInfo.name')
    .lean();

  console.log(`Step 1 — ApprovedProperty rows stuck at status 'live': ${stranded.length}`);
  stranded.forEach(r => console.log(`   • ${r.visitId}  ${r.propertyInfo?.name || '(untitled)'}`));

  if (stranded.length && !DRY_RUN) {
    const res = await ApprovedProperty.updateMany(
      { status: 'live', isLiveOnWebsite: true },
      { $set: { status: 'approved' } }
    );
    console.log(`   → ${res.modifiedCount} rows set to 'approved'.`);
  }

  // ── Step 2: live properties with no ApprovedProperty row ──────────────────
  const candidates = await Property.find({
    isLiveOnWebsite: { $ne: false },
    status: { $in: ['active', 'approved'] }
  });

  const missing = [];
  for (const prop of candidates) {
    if (!isPropertyLive(prop)) continue;
    const vId = prop.visitId || prop._id.toString();
    const exists = await ApprovedProperty.countDocuments({ visitId: vId });
    if (!exists) missing.push(prop);
  }

  console.log(`\nStep 2 — live properties with no ApprovedProperty row: ${missing.length}`);
  missing.forEach(p => console.log(`   • ${p._id}  ${p.title || '(untitled)'}`));

  if (missing.length && !DRY_RUN) {
    let synced = 0;
    for (const prop of missing) {
      await syncToApprovedProperty(prop);
      synced += 1;
    }
    console.log(`   → ${synced} properties synced to the website.`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  const visible = await ApprovedProperty.countDocuments({ status: 'approved', isLiveOnWebsite: true });
  console.log(`\nProperties now visible on the public website: ${visible}`);

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0)) // controller imports leave timers open; exit explicitly
  .catch(err => {
    console.error('Repair failed:', err);
    process.exit(1);
  });
