'use strict';
const RentInvoice = require('../models/RentInvoice');
const ElectricityMeter = require('../models/ElectricityMeter');
const Room = require('../models/Room');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const User = require('../models/user');
const { evaluateInvoice, generateMonthlyInvoices } = require('./invoiceService');
const { getOccupantsForRoomAndBillingMonth } = require('./roomAssignmentService');

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Live outstanding for a single invoice (rent + penalty + electricity − paid). */
function calcInvoiceOutstanding(inv) {
  const rentPaid = inv.rentPaidAmount ?? inv.paidAmount ?? 0;
  const rentDue = Math.max(0, (inv.rentAmount || 0) - rentPaid);
  const penalty = inv.totalPenalty || 0;
  const elec = inv.electricityBill || 0;
  const computed = Math.max(0, rentDue + penalty + elec - Math.max(0, (inv.paidAmount || 0) - rentPaid));
  // outstandingAmount is updated by evaluateInvoice and includes electricity even when
  // electricityBill field was not persisted (legacy sync bug).
  if (typeof inv.outstandingAmount === 'number') {
    return Math.max(computed, Math.max(0, inv.outstandingAmount));
  }
  return computed;
}

/**
 * Link saved meter readings to invoices that are missing electricityBill.
 */
async function backfillMissingElectricity(tenants, invoices) {
  const tenantById = new Map(tenants.map(t => [String(t._id), t]));
  const invoicedTenantMonths = new Set(invoices.map(inv => `${inv.tenantId}:${inv.billingMonth}`));

  // Fix invoices that exist but have no electricity amount saved
  for (const inv of invoices) {
    if ((inv.electricityBill || 0) > 0) continue;
    const tenant = tenantById.get(String(inv.tenantId));
    if (!tenant) continue;
    const propId = tenant.property?._id || tenant.property;
    if (!propId) continue;

    const meter = await findMeterForTenant(tenant, inv.billingMonth);
    if (meter) {
      await syncElectricityToInvoice(propId, meter.roomNo, inv.billingMonth, meter);
    }
  }

  // Create invoices for tenants who have a meter reading but no invoice yet
  for (const tenant of tenants) {
    const propId = tenant.property?._id || tenant.property;
    if (!propId) continue;

    const roomNos = new Set();
    if (tenant.roomNo) roomNos.add(String(tenant.roomNo).trim());
    if (tenant.room) {
      const roomDoc = await Room.findById(tenant.room).select('title').lean();
      if (roomDoc?.title) roomNos.add(String(roomDoc.title).trim());
    }
    const orClause = [...roomNos].map(rn => ({ roomNo: roomNoQuery(rn) }));
    if (tenant.room) orClause.push({ room: tenant.room });
    if (!orClause.length) continue;

    const meters = await ElectricityMeter.find({
      property: propId,
      totalBill: { $gt: 0 },
      $or: orClause,
    }).sort({ billingMonth: -1 }).limit(3).lean();

    for (const meter of meters) {
      const key = `${tenant._id}:${meter.billingMonth}`;
      if (invoicedTenantMonths.has(key)) continue;
      const result = await syncElectricityToInvoice(propId, meter.roomNo, meter.billingMonth, meter);
      if (result.synced) invoicedTenantMonths.add(key);
    }
  }
}

/**
 * Attach dueAmount / dues to tenant objects from pending rent invoices.
 *
 * Read-only by default. `backfillMissingElectricity` is a repair — it writes
 * electricity amounts onto invoices and creates invoices for tenants that have
 * a meter reading but no invoice yet — and it does so with a per-invoice and
 * per-tenant query loop. Running that inside a GET made a read request perform
 * unbounded writes, so it is now opt-in and driven by the scheduled job.
 *
 * @param {Array} tenants
 * @param {{ repair?: boolean }} [options] `repair: true` runs the electricity
 *        backfill first and re-reads invoices so the returned dues reflect it.
 *        Only the background job should pass this.
 */
async function enrichTenantsWithDues(tenants, options = {}) {
  if (!tenants?.length) return tenants;

  const tenantIds = tenants.map(t => t._id);
  let invoices = await RentInvoice.find({
    tenantId: { $in: tenantIds },
    status: { $in: ['PENDING', 'PARTIAL'] },
  }).lean();

  if (options.repair === true) {
    await backfillMissingElectricity(tenants, invoices);
    // Re-read: the backfill above may have added or changed invoices.
    invoices = await RentInvoice.find({
      tenantId: { $in: tenantIds },
      status: { $in: ['PENDING', 'PARTIAL'] },
    }).lean();
  }

  const duesMap = {};
  for (const inv of invoices) {
    const tid = String(inv.tenantId);
    duesMap[tid] = (duesMap[tid] || 0) + calcInvoiceOutstanding(inv);
  }

  return tenants.map(t => {
    const due = Math.round(duesMap[String(t._id)] || 0);
    return { ...t, dueAmount: due, dues: due, balance: due };
  });
}

async function resolveOwnerUserId(tenant) {
  const tryLoginId = async (loginId) => {
    if (!loginId) return null;
    const normalized = String(loginId).toUpperCase();
    const user = await User.findOne({ loginId: normalized }).select('_id role').lean();
    return user?._id || null;
  };

  if (tenant.ownerLoginId) {
    const id = await tryLoginId(tenant.ownerLoginId);
    if (id) return id;
  }
  if (tenant.property) {
    const prop = await Property.findById(tenant.property).select('ownerLoginId').lean();
    const id = await tryLoginId(prop?.ownerLoginId);
    if (id) return id;
  }
  return null;
}

/**
 * Find active tenant in a room (case-insensitive roomNo match).
 */
function roomNoQuery(roomNo) {
  return { $regex: new RegExp(`^${escapeRegex(roomNo)}$`, 'i') };
}

async function findMeterForTenant(tenant, billingMonth) {
  const propId = tenant.property?._id || tenant.property;
  if (!propId) return null;

  const roomNos = new Set();
  if (tenant.roomNo) roomNos.add(String(tenant.roomNo).trim());
  if (tenant.room) {
    const roomDoc = await Room.findById(tenant.room).select('title').lean();
    if (roomDoc?.title) roomNos.add(String(roomDoc.title).trim());
  }

  const orClause = [];
  for (const rn of roomNos) {
    orClause.push({ roomNo: roomNoQuery(rn) });
  }
  if (tenant.room) orClause.push({ room: tenant.room });
  if (!orClause.length) return null;

  return ElectricityMeter.findOne({
    property: propId,
    billingMonth,
    totalBill: { $gt: 0 },
    $or: orClause,
  }).lean();
}

async function findTenantByRoom(propertyId, roomNo) {
  if (!propertyId || !roomNo) return null;

  const baseSelect = '_id property room roomNo agreedRent ownerLoginId moveInDate createdAt';
  const notDeleted = { isDeleted: { $ne: true } };

  // Match via Room document (room.title may differ from tenant.roomNo)
  const room = await Room.findOne({
    property: propertyId,
    title: { $regex: new RegExp(`^${escapeRegex(roomNo)}$`, 'i') },
  }).select('_id title').lean();

  if (room) {
    const byRoomRef = await Tenant.findOne({
      property: propertyId,
      room: room._id,
      ...notDeleted,
    }).select(baseSelect).sort({ createdAt: -1 }).lean();
    if (byRoomRef) return byRoomRef;
  }

  return Tenant.findOne({
    property: propertyId,
    roomNo: { $regex: new RegExp(`^${escapeRegex(roomNo)}$`, 'i') },
    ...notDeleted,
  }).select(baseSelect).sort({ createdAt: -1 }).lean();
}

/**
 * Find the tenant(s) who occupied a room during a given billing month, for
 * electricity attribution.
 *
 * Historical usage must attribute to whoever was actually assigned during
 * that billing period — not whoever happens to occupy the room right now.
 * A meter reading entered after a tenant has already transferred out (or
 * been replaced) must not bill the new occupant for the old one's usage,
 * and must not go unbilled just because the room is empty today. So this
 * checks RoomAssignmentHistory FIRST; only when no history row covers that
 * room+month (the room predates this feature, or has never had a transfer)
 * does it fall back to today's live-occupancy lookup, which is exactly the
 * previous behavior.
 */
async function findAllTenantsInRoom(propertyId, roomNo, billingMonth) {
  if (!propertyId || !roomNo) return [];
  const baseSelect = '_id property room roomNo agreedRent ownerLoginId moveInDate createdAt';

  // Resolve Room document
  const room = await Room.findOne({
    property: propertyId,
    title: { $regex: new RegExp(`^${escapeRegex(roomNo)}$`, 'i') },
  }).select('_id title').lean();

  if (room && billingMonth) {
    const historicalOccupantIds = await getOccupantsForRoomAndBillingMonth(room._id, billingMonth);
    if (historicalOccupantIds.length) {
      return Tenant.find({
        _id: { $in: historicalOccupantIds },
        isDeleted: { $ne: true },
      }).select(baseSelect).lean();
    }
  }

  if (room) {
    // Only tenants actively linked to this room ObjectId AND not deleted
    const byRoomRef = await Tenant.find({
      property: propertyId,
      room: room._id,                    // must explicitly point to this room
      isDeleted: { $ne: true },          // not soft-deleted
    }).select(baseSelect).lean();

    if (byRoomRef.length) return byRoomRef;
  }

  // Fallback: roomNo string match — also require room field to be set
  // (deleted tenants have room=undefined/null cleared by delete handler)
  return Tenant.find({
    property: propertyId,
    roomNo: { $regex: new RegExp(`^${escapeRegex(roomNo)}$`, 'i') },
    room: { $exists: true, $ne: null },  // must still have a room link
    isDeleted: { $ne: true },
  }).select(baseSelect).lean();
}

/**
 * Whether a tenant occupied the room before the given billing month began.
 * A tenant who moved in during (or after) `billingMonth` is not billed for
 * it — electricity billing for them starts the following month.
 */
function isEligibleForBillingMonth(tenant, billingMonth) {
  const moveInDateStr = tenant.moveInDate || tenant.createdAt;
  if (!moveInDateStr) return true; // no date on record — don't block billing
  const moveInMonth = new Date(moveInDateStr).toISOString().slice(0, 7);
  return moveInMonth < billingMonth;
}

/**
 * Sync electricity bill to eligible active tenants in the room, split equally.
 *
 * Business Rule:
 *   - 1 eligible tenant in room  → full bill to that 1 tenant
 *   - 2 eligible tenants         → bill ÷ 2 each
 *   - 3 eligible tenants         → bill ÷ 3 each
 *   (based on CURRENT active occupancy, not room capacity)
 *
 * A tenant who moved into the room during `billingMonth` is excluded from
 * both the split and the count for that month — see isEligibleForBillingMonth.
 * They become eligible starting the month after they moved in.
 */
async function syncElectricityToInvoice(propertyId, roomNo, billingMonth, meterRecord) {
  const allTenants = await findAllTenantsInRoom(propertyId, roomNo, billingMonth);
  if (!allTenants.length) return { synced: false, reason: 'no_tenant' };

  const eligibleTenants = allTenants.filter(t => isEligibleForBillingMonth(t, billingMonth));
  if (!eligibleTenants.length) return { synced: false, reason: 'no_eligible_tenant' };

  const totalBill = meterRecord.totalBill || 0;
  const occupantCount = eligibleTenants.length;
  const perTenantShare = Math.round(totalBill / occupantCount);

  const results = [];
  for (const tenant of eligibleTenants) {
    let invoice = await RentInvoice.findOne({
      tenantId: tenant._id,
      billingMonth,
    });

    if (!invoice) {
      const ownerUserId = await resolveOwnerUserId(tenant);
      if (!ownerUserId) {
        results.push({ tenantId: tenant._id, synced: false, reason: 'no_owner' });
        continue;
      }

      await generateMonthlyInvoices(ownerUserId, billingMonth, [{
        tenantId: tenant._id,
        propertyId: tenant.property,
        unitId: tenant.room,
        rentAmount: tenant.agreedRent || 0,
      }]);

      invoice = await RentInvoice.findOne({
        tenantId: tenant._id,
        billingMonth,
      });

      if (!invoice) {
        results.push({ tenantId: tenant._id, synced: false, reason: 'invoice_create_failed' });
        continue;
      }
    }

    const electricityFields = {
      electricityBill: perTenantShare,
      electricityUnitsConsumed: meterRecord.unitsConsumed || 0,
      electricityPrevReading: meterRecord.previousReading || 0,
      electricityCurrReading: meterRecord.currentReading || 0,
      electricityReadingAdded: true,
      electricitySplitCount: occupantCount,
      electricityTotalBill: totalBill,
    };

    Object.assign(invoice, electricityFields);
    const { updates } = await evaluateInvoice(invoice);

    // evaluateInvoice() recomputes outstandingAmount but — by design, see its
    // other callers — never touches `status`; every other caller only invokes
    // it on invoices that aren't PAID/WAIVED/CANCELLED yet, so there's nothing
    // to reconcile. This is the one caller that can add a charge to an invoice
    // that was already marked PAID, so it's the one place that must re-derive
    // status from the fresh outstandingAmount — otherwise a tenant who already
    // settled rent+penalty keeps showing PAID after electricity adds a real due.
    const currentStatus = String(invoice.status || '').toUpperCase();
    const statusUpdate = ['WAIVED', 'CANCELLED'].includes(currentStatus)
      ? {}
      : {
          status: updates.outstandingAmount > 0
            ? ((invoice.paidAmount || 0) > 0 ? 'PARTIAL' : 'PENDING')
            : 'PAID',
        };

    await RentInvoice.findByIdAndUpdate(invoice._id, {
      $set: { ...updates, ...electricityFields, ...statusUpdate },
    });

    results.push({ tenantId: tenant._id, invoiceId: invoice._id, synced: true, share: perTenantShare });
  }

  const syncedCount = results.filter(r => r.synced).length;
  return {
    synced: syncedCount > 0,
    splitAmong: occupantCount,
    perTenantShare,
    totalBill,
    results,
  };
}

module.exports = {
  calcInvoiceOutstanding,
  enrichTenantsWithDues,
  findTenantByRoom,
  isEligibleForBillingMonth,
  syncElectricityToInvoice,
};
