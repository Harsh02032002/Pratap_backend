'use strict';
const mongoose = require('mongoose');
const RentInvoice  = require('../models/RentInvoice');
const RentPayment  = require('../models/RentPayment');
const PenaltyConfig = require('../models/PenaltyConfig');
const RentAuditLog  = require('../models/RentAuditLog');
const Tenant           = require('../models/Tenant');
const ElectricityMeter = require('../models/ElectricityMeter');
const globalConfig     = require('../config/rentCollectionConfig');
const { calculatePenalties, determinePhase, calcDaysSinceDue } = require('../engine/penaltyEngine');

// ─── Config priority: unit → property → owner-default → .env global ──────────

async function getEffectiveConfig(ownerId, propertyId, unitId) {
  let cfg = null;

  if (unitId) {
    cfg = await PenaltyConfig.findOne({ ownerId, propertyId, unitId, isActive: true }).lean();
  }
  if (!cfg && propertyId) {
    cfg = await PenaltyConfig.findOne({ ownerId, propertyId, unitId: null, isActive: true }).lean();
  }
  if (!cfg) {
    cfg = await PenaltyConfig.findOne({ ownerId, propertyId: null, unitId: null, isDefault: true, isActive: true }).lean();
  }

  if (cfg) return mergeWithGlobal(cfg);
  return buildGlobalConfig();
}

function mergeWithGlobal(cfg) {
  return {
    mode:                        globalConfig.mode,
    gracePeriodDays:             cfg.gracePeriodDays             ?? globalConfig.gracePeriodDays,
    minorPenaltyDay:             cfg.minorPenaltyDay             ?? globalConfig.minorPenaltyDay,
    majorPenaltyDay:             cfg.majorPenaltyDay             ?? globalConfig.majorPenaltyDay,
    phase1ReminderFrequencyDays: cfg.phase1ReminderFrequencyDays ?? globalConfig.phase1ReminderFrequencyDays,
    minorPenalty: cfg.minorPenalty || { enabled: false },
    majorPenalty: cfg.majorPenalty || { enabled: false },
    notifications: cfg.notifications || { email: true, dashboard: true, whatsapp: false },
  };
}

function buildGlobalConfig() {
  return {
    mode:                        globalConfig.mode,
    gracePeriodDays:             globalConfig.gracePeriodDays,
    minorPenaltyDay:             globalConfig.minorPenaltyDay,
    majorPenaltyDay:             globalConfig.majorPenaltyDay,
    phase1ReminderFrequencyDays: globalConfig.phase1ReminderFrequencyDays,
    minorPenalty: { enabled: false, type: 'fixed', value: 0 },
    majorPenalty: { enabled: false, type: 'fixed', value: 0 },
    notifications: { email: true, dashboard: true, whatsapp: false },
  };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function attachPendingElectricity(invoice, tenantId) {
  const tenant = await Tenant.findById(tenantId).select('property roomNo room').lean();
  if (!tenant?.property) return;

  const orClause = [];
  if (tenant.roomNo) orClause.push({ roomNo: { $regex: new RegExp(`^${escapeRegex(tenant.roomNo)}$`, 'i') } });
  if (tenant.room) orClause.push({ room: tenant.room });
  if (!orClause.length) return;

  const meter = await ElectricityMeter.findOne({
    property: tenant.property,
    billingMonth: invoice.billingMonth,
    totalBill: { $gt: 0 },
    $or: orClause,
  }).lean();

  if (!meter?.totalBill) return;

  invoice.electricityBill          = meter.totalBill;
  invoice.electricityUnitsConsumed = meter.unitsConsumed || 0;
  invoice.electricityPrevReading     = meter.previousReading || 0;
  invoice.electricityCurrReading     = meter.currentReading || 0;
  invoice.electricityReadingAdded    = true;

  const { updates } = await evaluateInvoice(invoice);
  Object.assign(invoice, updates);
}

// ─── Invoice generation (idempotent, race-safe via unique index) ──────────────

async function generateMonthlyInvoices(ownerId, billingMonth, tenants) {
  const results = { created: 0, skipped: 0, errors: [] };

  for (const tenant of tenants) {
    try {
      const existing = await RentInvoice.findOne({
        ownerId,
        tenantId: tenant.tenantId,
        billingMonth,
      });
      if (existing) { results.skipped++; continue; }

      const config    = await getEffectiveConfig(ownerId, tenant.propertyId, tenant.unitId);
      const dueYear   = parseInt(billingMonth.split('-')[0], 10);
      const dueMonth  = parseInt(billingMonth.split('-')[1], 10) - 1; // 0-indexed
      const dueDay    = config.rentDueDay || 1;
      const dueDate   = new Date(dueYear, dueMonth, dueDay);

      const invoiceNumber = `INV-${billingMonth}-${String(tenant.tenantId).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

      const tenantDoc = await Tenant.findById(tenant.tenantId).select('name email phone').lean();

      const invoice = new RentInvoice({
        invoiceNumber,
        ownerId,
        propertyId:  tenant.propertyId,
        unitId:      tenant.unitId,
        tenantId:    tenant.tenantId,
        tenantName:  tenantDoc?.name  || '',
        tenantEmail: tenantDoc?.email || '',
        tenantPhone: tenantDoc?.phone || '',
        billingMonth,
        rentAmount:  tenant.rentAmount,
        dueDate,
        totalDue:    tenant.rentAmount,
        outstandingAmount: tenant.rentAmount,
        penaltyConfigSnapshot: config,
      });

      await attachPendingElectricity(invoice, tenant.tenantId);
      await invoice.save();
      await RentAuditLog.create({
        action:     'INVOICE_CREATED',
        invoiceId:  invoice._id,
        tenantId:   tenant.tenantId,
        ownerId,
        propertyId: tenant.propertyId,
        meta:       { billingMonth, rentAmount: tenant.rentAmount },
      });

      results.created++;
    } catch (err) {
      // Unique index violation: concurrent request already created this invoice
      if (err.code === 11000) {
        results.skipped++;
        continue;
      }
      results.errors.push({ tenantId: tenant.tenantId, error: err.message });
    }
  }
  return results;
}

// ─── THE GOLDEN RULE: always recalculate from dueDate ────────────────────────

async function evaluateInvoice(invoice, asOfDate = null) {
  // Always use the live config so invoices created before penalty settings were
  // configured still get correct penalties after the owner sets them up.
  const config   = await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
  const penalties = calculatePenalties(invoice, config, asOfDate);
  const previousPhase = invoice.currentPhase;

  const electricityBill = invoice.electricityBill || 0;

  const updates = {
    daysSinceDue:       penalties.daysSinceDue,
    currentPhase:       penalties.phase,
    minorPenaltyAmount: penalties.minorPenalty,
    majorPenaltyAmount: penalties.majorPenalty,
    totalPenalty:       penalties.totalPenalty,
    outstandingAmount:  penalties.outstandingAmount + electricityBill,
    totalDue:           penalties.totalDue + electricityBill,
    lastEvaluatedAt:    new Date(),
  };

  const newPenalties = [];

  // Phase 2 — minor penalty: add to history only once per invoice
  if (penalties.phase >= 2 && penalties.minorPenalty > 0) {
    const alreadyHasMinor = (invoice.penaltyHistory || []).some(h => h.type === 'minor');
    if (!alreadyHasMinor) {
      newPenalties.push({ phase: 2, type: 'minor', amount: penalties.minorPenalty, daysSinceDue: penalties.daysSinceDue });
    }
  }

  // Phase 3 — major penalty: escalating, record when amount changes
  if (penalties.phase >= 3 && penalties.majorPenalty > 0) {
    const lastMajor = (invoice.penaltyHistory || []).filter(h => h.type === 'major').slice(-1)[0];
    if (!lastMajor || lastMajor.amount !== penalties.majorPenalty) {
      newPenalties.push({ phase: 3, type: 'major', amount: penalties.majorPenalty, daysSinceDue: penalties.daysSinceDue });
    }
  }

  const phaseHistoryAddition = [];
  if (previousPhase !== penalties.phase) {
    phaseHistoryAddition.push({ phase: penalties.phase, daysSinceDue: penalties.daysSinceDue });
  }

  return { invoiceId: invoice._id, updates, newPenalties, phaseHistoryAddition, penalties, config };
}

// ─── Record payment (atomic) ──────────────────────────────────────────────────

async function recordPayment(invoiceId, paymentData, performedBy) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const invoice = await RentInvoice.findById(invoiceId).session(session);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'PAID') throw new Error('Invoice already fully paid');

    const { amount, paymentMethod = 'cash', transactionId, notes } = paymentData;
    if (!amount || amount <= 0) throw new Error('Invalid payment amount');

    const config   = await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
    const penalties = calculatePenalties(invoice, config);

    // Use rent-specific tracker as ceiling so penalty payments don't reduce rent capacity
    const alreadyRentPaid = invoice.rentPaidAmount ?? invoice.paidAmount ?? 0;

    let penaltyPaid = 0;
    let rentPaid    = 0;
    let remaining   = amount;

    if (penalties.totalPenalty > 0 && remaining > 0) {
      penaltyPaid = Math.min(remaining, penalties.totalPenalty);
      remaining  -= penaltyPaid;
    }
    if (remaining > 0) {
      rentPaid  = Math.min(remaining, invoice.rentAmount - alreadyRentPaid);
      remaining -= rentPaid;
    }

    const newTotalPaid   = (invoice.paidAmount || 0) + rentPaid + penaltyPaid;
    const newOutstanding = Math.max(0, invoice.totalDue - newTotalPaid);
    const isFullyPaid    = newOutstanding <= 0;
    const isPartial      = !isFullyPaid && newTotalPaid > 0;

    const paymentRecord = await RentPayment.create([{
      invoiceId,
      tenantId:          invoice.tenantId,
      propertyId:        invoice.propertyId,
      ownerId:           invoice.ownerId,
      amount,
      paymentMethod,
      transactionId,
      isPartial,
      remainingAfter:    newOutstanding,
      rentPaidAmount:    rentPaid,
      penaltyPaidAmount: penaltyPaid,
      paymentDate:       new Date(),
      recordedBy:        performedBy,
      notes,
    }], { session });

    await RentInvoice.findByIdAndUpdate(invoiceId, {
      $inc: {
        paidAmount:        rentPaid + penaltyPaid, // total paid (display)
        rentPaidAmount:    rentPaid,               // rent-only tracker
        penaltyPaidAmount: penaltyPaid,            // penalty-only tracker
      },
      $set: {
        outstandingAmount: newOutstanding,
        status:            isFullyPaid ? 'PAID' : isPartial ? 'PARTIAL' : 'PENDING',
        lastEvaluatedAt:   new Date(),
      },
    }, { session });

    await session.commitTransaction();

    // Audit log written AFTER commit — never create a record for a failed transaction
    await RentAuditLog.create({
      action:     'PAYMENT_RECORDED',
      invoiceId,
      tenantId:   invoice.tenantId,
      ownerId:    invoice.ownerId,
      propertyId: invoice.propertyId,
      performedBy,
      meta:       { amount, paymentMethod, isFullyPaid, newOutstanding, rentPaid, penaltyPaid },
    }).catch(() => {});

    return { payment: paymentRecord[0], isFullyPaid, newOutstanding };
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

// ─── Waive penalty ────────────────────────────────────────────────────────────

async function waivePenalty(invoiceId, waiverData, performedBy) {
  const { reason, waivedAmount } = waiverData;
  if (!reason) throw new Error('Waiver reason is required');

  const invoice = await RentInvoice.findById(invoiceId);
  if (!invoice) throw new Error('Invoice not found');

  const waiver = {
    waivedAmount: waivedAmount || invoice.totalPenalty,
    reason,
    waivedBy:    performedBy,
    waivedAt:    new Date(),
  };

  // Use rent-specific tracker so penalty payments don't pollute the rent-paid check
  const rentPaidSoFar   = invoice.rentPaidAmount ?? invoice.paidAmount ?? 0;
  const rentFullyPaid   = rentPaidSoFar >= invoice.rentAmount;
  const anyRentPaid     = rentPaidSoFar > 0;
  const newOutstanding  = Math.max(0, invoice.rentAmount - rentPaidSoFar);

  await RentInvoice.findByIdAndUpdate(invoiceId, {
    $set: {
      waiver,
      totalPenalty:       0,
      minorPenaltyAmount: 0,
      majorPenaltyAmount: 0,
      totalDue:           newOutstanding,
      outstandingAmount:  newOutstanding,
      // WAIVED only when rent is also fully paid; otherwise keep collecting rent
      status: rentFullyPaid ? 'PAID' : anyRentPaid ? 'PARTIAL' : 'PENDING',
    },
  });

  await RentAuditLog.create({
    action: 'PENALTY_WAIVED',
    invoiceId,
    tenantId:   invoice.tenantId,
    ownerId:    invoice.ownerId,
    propertyId: invoice.propertyId,
    performedBy,
    meta: waiver,
  }).catch(() => {});

  return { success: true, waiver };
}

module.exports = {
  getEffectiveConfig,
  generateMonthlyInvoices,
  evaluateInvoice,
  recordPayment,
  waivePenalty,
};
