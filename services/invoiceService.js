'use strict';
const mongoose = require('mongoose');
const RentInvoice = require('../models/RentInvoice');
const RentPayment = require('../models/RentPayment');
const PenaltyConfig = require('../models/PenaltyConfig');
const RentAuditLog = require('../models/RentAuditLog');
const Tenant = require('../models/Tenant');
const ElectricityMeter = require('../models/ElectricityMeter');
const globalConfig = require('../config/rentCollectionConfig');
const { calculatePenalties, determinePhase, calcDaysSinceDue } = require('../engine/penaltyEngine');

// ─── Config priority: unit → property → owner-default → .env global ──────────

async function getEffectiveConfig(ownerId, propertyId, unitId) {
  let cfg = null;
  const isOwnerObjId = ownerId && mongoose.Types.ObjectId.isValid(ownerId) && String(ownerId).match(/^[0-9a-fA-F]{24}$/);
  const isPropObjId = propertyId && mongoose.Types.ObjectId.isValid(propertyId) && String(propertyId).match(/^[0-9a-fA-F]{24}$/);
  const isUnitObjId = unitId && mongoose.Types.ObjectId.isValid(unitId) && String(unitId).match(/^[0-9a-fA-F]{24}$/);

  try {
    if (isOwnerObjId) {
      if (isUnitObjId && isPropObjId) {
        cfg = await PenaltyConfig.findOne({ ownerId, propertyId, unitId, isActive: true }).lean().catch(() => null);
      }
      if (!cfg && isPropObjId) {
        cfg = await PenaltyConfig.findOne({ ownerId, propertyId, unitId: null, isActive: true }).lean().catch(() => null);
      }
      if (!cfg) {
        cfg = await PenaltyConfig.findOne({ ownerId, propertyId: null, unitId: null, isDefault: true, isActive: true }).lean().catch(() => null);
      }
    }
  } catch (_) {}

  if (cfg) return mergeWithGlobal(cfg);
  return buildGlobalConfig();
}

function mergeWithGlobal(cfg) {
  return {
    mode: globalConfig.mode,
    gracePeriodDays: cfg.gracePeriodDays ?? globalConfig.gracePeriodDays,
    minorPenaltyDay: cfg.minorPenaltyDay ?? globalConfig.minorPenaltyDay,
    majorPenaltyDay: cfg.majorPenaltyDay ?? globalConfig.majorPenaltyDay,
    phase1ReminderFrequencyDays: cfg.phase1ReminderFrequencyDays ?? globalConfig.phase1ReminderFrequencyDays,
    minorPenalty: cfg.minorPenalty || { enabled: false },
    majorPenalty: cfg.majorPenalty || { enabled: false },
    notifications: cfg.notifications || { email: true, dashboard: true, whatsapp: false },
  };
}

function buildGlobalConfig() {
  return {
    mode: globalConfig.mode,
    gracePeriodDays: globalConfig.gracePeriodDays,
    minorPenaltyDay: globalConfig.minorPenaltyDay,
    majorPenaltyDay: globalConfig.majorPenaltyDay,
    phase1ReminderFrequencyDays: globalConfig.phase1ReminderFrequencyDays,
    minorPenalty: { enabled: false, type: 'fixed', value: 0 },
    majorPenalty: { enabled: false, type: 'fixed', value: 0 },
    notifications: { email: true, dashboard: true, whatsapp: false },
  };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} invoice
 * @param {string} tenantId
 * @param {object} [prefetched] tenant doc the caller already has. Passed in by
 *   generateMonthlyInvoices, which fetches every tenant up front — without it
 *   this re-queried the SAME tenant the caller had just read, once per invoice.
 */
/** Does this meter reading belong to this tenant's room? Mirrors the $or below. */
function meterMatchesTenant(meter, tenant) {
  if (String(meter.property) !== String(tenant.property)) return false;
  if (!(meter.totalBill > 0)) return false;
  if (tenant.roomNo && meter.roomNo &&
      String(meter.roomNo).toLowerCase() === String(tenant.roomNo).toLowerCase()) return true;
  if (tenant.room && meter.room && String(meter.room) === String(tenant.room)) return true;
  return false;
}

async function attachPendingElectricity(invoice, tenantId, prefetched, meterPool, prefetch = {}) {
  const tenant = prefetched
    || await Tenant.findById(tenantId).select('property roomNo room').lean();
  if (!tenant?.property) return;

  const orClause = [];
  if (tenant.roomNo) orClause.push({ roomNo: { $regex: new RegExp(`^${escapeRegex(tenant.roomNo)}$`, 'i') } });
  if (tenant.room) orClause.push({ room: tenant.room });
  if (!orClause.length) return;

  // A caller generating many invoices hands over every meter reading for the
  // month in one go, so this matches in memory rather than issuing a query per
  // tenant. Falls back to the single lookup for any other caller.
  const meter = meterPool
    ? meterPool.find(mtr => meterMatchesTenant(mtr, tenant))
    : await ElectricityMeter.findOne({
        property: tenant.property,
        billingMonth: invoice.billingMonth,
        totalBill: { $gt: 0 },
        $or: orClause,
      }).lean();

  if (!meter?.totalBill) return;

  invoice.electricityBill = meter.totalBill;
  invoice.electricityUnitsConsumed = meter.unitsConsumed || 0;
  invoice.electricityPrevReading = meter.previousReading || 0;
  invoice.electricityCurrReading = meter.currentReading || 0;
  invoice.electricityReadingAdded = true;

  const { updates } = await evaluateInvoice(invoice, null, prefetch);
  Object.assign(invoice, updates);
}

// ─── Invoice generation (idempotent, race-safe via unique index) ──────────────

async function generateMonthlyInvoices(ownerId, billingMonth, tenants) {
  const results = { created: 0, skipped: 0, errors: [] };
  if (!tenants.length) return results;

  // ── Batch the reads ────────────────────────────────────────────────────────
  //
  // This loop used to make up to EIGHT sequential round-trips per tenant: the
  // tenant, the existing-invoice check, three cascading PenaltyConfig lookups
  // inside getEffectiveConfig, an electricity meter, the save, and an audit log.
  // At ~30 tenants that is ~240 serial queries, which measured past the 10s
  // request deadline — the deadline answered 503 while this kept running, and
  // the handler's later res.json() threw ERR_HTTP_HEADERS_SENT.
  //
  // The three lookups below replace 2 per-tenant queries with 2 total, and the
  // config memo collapses the cascade to one resolution per property/unit
  // rather than one per tenant. Tenants in the same property share a config, so
  // in practice that is the difference between 90 queries and 3.
  const tenantIds = tenants.map(t => t.tenantId);

  const [tenantDocs, existingInvoices] = await Promise.all([
    // property/roomNo/room are here for attachPendingElectricity, which used to
    // fetch the same tenant again for them.
    Tenant.find({ _id: { $in: tenantIds } })
      .select('name email phone moveInDate property roomNo room digitalCheckin.agreementDetails.lateFee').lean(),
    RentInvoice.find({ ownerId, billingMonth, tenantId: { $in: tenantIds } }).select('tenantId').lean(),
  ]);

  // Every meter reading these tenants could match, in one query instead of one
  // per tenant. Scoped to the properties actually involved.
  const propertyIds = [...new Set(tenantDocs.map(d => d.property).filter(Boolean).map(String))];
  const meterPool = propertyIds.length
    ? await ElectricityMeter.find({
        property: { $in: propertyIds },
        billingMonth,
        totalBill: { $gt: 0 },
      }).lean()
    : [];

  const tenantById = new Map(tenantDocs.map(d => [String(d._id), d]));
  const alreadyInvoiced = new Set(existingInvoices.map(i => String(i.tenantId)));

  const configCache = new Map();
  const configFor = async (propertyId, unitId) => {
    const key = `${propertyId || ''}|${unitId || ''}`;
    if (!configCache.has(key)) configCache.set(key, await getEffectiveConfig(ownerId, propertyId, unitId));
    return configCache.get(key);
  };

  // Audit entries are collected and written once at the end — they are a record
  // of what happened, and nothing in the loop reads them back.
  const auditEntries = [];
  // Built in memory, then written in one insertMany below.
  const pending = [];

  for (const tenant of tenants) {
    try {
      if (alreadyInvoiced.has(String(tenant.tenantId))) { results.skipped++; continue; }

      const tenantDoc = tenantById.get(String(tenant.tenantId)) || null;
      const config = await configFor(tenant.propertyId, tenant.unitId);

      const dueYear = parseInt(billingMonth.split('-')[0], 10);
      const dueMonth = parseInt(billingMonth.split('-')[1], 10) - 1; // 0-indexed
      const dueDay = config.rentDueDay || 1;
      const dueDate = new Date(dueYear, dueMonth, dueDay);

      const invoiceNumber = `INV-${billingMonth}-${String(tenant.tenantId).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

      const invoice = new RentInvoice({
        invoiceNumber,
        ownerId,
        propertyId: tenant.propertyId,
        unitId: tenant.unitId,
        tenantId: tenant.tenantId,
        tenantName: tenantDoc?.name || '',
        tenantEmail: tenantDoc?.email || '',
        tenantPhone: tenantDoc?.phone || '',
        billingMonth,
        rentAmount: tenant.rentAmount,
        dueDate,
        totalDue: tenant.rentAmount,
        outstandingAmount: tenant.rentAmount,
        penaltyConfigSnapshot: config,
      });

      await attachPendingElectricity(invoice, tenant.tenantId, tenantDoc, meterPool, { config, tenantDoc });
      pending.push({ invoice, tenant });
    } catch (err) {
      results.errors.push({ tenantId: tenant.tenantId, error: err.message });
    }
  }

  // ── One write for the whole batch ──────────────────────────────────────────
  //
  // A save() per tenant was the last remaining per-tenant round-trip, and with
  // 100+ tenants it was the whole cost of the request. insertMany sends them
  // together. RentInvoice has no save middleware, so nothing is skipped by not
  // going through save() — validators and defaults still apply.
  //
  // ordered:false so one rejected document cannot abandon the rest, and the
  // { tenantId, billingMonth } unique index still arbitrates against a request
  // running concurrently: those come back as 11000 write errors, which are
  // duplicates rather than failures and are counted as skipped.
  if (pending.length) {
    const docs = pending.map(p => p.invoice);
    let insertedCount = docs.length;
    try {
      await RentInvoice.insertMany(docs, { ordered: false });
    } catch (err) {
      const writeErrors = err?.writeErrors || err?.result?.result?.writeErrors || [];
      if (!writeErrors.length) throw err;
      insertedCount = docs.length - writeErrors.length;
      for (const we of writeErrors) {
        const code = we?.err?.code ?? we?.code;
        const at = we?.err?.index ?? we?.index;
        const failed = pending[at];
        if (code === 11000) results.skipped++;
        else results.errors.push({
          tenantId: failed?.tenant?.tenantId,
          error: we?.err?.errmsg || we?.errmsg || 'insert failed',
        });
      }
      const failedIdx = new Set(writeErrors.map(we => we?.err?.index ?? we?.index));
      pending.forEach((p, i) => { if (failedIdx.has(i)) p.failed = true; });
    }

    results.created += insertedCount;
    for (const p of pending) {
      if (p.failed) continue;
      auditEntries.push({
        action: 'INVOICE_CREATED',
        invoiceId: p.invoice._id,
        tenantId: p.tenant.tenantId,
        ownerId,
        propertyId: p.tenant.propertyId,
        meta: { billingMonth, rentAmount: p.tenant.rentAmount },
      });
    }
  }

  if (auditEntries.length) {
    // ordered:false so one bad entry cannot discard the rest, and a failure to
    // write the audit trail must not fail invoices that were actually created.
    try {
      await RentAuditLog.insertMany(auditEntries, { ordered: false });
    } catch (err) {
      console.warn('[generateMonthlyInvoices] audit log write failed:', err.message);
    }
  }

  return results;
}

// ─── THE GOLDEN RULE: always recalculate from dueDate ────────────────────────

/**
 * @param {object} invoice
 * @param {Date|null} [asOfDate]
 * @param {{config?:object, tenantDoc?:object}} [prefetch] values the caller
 *   already holds. Bulk generation passes both so this does not re-query the
 *   config and the tenant once per invoice; every other caller omits it and
 *   behaves exactly as before.
 */
async function evaluateInvoice(invoice, asOfDate = null, prefetch = {}) {
  // Always use the live config so invoices created before penalty settings were
  // configured still get correct penalties after the owner sets them up.
  let config = prefetch.config
    || await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);

  // If the owner hasn't configured a Phase 3 penalty (or set it to 0), fall back
  // to the lateFee stored on the tenant's agreement (digitalCheckin.agreementDetails.lateFee).
  // This ensures the per-tenant late fee actually appears in penalty calculations.
  if (!config.majorPenalty?.enabled || !config.majorPenalty?.value) {
    const tenantDoc = prefetch.tenantDoc
      || await Tenant.findById(invoice.tenantId)
        .select('digitalCheckin.agreementDetails.lateFee')
        .lean();
    const tenantLateFee = Number(tenantDoc?.digitalCheckin?.agreementDetails?.lateFee) || 0;
    if (tenantLateFee > 0) {
      config = {
        ...config,
        majorPenalty: {
          enabled: true,
          type: 'per_day',
          value: tenantLateFee,
          incrementValue: 0,
          maxCap: 0,
        },
      };
    }
  }

  let penalties = calculatePenalties(invoice, config, asOfDate);
  const previousPhase = invoice.currentPhase;

  const electricityBill = invoice.electricityBill || 0;

  // `penalties.totalDue` is actually the remaining unpaid portion of the base.
  // We need `totalDue` to represent the GROSS total invoice amount, and `outstandingAmount` for the unpaid portion.
  const rentPaid = invoice.rentPaidAmount ?? invoice.paidAmount ?? 0;

  // A late fee stops accruing once the rent it is charged on has been paid — freeze it
  // at what was recorded then. Without this, re-evaluating a rent-settled invoice (e.g.
  // one reopened to PARTIAL because electricity was added later) recomputes the fee as
  // of today: a per_day fee keeps growing after the tenant paid, and a percentage fee
  // (charged on unpaid rent) collapses to ₹0 and drops off the receipt.
  const rentSettled = (invoice.rentAmount || 0) > 0 && rentPaid >= (invoice.rentAmount || 0);
  if (rentSettled) {
    penalties = {
      ...penalties,
      phase: invoice.currentPhase ?? penalties.phase,
      daysSinceDue: invoice.daysSinceDue ?? penalties.daysSinceDue,
      minorPenalty: invoice.minorPenaltyAmount || 0,
      majorPenalty: invoice.majorPenaltyAmount || 0,
      totalPenalty: invoice.totalPenalty || 0,
    };
  }

  const updates = {
    daysSinceDue: penalties.daysSinceDue,
    currentPhase: penalties.phase,
    minorPenaltyAmount: penalties.minorPenalty,
    majorPenaltyAmount: penalties.majorPenalty,
    totalPenalty: penalties.totalPenalty,
    outstandingAmount: Math.max(0, (invoice.rentAmount || 0) - rentPaid) + penalties.totalPenalty + electricityBill - Math.max(0, (invoice.paidAmount || 0) - rentPaid),
    totalDue: (invoice.rentAmount || 0) + penalties.totalPenalty + electricityBill,
    lastEvaluatedAt: new Date(),
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

    const config = await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
    const penalties = calculatePenalties(invoice, config);

    // Safe tracker metrics
    const alreadyRentPaid = invoice.rentPaidAmount ?? invoice.paidAmount ?? 0;
    const alreadyPenaltyPaid = invoice.penaltyPaidAmount ?? 0;

    let penaltyPaid = 0;
    let rentPaid = 0;
    let remaining = amount;

    // 1. Pay off remaining penalties first
    if (penalties.totalPenalty > 0 && remaining > 0) {
      penaltyPaid = Math.max(0, Math.min(remaining, penalties.totalPenalty - alreadyPenaltyPaid));
      remaining -= penaltyPaid;
    }

    // 2. Pay off remaining rent
    if (remaining > 0) {
      rentPaid = Math.max(0, Math.min(remaining, invoice.rentAmount - alreadyRentPaid));
      remaining -= rentPaid;
    }

    // Whatever `remaining` cash is left (e.g. Electricity cash) MUST be included in the total!
    // The master tracker perfectly absorbs Rent + Penalty + Electricity cash.
    const newTotalPaid = (invoice.paidAmount || 0) + rentPaid + penaltyPaid + remaining;
    const newOutstanding = Math.max(0, invoice.totalDue - newTotalPaid);
    const isFullyPaid = newOutstanding <= 0;
    const isPartial = !isFullyPaid && newTotalPaid > 0;

    const paymentRecord = await RentPayment.create([{
      invoiceId,
      tenantId: invoice.tenantId,
      propertyId: invoice.propertyId,
      ownerId: invoice.ownerId,
      amount,
      paymentMethod,
      transactionId,
      isPartial,
      remainingAfter: newOutstanding,
      rentPaidAmount: rentPaid,
      penaltyPaidAmount: penaltyPaid,
      paymentDate: new Date(),
      recordedBy: performedBy,
      notes,
    }], { session });

    await RentInvoice.findByIdAndUpdate(invoiceId, {
      $inc: {
        paidAmount: amount, // definitively add ALL physical cash directly to the master tracker!
        rentPaidAmount: rentPaid,
        penaltyPaidAmount: penaltyPaid,
      },
      $set: {
        outstandingAmount: newOutstanding,
        status: isFullyPaid ? 'PAID' : isPartial ? 'PARTIAL' : 'PENDING',
        lastEvaluatedAt: new Date(),
      },
    }, { session });

    await session.commitTransaction();

    // Audit log written AFTER commit — never create a record for a failed transaction
    await RentAuditLog.create({
      action: 'PAYMENT_RECORDED',
      invoiceId,
      tenantId: invoice.tenantId,
      ownerId: invoice.ownerId,
      propertyId: invoice.propertyId,
      performedBy,
      meta: { amount, paymentMethod, isFullyPaid, newOutstanding, rentPaid, penaltyPaid },
    }).catch(() => { });

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
    waivedBy: performedBy,
    waivedAt: new Date(),
  };

  // Use rent-specific tracker so penalty payments don't pollute the rent-paid check
  const rentPaidSoFar = invoice.rentPaidAmount ?? invoice.paidAmount ?? 0;
  const rentFullyPaid = rentPaidSoFar >= invoice.rentAmount;
  const anyRentPaid = rentPaidSoFar > 0;
  const newOutstanding = Math.max(0, invoice.rentAmount - rentPaidSoFar);

  await RentInvoice.findByIdAndUpdate(invoiceId, {
    $set: {
      waiver,
      totalPenalty: 0,
      minorPenaltyAmount: 0,
      majorPenaltyAmount: 0,
      totalDue: newOutstanding,
      outstandingAmount: newOutstanding,
      // WAIVED only when rent is also fully paid; otherwise keep collecting rent
      status: rentFullyPaid ? 'PAID' : anyRentPaid ? 'PARTIAL' : 'PENDING',
    },
  });

  await RentAuditLog.create({
    action: 'PENALTY_WAIVED',
    invoiceId,
    tenantId: invoice.tenantId,
    ownerId: invoice.ownerId,
    propertyId: invoice.propertyId,
    performedBy,
    meta: waiver,
  }).catch(() => { });

  return { success: true, waiver };
}

async function autoHealMoveInInvoices(ownerIdInput, reqUser = null) {
  try {
    const Owner = require('../models/Owner');
    const Property = require('../models/Property');
    const Tenant = require('../models/Tenant');

    if (!ownerIdInput && !reqUser) return { success: false, message: 'No owner parameter provided' };

    const rawOwnerId = String(reqUser?.loginId || ownerIdInput || '').trim();
    if (!rawOwnerId) return { success: false, message: 'Invalid owner ID' };

    const isObjId = mongoose.Types.ObjectId.isValid(rawOwnerId) && String(rawOwnerId).match(/^[0-9a-fA-F]{24}$/);

    const ownerOrConds = [
      { loginId: rawOwnerId.toUpperCase() },
      { loginId: rawOwnerId }
    ];
    if (isObjId) {
      ownerOrConds.push({ _id: rawOwnerId });
    }

    const ownerDoc = await Owner.findOne({ $or: ownerOrConds }).lean();
    if (!ownerDoc) {
      return { success: false, message: `Owner not found for ${rawOwnerId}` };
    }

    const ownerObjId = ownerDoc._id;
    const ownerLoginId = ownerDoc.loginId || rawOwnerId.toUpperCase();
    const isOwnerObjectId = ownerObjId && mongoose.Types.ObjectId.isValid(ownerObjId) && String(ownerObjId).match(/^[0-9a-fA-F]{24}$/);

    // Deterministic ObjectId for models requiring Schema.Types.ObjectId ref to Owner when ownerDoc._id is a custom string
    const safeOwnerObjectId = isOwnerObjectId
      ? ownerObjId
      : new mongoose.Types.ObjectId(require('crypto').createHash('md5').update(String(ownerLoginId || rawOwnerId)).digest('hex').slice(0, 24));

    // Find properties owned by this owner
    const properties = await Property.find({
      $or: [
        { ownerLoginId },
        ...(isOwnerObjectId ? [{ owner: ownerObjId }] : [])
      ],
      isDeleted: { $ne: true }
    }).select('_id').lean();
    const propertyIds = properties.map(p => p._id);

    // Find all active, non-deleted tenants for this owner who have completed payment
    const tenants = await Tenant.find({
      $or: [
        { ownerLoginId },
        ...(propertyIds.length > 0 ? [{ property: { $in: propertyIds } }] : []),
        ...(isOwnerObjectId ? [{ assignedBy: ownerObjId }] : [])
      ],
      isDeleted: { $ne: true },
      status: { $ne: 'inactive' },
      paymentLinkStatus: 'paid' // Only create invoices for tenants who have actually paid
    }).lean();

    console.log(`[AUTO-HEAL DIAGNOSTIC] Owner: ${ownerLoginId}, Found ${tenants.length} tenants with paid status to check`);

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    for (const t of tenants) {
      const rentAmt = Number(t.agreedRent || t.baseRoomRent || 0);
      if (rentAmt <= 0) continue;

      const moveIn = t.moveInDate ? new Date(t.moveInDate) : (t.createdAt ? new Date(t.createdAt) : now);
      const moveInYear = moveIn.getFullYear();
      const moveInMonthNum = moveIn.getMonth() + 1;
      const moveInMonthStr = `${moveInYear}-${String(moveInMonthNum).padStart(2, '0')}`;

      // ONLY auto-create PAID invoice if move-in month IS the current month AND payment is verified
      if (moveInMonthStr === currentMonth) {
        const existingMoveInInv = await RentInvoice.findOne({
          tenantId: t._id,
          billingMonth: currentMonth,
        });

        if (!existingMoveInInv) {
          const config = await getEffectiveConfig(safeOwnerObjectId, t.property, null).catch(() => null);
          const dueDate = new Date(moveInYear, moveInMonthNum - 1, config?.rentDueDay || 1);
          const invoiceNumber = `INV-${currentMonth}-${String(t._id).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;
          
          // Include advance charge amount from tenant record for move-in month
          const advanceCharge = Number(t.advanceChargeAmount || t.digitalCheckin?.agreementDetails?.advanceCharge || 0);
          const totalWithAdvance = rentAmt + advanceCharge;

          const invoice = await RentInvoice.create({
            invoiceNumber,
            ownerId: safeOwnerObjectId,
            propertyId: t.property,
            tenantId: t._id,
            tenantName: t.name || '',
            tenantEmail: t.email || '',
            tenantPhone: t.phone || '',
            billingMonth: currentMonth,
            rentAmount: rentAmt,
            advanceChargeAmount: advanceCharge,
            dueDate,
            totalDue: totalWithAdvance,
            outstandingAmount: 0,
            paidAmount: totalWithAdvance,
            rentPaidAmount: rentAmt,
            status: 'PAID',
            paymentDate: moveIn,
            penaltyConfigSnapshot: config || {},
          });

          if (rentAmt > 0) {
            await RentPayment.create({
              invoiceId: invoice._id,
              tenantId: t._id,
              propertyId: t.property,
              ownerId: safeOwnerObjectId,
              amount: rentAmt,
              paymentMethod: 'online',
              transactionId: `MOVEIN-${Date.now().toString(36).toUpperCase()}`,
              isPartial: false,
              remainingAfter: 0,
              rentPaidAmount: rentAmt,
              penaltyPaidAmount: 0,
              paymentDate: moveIn,
              recordedBy: ownerLoginId || 'SYSTEM',
              notes: 'Move-in month rent — created after payment verification',
            }).catch(() => {});
          }

          await RentAuditLog.create({
            action: 'INVOICE_CREATED',
            invoiceId: invoice._id,
            tenantId: t._id,
            ownerId: safeOwnerObjectId,
            propertyId: t.property,
            meta: { billingMonth: currentMonth, rentAmount: rentAmt, note: 'Move-in month invoice created after payment verification' },
          }).catch(() => {});

          console.log(`[MOVE-IN INVOICE HEALED SUCCESS] Auto-created PAID invoice for ${t.name} (${t.loginId}), month: ${currentMonth} after payment verification`);
        }
      }
    }
  } catch (err) {
    console.warn('[autoHealMoveInInvoices] Error:', err.message);
  }
}

module.exports = {
  getEffectiveConfig,
  generateMonthlyInvoices,
  evaluateInvoice,
  recordPayment,
  waivePenalty,
  autoHealMoveInInvoices,
};

