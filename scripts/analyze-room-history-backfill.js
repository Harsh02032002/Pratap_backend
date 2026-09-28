'use strict';
/**
 * Analyzes whether RoomAssignmentHistory can be safely reconstructed for
 * tenants who existed before that model was introduced.
 *
 * WHY THIS EXISTS
 * ────────────────
 * RoomAssignmentHistory only starts existing for a tenant from their first
 * onboarding/transfer THROUGH THE NEW CODE. A tenant created before this
 * deploy has none — until they transfer again, historical resolution for
 * them falls back to live tenant/room state (documented, not a bug, but not
 * an improvement over pre-fix behavior either).
 *
 * The only OTHER place a per-month room association was ever recorded is
 * RentInvoice.unitId — set at invoice-generation time to whatever room the
 * tenant was in THEN, but never required, and never given a readable
 * `roomNo` until this deploy. Grouping a tenant's invoices by unitId can
 * reconstruct a plausible assignment history WITHOUT inventing anything —
 * every value used already existed, we're just deriving structure from it.
 *
 * WHAT THIS SCRIPT DOES
 * ──────────────────────
 * Read-only by default (and always, in the version of this script actually
 * shipped — see "APPLY MODE" below). For every tenant with no open
 * RoomAssignmentHistory row, it looks at their RentInvoice history and
 * classifies them as:
 *
 *   DETERMINISTIC  — every invoice has a unitId that resolves to a Room that
 *                    still exists, and grouping by unitId+consecutive months
 *                    produces a clean, non-overlapping sequence. Safe to
 *                    reconstruct effectiveFrom/effectiveTo purely from
 *                    billingMonth boundaries.
 *   AMBIGUOUS      — has invoices, but at least one is missing unitId, or
 *                    unitId points at a Room that's been deleted, or there
 *                    are gaps in the billingMonth sequence that make the
 *                    room-during-the-gap unknowable. NEVER guess for these —
 *                    they are reported, not backfilled.
 *   NO_HISTORY     — no invoices at all (e.g. never billed, or fully on the
 *                    legacy Rent-only flow). Nothing to reconstruct from.
 *
 * Room NUMBER (roomNo string) for a DETERMINISTIC invoice missing it can
 * also be safely backfilled the same way — it's read from the Room the
 * invoice's own unitId already points to, not invented.
 *
 * USAGE
 *   node scripts/analyze-room-history-backfill.js --dry-run
 *   node scripts/analyze-room-history-backfill.js --dry-run --sample 5
 *
 * There is deliberately no write path in this script. Per the review that
 * commissioned it: a backfill write must be a separate, explicitly-reviewed
 * change after a human has read this report — never something an agent
 * runs against production data on its own judgment. If/when that reviewed
 * write script is built, it should reuse `classifyTenant` from this file
 * rather than re-deriving the logic.
 */

const mongoose = require('mongoose');

async function classifyTenant(tenantId, RentInvoice, Room) {
  const invoices = await RentInvoice.find({ tenantId })
    .select('billingMonth unitId roomNo rentAmount')
    .sort({ billingMonth: 1 })
    .lean();

  if (!invoices.length) {
    return { status: 'NO_HISTORY', invoiceCount: 0 };
  }

  const roomCache = new Map();
  const resolveRoom = async (unitId) => {
    if (!unitId) return null;
    const key = String(unitId);
    if (!roomCache.has(key)) {
      roomCache.set(key, await Room.findById(unitId).select('title').lean());
    }
    return roomCache.get(key);
  };

  const segments = [];
  for (const inv of invoices) {
    if (!inv.unitId) {
      return { status: 'AMBIGUOUS', reason: 'missing_unitId', invoiceCount: invoices.length, billingMonth: inv.billingMonth };
    }
    const room = await resolveRoom(inv.unitId);
    if (!room) {
      return { status: 'AMBIGUOUS', reason: 'unitId_room_deleted', invoiceCount: invoices.length, billingMonth: inv.billingMonth, unitId: inv.unitId };
    }
    const last = segments[segments.length - 1];
    if (last && String(last.roomId) === String(inv.unitId)) {
      last.toMonth = inv.billingMonth;
      last.invoiceCount += 1;
    } else {
      segments.push({ roomId: inv.unitId, roomNo: room.title, fromMonth: inv.billingMonth, toMonth: inv.billingMonth, invoiceCount: 1, agreedRent: inv.rentAmount });
    }
  }

  // Detect gaps between consecutive billing months (e.g. invoice generation
  // was skipped for a month) — a gap means we don't actually know what room
  // applied during it, so this tenant is ambiguous, not deterministic.
  const months = invoices.map(i => i.billingMonth);
  for (let i = 1; i < months.length; i++) {
    const [py, pm] = months[i - 1].split('-').map(Number);
    const [cy, cm] = months[i].split('-').map(Number);
    const expectedNextMonth = pm === 12 ? `${py + 1}-01` : `${py}-${String(pm + 1).padStart(2, '0')}`;
    if (months[i] !== expectedNextMonth) {
      return { status: 'AMBIGUOUS', reason: 'billing_month_gap', invoiceCount: invoices.length, gapAfter: months[i - 1], gapBefore: months[i] };
    }
  }

  return { status: 'DETERMINISTIC', invoiceCount: invoices.length, segments };
}

module.exports = { classifyTenant };

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--dry-run')) {
    console.log('This script is read-only/report-only. Pass --dry-run explicitly to run it (no other mode exists in this version — see the file header comment for why).');
    process.exit(1);
  }
  const sampleArgIdx = args.indexOf('--sample');
  const sampleSize = sampleArgIdx !== -1 ? parseInt(args[sampleArgIdx + 1], 10) || 5 : 5;

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is not set. This script intentionally does not default to a hardcoded connection string.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  const Tenant = require('../models/Tenant');
  const RentInvoice = require('../models/RentInvoice');
  const Room = require('../models/Room');
  const RoomAssignmentHistory = require('../models/RoomAssignmentHistory');

  const tenants = await Tenant.find({ isDeleted: { $ne: true } }).select('_id name loginId').lean();

  const counts = { DETERMINISTIC: 0, AMBIGUOUS: 0, NO_HISTORY: 0, HAS_HISTORY_ALREADY: 0 };
  const samples = { DETERMINISTIC: [], AMBIGUOUS: [] };

  for (const tenant of tenants) {
    const alreadyHasHistory = await RoomAssignmentHistory.exists({ tenantId: tenant._id });
    if (alreadyHasHistory) { counts.HAS_HISTORY_ALREADY++; continue; }

    const result = await classifyTenant(tenant._id, RentInvoice, Room);
    counts[result.status]++;
    if (samples[result.status] && samples[result.status].length < sampleSize) {
      samples[result.status].push({ tenantId: tenant._id, name: tenant.name, loginId: tenant.loginId, ...result });
    }
  }

  console.log('\n=== Room Assignment History — Backfill Feasibility Report (READ-ONLY) ===\n');
  console.log(`Total tenants examined:        ${tenants.length}`);
  console.log(`Already have history:          ${counts.HAS_HISTORY_ALREADY}  (nothing to do)`);
  console.log(`Deterministic (safe to fill):  ${counts.DETERMINISTIC}`);
  console.log(`Ambiguous (do NOT fill):       ${counts.AMBIGUOUS}`);
  console.log(`No historical data at all:     ${counts.NO_HISTORY}`);
  console.log(`\nSafe to backfill: ${counts.DETERMINISTIC}\n`);

  console.log('--- Sample DETERMINISTIC transformations (would create these rows) ---');
  for (const s of samples.DETERMINISTIC) {
    console.log(`Tenant ${s.loginId} (${s.name}):`);
    for (const seg of s.segments) {
      console.log(`  Room ${seg.roomNo}  [${seg.fromMonth} .. ${seg.toMonth}]  rent=${seg.agreedRent}  (${seg.invoiceCount} invoice(s))`);
    }
  }

  console.log('\n--- Sample AMBIGUOUS tenants (would be left as "Room information unavailable") ---');
  for (const s of samples.AMBIGUOUS) {
    console.log(`Tenant ${s.loginId} (${s.name}): reason=${s.reason}${s.billingMonth ? `, at ${s.billingMonth}` : ''}`);
  }

  console.log('\nNo data was written. There is no --apply flag in this script — see the file header for why.');
  await mongoose.disconnect();
}

// Only run when executed directly (`node scripts/analyze-room-history-backfill.js`) —
// requiring this file for `classifyTenant` (e.g. from a test) must not
// trigger a real DB connection attempt or process.exit.
if (require.main === module) {
  main().catch((err) => {
    console.error('Analysis failed:', err);
    process.exit(1);
  });
}
