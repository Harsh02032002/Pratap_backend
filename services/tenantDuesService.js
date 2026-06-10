'use strict';
const RentInvoice = require('../models/RentInvoice');
const ElectricityMeter = require('../models/ElectricityMeter');
const Room = require('../models/Room');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const User = require('../models/user');
const { evaluateInvoice, generateMonthlyInvoices } = require('./invoiceService');

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Live outstanding for a single invoice (rent + penalty + electricity − paid). */
function calcInvoiceOutstanding(inv) {
  const rentPaid = inv.rentPaidAmount ?? inv.paidAmount ?? 0;
  const rentDue  = Math.max(0, (inv.rentAmount || 0) - rentPaid);
  const penalty  = inv.totalPenalty || 0;
  const elec     = inv.electricityBill || 0;
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
 */
async function enrichTenantsWithDues(tenants) {
  if (!tenants?.length) return tenants;

  const tenantIds = tenants.map(t => t._id);
  let invoices = await RentInvoice.find({
    tenantId: { $in: tenantIds },
    status: { $in: ['PENDING', 'PARTIAL'] },
  }).lean();

  await backfillMissingElectricity(tenants, invoices);

  invoices = await RentInvoice.find({
    tenantId: { $in: tenantIds },
    status: { $in: ['PENDING', 'PARTIAL'] },
  }).lean();

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
 * Ensure a rent invoice exists for tenant+billingMonth, then attach electricity bill.
 */
async function syncElectricityToInvoice(propertyId, roomNo, billingMonth, meterRecord) {
  const tenant = await findTenantByRoom(propertyId, roomNo);
  if (!tenant) return { synced: false, reason: 'no_tenant' };

  let invoice = await RentInvoice.findOne({
    tenantId: tenant._id,
    billingMonth,
    status: { $in: ['PENDING', 'PARTIAL'] },
  });

  if (!invoice) {
    const ownerUserId = await resolveOwnerUserId(tenant);
    if (!ownerUserId) return { synced: false, reason: 'no_owner' };

    await generateMonthlyInvoices(ownerUserId, billingMonth, [{
      tenantId:   tenant._id,
      propertyId: tenant.property,
      unitId:     tenant.room,
      rentAmount: tenant.agreedRent || 0,
    }]);

    invoice = await RentInvoice.findOne({
      tenantId: tenant._id,
      billingMonth,
      status: { $in: ['PENDING', 'PARTIAL'] },
    });
    if (!invoice) return { synced: false, reason: 'invoice_create_failed' };
  }

  const electricityFields = {
    electricityBill:          meterRecord.totalBill || 0,
    electricityUnitsConsumed: meterRecord.unitsConsumed || 0,
    electricityPrevReading:   meterRecord.previousReading || 0,
    electricityCurrReading:   meterRecord.currentReading || 0,
    electricityReadingAdded:  true,
  };

  Object.assign(invoice, electricityFields);

  const { updates } = await evaluateInvoice(invoice);
  await RentInvoice.findByIdAndUpdate(invoice._id, {
    $set: { ...updates, ...electricityFields },
  });

  return { synced: true, invoiceId: invoice._id, tenantId: tenant._id };
}

module.exports = {
  calcInvoiceOutstanding,
  enrichTenantsWithDues,
  findTenantByRoom,
  syncElectricityToInvoice,
};
