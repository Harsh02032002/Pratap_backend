'use strict';
// Resolves which room/rent applied to a tenant (or which tenants occupied a
// room) for a given billing month, from RoomAssignmentHistory rather than
// live tenant/room state — so billing for a past month stays correct no
// matter how many times the tenant has since transferred.
//
// Tenants who existed before this model was introduced have no history rows
// yet. Every resolver here falls back to today's live-lookup behavior in
// that case (see each function) rather than inventing historical data — a
// row only starts existing from the first onboarding/transfer that runs
// through this service.
const RoomAssignmentHistory = require('../models/RoomAssignmentHistory');
const { istMonthStartUTC, nextBillingMonth } = require('../utils/istDate');

/**
 * The assignment (room + rent) applicable to `tenantId` during `billingMonth`
 * ("YYYY-MM"), or null if no history row covers that month (caller should
 * fall back to the tenant's current room/rent).
 */
async function getAssignmentForBillingMonth(tenantId, billingMonth) {
  const monthStart = istMonthStartUTC(billingMonth);
  return RoomAssignmentHistory.findOne({
    tenantId,
    effectiveFrom: { $lte: monthStart },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: monthStart } }],
  }).lean();
}

/**
 * Every tenantId whose assignment history says they occupied `roomId` during
 * `billingMonth`. Empty array means "no history rows for this room/month" —
 * caller should fall back to live current-occupancy lookup, NOT treat it as
 * "nobody occupied this room".
 */
async function getOccupantsForRoomAndBillingMonth(roomId, billingMonth) {
  const monthStart = istMonthStartUTC(billingMonth);
  const rows = await RoomAssignmentHistory.find({
    roomId,
    effectiveFrom: { $lte: monthStart },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: monthStart } }],
  }).select('tenantId').lean();
  return rows.map(r => r.tenantId);
}

/**
 * Batched form of getAssignmentForBillingMonth for bulk invoice generation —
 * one query for many tenants instead of one query per tenant. Returns a Map
 * keyed by tenantId string; a tenant with no covering row is simply absent
 * from the map (caller falls back to live tenant data for that one).
 */
async function getAssignmentsForBillingMonthBatch(tenantIds, billingMonth) {
  const monthStart = istMonthStartUTC(billingMonth);
  const rows = await RoomAssignmentHistory.find({
    tenantId: { $in: tenantIds },
    effectiveFrom: { $lte: monthStart },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: monthStart } }],
  }).lean();
  return new Map(rows.map(r => [String(r.tenantId), r]));
}

/** The tenant's currently-open assignment row (effectiveTo: null), if any. */
async function getOpenAssignment(tenantId, session) {
  return RoomAssignmentHistory.findOne({ tenantId, effectiveTo: null }).session(session || null);
}

/**
 * Creates the tenant's first assignment row at onboarding. Safe to call even
 * if one already exists (e.g. a retried request) — it's a no-op then.
 */
async function recordOnboarding({ tenantId, propertyId, roomId, roomNo, bedNo, agreedRent, effectiveFrom, performedBy }, session) {
  const existing = await getOpenAssignment(tenantId, session);
  if (existing) return existing;
  const [row] = await RoomAssignmentHistory.create([{
    tenantId, propertyId, roomId, roomNo, bedNo, agreedRent,
    effectiveFrom: effectiveFrom || new Date(),
    effectiveTo: null,
    reason: 'onboarding',
    performedBy,
  }], { session });
  return row;
}

/**
 * Closes the tenant's current assignment and opens the new one, both
 * boundaried at the start of the month following `transferDate` — the month
 * of the transfer itself keeps billing on the OLD assignment; the new one
 * takes effect the month after. No proration.
 */
async function recordTransfer({ tenantId, propertyId, roomId, roomNo, bedNo, agreedRent, transferDate, performedBy }, session) {
  const effectiveMonth = nextBillingMonth(transferDate);
  const boundary = istMonthStartUTC(effectiveMonth);

  const open = await getOpenAssignment(tenantId, session);
  if (open) {
    open.effectiveTo = boundary;
    await open.save({ session });
  }

  const [row] = await RoomAssignmentHistory.create([{
    tenantId, propertyId, roomId, roomNo, bedNo, agreedRent,
    effectiveFrom: boundary,
    effectiveTo: null,
    reason: 'transfer',
    performedBy,
  }], { session });
  return row;
}

module.exports = {
  getAssignmentForBillingMonth,
  getAssignmentsForBillingMonthBatch,
  getOccupantsForRoomAndBillingMonth,
  getOpenAssignment,
  recordOnboarding,
  recordTransfer,
};
