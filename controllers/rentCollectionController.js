'use strict';
const RentInvoice = require('../models/RentInvoice');
const RentPayment = require('../models/RentPayment');
const PenaltyConfig = require('../models/PenaltyConfig');
const RentAuditLog = require('../models/RentAuditLog');
const CronHealth = require('../models/CronHealth');
const Tenant = require('../models/Tenant');
const Owner = require('../models/Owner');
const globalConfig = require('../config/rentCollectionConfig');
const {
  generateMonthlyInvoices,
  evaluateInvoice,
  recordPayment,
  waivePenalty,
  getEffectiveConfig,
  autoHealMoveInInvoices,
} = require('../services/invoiceService');
const { queueNotification, dispatchNotification, sendReminderEmailDirect } = require('../services/notificationService');
const { calculatePenalties, generatePreviewBreakdown } = require('../engine/penaltyEngine');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPerformedBy(req) {
  return req.user?.loginId || String(req.user?._id) || 'unknown';
}

async function assertOwnership(invoice, reqUser) {
  if (!invoice) {
    const err = new Error('Invoice not found');
    err.status = 404;
    throw err;
  }
  const userId = reqUser?._id || reqUser;
  const userLoginId = reqUser?.loginId ? String(reqUser.loginId).toUpperCase() : null;

  const Owner = require('../models/Owner');
  const ownerDoc = userLoginId ? await Owner.findOne({ loginId: userLoginId }).lean() : null;

  const validOwnerIds = [String(userId)];
  if (ownerDoc?._id) validOwnerIds.push(String(ownerDoc._id));

  if (!validOwnerIds.includes(String(invoice.ownerId))) {
    const err = new Error('Unauthorized access');
    err.status = 403;
    throw err;
  }
}

// ─── POST /api/rent-collection/invoices/generate ──────────────────────────────
async function generateInvoices(req, res) {
  try {
    const ownerId = req.user._id;
    const { billingMonth, tenants } = req.body;
    if (!billingMonth || !Array.isArray(tenants)) {
      return res.status(400).json({ success: false, message: 'billingMonth and tenants[] required' });
    }
    const result = await generateMonthlyInvoices(ownerId, billingMonth, tenants);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── POST /api/rent-collection/penalty/calculate ──────────────────────────────
async function previewPenaltyCalculation(req, res) {
  try {
    const ownerId = req.user._id;
    const { rentAmount, propertyId, unitId, dueDate, paidAmount = 0, previewDays = 20 } = req.body;
    if (!rentAmount) return res.status(400).json({ success: false, message: 'rentAmount required' });

    const config = await getEffectiveConfig(ownerId, propertyId, unitId);
    const fakeInvoice = {
      rentAmount,
      paidAmount,
      rentPaidAmount: paidAmount,
      dueDate: dueDate || new Date(),
    };

    const current = calculatePenalties(fakeInvoice, config);
    const breakdown = generatePreviewBreakdown(rentAmount, config, previewDays);

    res.json({ success: true, current, breakdown, config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── POST /api/rent-collection/payments ───────────────────────────────────────
async function recordPaymentHandler(req, res) {
  try {
    const { invoiceId, amount, paymentMethod, transactionId, notes } = req.body;
    if (!invoiceId || !amount) {
      return res.status(400).json({ success: false, message: 'invoiceId and amount required' });
    }

    const invoice = await RentInvoice.findById(invoiceId).lean();
    await assertOwnership(invoice, req.user);

    const result = await recordPayment(
      invoiceId,
      { amount, paymentMethod, transactionId, notes },
      getPerformedBy(req),
    );
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
}

// ─── POST /api/rent-collection/invoices/:id/remind ───────────────────────────
async function sendReminder(req, res) {
  try {
    const invoice = await RentInvoice.findById(req.params.id).lean();
    await assertOwnership(invoice, req.user);

    const config = await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
    const penalties = calculatePenalties(invoice, config);

    // Always look up the tenant directly — never rely solely on what the frontend passes
    const tenantDoc = await Tenant.findById(invoice.tenantId).select('name email phone').lean();
    // invoice.ownerId is a User._id — find Owner by loginId from req.user
    const ownerLoginId = req.user.loginId;
    const CheckinRecord = require('../models/CheckinRecord');
    const [ownerDoc, checkinDoc] = await Promise.all([
      ownerLoginId ? Owner.findOne({ loginId: ownerLoginId })
        .select('checkinUpiId checkinBankAccountNumber checkinIfscCode checkinBankName checkinBranchName checkinAccountHolderName')
        .lean() : null,
      ownerLoginId ? CheckinRecord.findOne({ role: 'owner', loginId: ownerLoginId }).lean() : null,
    ]);
    const _cp = checkinDoc?.ownerProfile?.payment || {};
    const _ownerUpi = ownerDoc?.checkinUpiId || _cp.upiId || '';
    const _ownerAccNum = ownerDoc?.checkinBankAccountNumber || _cp.bankAccountNumber || '';
    const _ownerIfsc = ownerDoc?.checkinIfscCode || _cp.ifscCode || '';
    const _ownerBank = ownerDoc?.checkinBankName || '';
    const _ownerHolder = ownerDoc?.checkinAccountHolderName || _cp.accountHolderName || '';

    const [_yr, _mo] = (invoice.billingMonth || '').split('-');
    const billingMonthFormatted = (_yr && _mo)
      ? new Date(parseInt(_yr), parseInt(_mo) - 1).toLocaleString('en', { month: 'long' }) + ' ' + _yr
      : invoice.billingMonth || '';

    const payload = {
      tenantEmail: tenantDoc?.email || invoice.tenantEmail || req.body.tenantEmail || '',
      tenantName: tenantDoc?.name || invoice.tenantName || req.body.tenantName || '',
      tenantPhone: tenantDoc?.phone || invoice.tenantPhone || req.body.tenantPhone || '',
      billingMonth: invoice.billingMonth,
      billingMonthFormatted,
      dueDate: invoice.dueDate
        ? new Date(invoice.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '',
      rentAmount: invoice.rentAmount,
      totalPenalty: penalties.totalPenalty,
      daysSinceDue: penalties.daysSinceDue,
      electricityBill: invoice.electricityBill || 0,
      electricityUnitsConsumed: invoice.electricityUnitsConsumed || 0,
      electricityUnitCost: invoice.electricityBill > 0 && invoice.electricityUnitsConsumed > 0
        ? Math.round(invoice.electricityBill / invoice.electricityUnitsConsumed)
        : 0,
      totalDue: penalties.totalDue + (invoice.electricityBill || 0),
      ownerUpiId: _ownerUpi,
      ownerBankName: _ownerBank,
      ownerAccountHolder: _ownerHolder,
      ownerAccountNumber: _ownerAccNum,
      ownerIfscCode: _ownerIfsc,
    };

    if (!payload.tenantEmail || !payload.tenantEmail.includes('@')) {
      // Audit the skip so owners can see which tenants are blocking reminders
      await RentAuditLog.create({
        action: 'CONTACT_INFO_MISSING',
        invoiceId: invoice._id,
        tenantId: invoice.tenantId,
        ownerId: invoice.ownerId,
        meta: { reason: 'tenant_email_missing', channel: 'email', trigger: 'manual_reminder' },
      }).catch(() => { });
      return res.status(400).json({
        success: false,
        message: 'Tenant has no email address on file. Add it from the Tenants page first.',
      });
    }

    // Send email directly
    await sendReminderEmailDirect(payload.tenantEmail, payload, penalties.phase);

    // Send WhatsApp template — non-blocking, a failure here must not fail the response
    const channels = ['email'];
    try {
      const { sendWhatsAppTemplate, getMailerConfig, isWhatsAppConfigured, normalizePhoneNumber } = require('../utils/mailer');
      const cfg = getMailerConfig();
      const phone = payload.tenantPhone
        ? normalizePhoneNumber(payload.tenantPhone, cfg.whatsappDefaultCountryCode)
        : '';
      if (isWhatsAppConfigured(cfg) && phone) {
        const phase = penalties.phase;
        // All phases use the single approved template; amount escalates with phase
        const amount = phase === 1
          ? String(payload.rentAmount || 0)
          : String(payload.totalDue || 0); // rent + electricity + penalty for phase 2/3
        const params = [
          { name: 'tenant_name', value: payload.tenantName || 'Tenant' },
          { name: 'property_name', value: payload.billingMonthFormatted || payload.billingMonth || 'this month' },
          { name: 'due_date', value: payload.dueDate || 'as scheduled' },
          { name: 'amount', value: amount },
        ];
        const waSent = await sendWhatsAppTemplate(phone, 'roomhy_rent_due_reminder', 'en', params, cfg);
        if (waSent) {
          channels.push('whatsapp');
          // Follow-up free-form message with payment details
          const payLines = [];
          if (payload.ownerUpiId) payLines.push(`📱 *UPI ID:* ${payload.ownerUpiId}`);
          if (payload.ownerAccountNumber) {
            payLines.push(`🏦 *Bank Transfer:*`);
            if (payload.ownerBankName) payLines.push(`   Bank: ${payload.ownerBankName}`);
            if (payload.ownerAccountHolder) payLines.push(`   A/c Holder: ${payload.ownerAccountHolder}`);
            payLines.push(`   A/c No: ${payload.ownerAccountNumber}`);
            if (payload.ownerIfscCode) payLines.push(`   IFSC: ${payload.ownerIfscCode}`);
          }
          if (payLines.length) {
            const { sendWhatsAppMessage } = require('../utils/mailer');
            const payMsg = `💳 *Complete Your Payment*\n\n${payLines.join('\n')}\n\nPlease confirm once payment is done 🙏`;
            sendWhatsAppMessage(phone, payMsg, cfg).catch(() => { });
          }
        }
      }
    } catch (waErr) {
      console.warn('[sendReminder] WhatsApp template failed:', waErr.message);
    }

    res.json({ success: true, queued: channels, phase: penalties.phase });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

// ─── PATCH /api/rent-collection/invoices/:id/waive ───────────────────────────
async function waivePenaltyHandler(req, res) {
  try {
    const invoice = await RentInvoice.findById(req.params.id).lean();
    await assertOwnership(invoice, req.user);

    const { reason, waivedAmount } = req.body;
    const result = await waivePenalty(req.params.id, { reason, waivedAmount }, getPerformedBy(req));
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/dashboard ──────────────────────────────────────
async function getDashboard(req, res) {
  try {
    const ownerId = req.user._id;
    await autoHealMoveInInvoices(ownerId, req.user).catch(() => {});
    const ownerDoc = req.user.loginId ? await Owner.findOne({ loginId: req.user.loginId }).lean() : null;
    const ownerIds = [req.user._id];
    if (ownerDoc?._id) ownerIds.push(ownerDoc._id);

    const ownerFilter = { ownerId: { $in: ownerIds } };

    const [all, paid, partial, pending, waived] = await Promise.all([
      RentInvoice.countDocuments(ownerFilter),
      RentInvoice.countDocuments({ ...ownerFilter, status: 'PAID' }),
      RentInvoice.countDocuments({ ...ownerFilter, status: 'PARTIAL' }),
      RentInvoice.countDocuments({ ...ownerFilter, status: 'PENDING' }),
      RentInvoice.countDocuments({ ...ownerFilter, status: 'WAIVED' }),
    ]);

    const [phase1, phase2, phase3] = await Promise.all([
      RentInvoice.countDocuments({ ...ownerFilter, status: { $in: ['PENDING', 'PARTIAL'] }, currentPhase: 1 }),
      RentInvoice.countDocuments({ ...ownerFilter, status: { $in: ['PENDING', 'PARTIAL'] }, currentPhase: 2 }),
      RentInvoice.countDocuments({ ...ownerFilter, status: { $in: ['PENDING', 'PARTIAL'] }, currentPhase: 3 }),
    ]);

    const now = new Date();
    const currentBillingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const [overdueTotals, allTotals, penaltyTotals, monthlyAggregates] = await Promise.all([
      // Outstanding + penalty only from unpaid invoices
      RentInvoice.aggregate([
        { $match: { ...ownerFilter, status: { $in: ['PENDING', 'PARTIAL'] } } },
        { $group: { _id: null, totalOutstanding: { $sum: '$outstandingAmount' } } },
      ]),
      // Gross totals across every invoice
      RentInvoice.aggregate([
        { $match: ownerFilter },
        { $group: { _id: null, totalRentAmount: { $sum: '$rentAmount' }, totalPaid: { $sum: '$paidAmount' } } },
      ]),
      // Total penalty charged across ALL invoices (including PAID ones)
      RentInvoice.aggregate([
        { $match: { ...ownerFilter, totalPenalty: { $gt: 0 } } },
        { $group: { _id: null, totalPenalty: { $sum: '$totalPenalty' } } },
      ]),
      // Strict Monthly Segregation for perfect Spider Chart / UI synchronicity
      RentInvoice.aggregate([
        { $match: ownerFilter },
        {
          $group: {
            _id: '$billingMonth',
            expected: { $sum: { $add: [{ $ifNull: ['$rentAmount', 0] }, { $ifNull: ['$electricityBill', 0] }, { $ifNull: ['$totalPenalty', 0] }] } },
            collected: { $sum: { $ifNull: ['$paidAmount', 0] } },
            outstanding: { $sum: { $ifNull: ['$outstandingAmount', 0] } },
            pendingRent: { $sum: { $cond: [{ $in: ['$status', ['PENDING', 'PARTIAL']] }, { $ifNull: ['$rentAmount', 0] }, 0] } },
            overduePenalty: { $sum: { $cond: [{ $in: ['$status', ['PENDING', 'PARTIAL']] }, { $ifNull: ['$totalPenalty', 0] }, 0] } }
          }
        }
      ]),
    ]);

    const totalOutstanding = overdueTotals[0]?.totalOutstanding || 0;
    const totalCollected = allTotals[0]?.totalPaid || 0;
    const totalRentAmount = allTotals[0]?.totalRentAmount || 0;
    const totalPenalty = penaltyTotals[0]?.totalPenalty || 0;

    const cmRow = monthlyAggregates.find(m => m._id === currentBillingMonth) || {
      expected: 0, collected: 0, outstanding: 0, pendingRent: 0, overduePenalty: 0
    };

    res.json({
      success: true,
      stats: {
        total: all, paid, partial, pending, waived, phase1, phase2, phase3,
        totalOutstanding, totalPenalty, totalCollected, totalRentAmount,
        currentMonth: {
          period: currentBillingMonth,
          expected: cmRow.expected,
          collected: cmRow.collected,
          outstanding: cmRow.outstanding,
          pendingRent: cmRow.pendingRent,
          overduePenalty: cmRow.overduePenalty
        }
      },
      mode: globalConfig.mode,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/invoices ───────────────────────────────────────
async function listInvoices(req, res) {
  try {
    const ownerId = req.user._id;
    await autoHealMoveInInvoices(ownerId, req.user).catch(() => {});
    const { status, phase, billingMonth, propertyId, page = 1, limit = 20 } = req.query;

    const ownerDoc = req.user.loginId ? await Owner.findOne({ loginId: req.user.loginId }).lean() : null;
    const ownerIds = [req.user._id];
    if (ownerDoc?._id) ownerIds.push(ownerDoc._id);

    const filter = { ownerId: { $in: ownerIds } };
    if (status) {
      const values = status.split(',').map(v => v.trim()).filter(Boolean);
      filter.status = values.length > 1 ? { $in: values } : values[0];
    }
    if (phase) filter.currentPhase = parseInt(phase, 10);
    if (billingMonth) filter.billingMonth = billingMonth;
    // Scope to the active property when given — an owner with multiple properties must
    // only see dues/invoices for the property currently selected, not all of them merged.
    if (propertyId && propertyId !== 'all') filter.propertyId = propertyId;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const parsedLimit = parseInt(limit, 10);

    // Fetch all matching invoices to actively verify tenant deletion status
    let allInvoices = await RentInvoice.find(filter)
      .populate('tenantId', 'name email phone roomNo bedNo isDeleted')
      .sort({ dueDate: -1 })
      .lean();

    // Remove zombie invoices corresponding to deleted/removed tenants
    allInvoices = allInvoices.filter(inv => inv.tenantId && !inv.tenantId.isDeleted);

    const total = allInvoices.length;
    const paginatedInvoices = allInvoices.slice(skip, skip + parsedLimit);

    res.json({ success: true, invoices: paginatedInvoices, total, page: parseInt(page, 10), pages: Math.ceil(total / parsedLimit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/configs ────────────────────────────────────────
async function getPenaltyConfigs(req, res) {
  try {
    const ownerId = req.user._id;
    const configs = await PenaltyConfig.find({ ownerId, isActive: true }).lean();
    res.json({ success: true, configs, globalDefaults: globalConfig });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── POST /api/rent-collection/configs ───────────────────────────────────────
async function savePenaltyConfig(req, res) {
  try {
    const ownerId = req.user._id;
    // Destructure ownerId out of body so it cannot overwrite the auth-derived ownerId in the update
    const { propertyId = null, unitId = null, ownerId: _bodyOwnerId, ...rest } = req.body;

    const existing = await PenaltyConfig.findOne({ ownerId, propertyId, unitId }).lean();

    const cfg = await PenaltyConfig.findOneAndUpdate(
      { ownerId, propertyId, unitId },
      { ownerId, propertyId, unitId, ...rest, isActive: true },
      { upsert: true, new: true },
    );

    await RentAuditLog.create({
      action: existing ? 'CONFIG_UPDATED' : 'CONFIG_CREATED',
      ownerId,
      performedBy: getPerformedBy(req),
      meta: { propertyId, unitId, old: existing, new: cfg },
    }).catch(() => { }); // best-effort — never fail the response over audit logging

    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/invoices/:id ────────────────────────────────────
async function getInvoiceById(req, res) {
  try {
    console.log('getInvoiceById invoiceId:', req.params.id);
    const invoice = await RentInvoice.findById(req.params.id).lean();
    await assertOwnership(invoice, req.user);

    const config = invoice.penaltyConfigSnapshot || await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
    let live = calculatePenalties(invoice, config);

    // If invoice is already paid or waived, its penalty values are frozen.
    // Do not reflect ongoing dynamic penalties for closed invoices.
    if (['PAID', 'WAIVED'].includes(invoice.status)) {
      live = {
        ...live,
        minorPenalty: invoice.minorPenaltyAmount || 0,
        majorPenalty: invoice.majorPenaltyAmount || 0,
        totalPenalty: invoice.totalPenalty || 0,
        totalDue: invoice.totalDue || 0,
        outstandingAmount: 0,
      };
    }

    console.log('Searching RentPayment with invoiceId:', req.params.id);
    const payments = await RentPayment.find({ invoiceId: req.params.id })
      .sort({ paymentDate: -1 })
      .lean();

    console.log('Found', Array.isArray(payments) ? payments.length : 0, 'payment records for invoiceId:', req.params.id);
    if (!payments || !payments.length) {
      const allPayments = await RentPayment.find().lean();
      console.log('No payments found for invoiceId. All RentPayment records count:', Array.isArray(allPayments) ? allPayments.length : 'unknown');
      console.log('All RentPayment records sample:', allPayments.slice(0, 20));
    }

    res.json({ success: true, invoice, live, config, payments });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/cron-health ────────────────────────────────────
async function getCronHealth(req, res) {
  try {
    const [lastRun, recentRuns] = await Promise.all([
      CronHealth.findOne({ jobName: 'dailyRentEvaluator' })
        .sort({ startedAt: -1 })
        .lean(),
      CronHealth.find({ jobName: 'dailyRentEvaluator' })
        .sort({ startedAt: -1 })
        .limit(10)
        .lean(),
    ]);

    // If a run has been RUNNING for longer than the lock timeout it likely
    // crashed before the finally-block could mark it FAILED.
    const staleThresholdMs = globalConfig.cronLockTimeoutMinutes * 60 * 1000;
    const augmented = lastRun && lastRun.status === 'RUNNING'
      && (Date.now() - new Date(lastRun.startedAt).getTime()) > staleThresholdMs
      ? { ...lastRun, status: 'FAILED', errorMessage: 'Process likely crashed — lock timeout exceeded' }
      : lastRun;

    res.json({
      success: true,
      lastRun: augmented,
      recentRuns,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/missing-contacts ────────────────────────────────
async function getMissingContacts(req, res) {
  try {
    // Tenant model links to owner via ownerLoginId (String). req.user.loginId is
    // the same string stored when the tenant was assigned.
    const ownerLoginId = req.user.loginId;
    if (!ownerLoginId) {
      return res.status(400).json({ success: false, message: 'Owner loginId not found in session' });
    }

    const baseFilter = { ownerLoginId, checkoutDate: null };

    const noEmail = { ...baseFilter, email: { $in: [null, ''] } };
    const noPhone = { ...baseFilter, phone: { $in: [null, ''] } };
    const noBoth = { ...baseFilter, email: { $in: [null, ''] }, phone: { $in: [null, ''] } };
    const either = { ...baseFilter, $or: [{ email: { $in: [null, ''] } }, { phone: { $in: [null, ''] } }] };

    const [missingEmailCount, missingPhoneCount, missingBothCount, samples] = await Promise.all([
      Tenant.countDocuments(noEmail),
      Tenant.countDocuments(noPhone),
      Tenant.countDocuments(noBoth),
      Tenant.find(either)
        .select('_id name email phone roomNo bedNo')
        .limit(20)
        .lean(),
    ]);

    res.json({
      success: true,
      missingEmailCount,
      missingPhoneCount,
      missingBothCount,
      samples: samples.map(t => ({
        tenantId: t._id,
        tenantName: t.name,
        email: t.email || null,
        phone: t.phone || null,
        roomNo: t.roomNo || null,
        bedNo: t.bedNo || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/payments ───────────────────────────────────────
async function listPaymentsHandler(req, res) {
  try {
    const ownerId = req.user._id;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    // Scope to the active property when given — an owner with multiple properties must
    // only see the receipts for tenants of the property currently selected, not every
    // property they own merged together.
    const propertyId = req.query.propertyId && req.query.propertyId !== 'all' ? req.query.propertyId : null;
    const paymentQuery = { ownerId };
    if (propertyId) paymentQuery.propertyId = propertyId;
    const payments = await RentPayment.find(paymentQuery)
      .sort({ paymentDate: -1 })
      .limit(limit)
      .populate('tenantId', 'name roomNo phone email propertyId')
      .populate('invoiceId', 'billingMonth invoiceNumber rentAmount advanceChargeAmount electricityBill totalPenalty totalDue status paidAmount')
      .lean();

    const shaped = payments.map(p => ({
      _id: p._id,
      tenantId: p.tenantId?._id || null,
      transactionId: p.transactionId || p._id.toString().slice(-8).toUpperCase(),
      tenantName: p.tenantId?.name || '—',
      roomNo: p.tenantId?.roomNo || '—',
      tenantPhone: p.tenantId?.phone || '',
      tenantEmail: p.tenantId?.email || '',
      propertyId: p.tenantId?.propertyId || '',
      amount: p.amount,
      paymentMethod: p.paymentMethod,
      paymentDate: p.paymentDate,
      isPartial: p.isPartial,
      remainingAfter: p.remainingAfter,
      notes: p.notes,
      invoiceId: p.invoiceId?._id || p.invoiceId,
      billingMonth: p.invoiceId?.billingMonth || '',
      invoiceNumber: p.invoiceId?.invoiceNumber || '',
      rentAmount: p.invoiceId?.rentAmount || p.amount,
      advanceChargeAmount: p.invoiceId?.advanceChargeAmount || 0,
      electricityBill: p.invoiceId?.electricityBill || 0,
      totalPenalty: p.invoiceId?.totalPenalty || 0,
      totalDue: p.invoiceId?.totalDue || p.amount,
      invoiceStatus: p.invoiceId?.status || '',   // actual DB status: PAID / PARTIAL / PENDING
      status: 'received',
    }));

    // Fetch and merge PaymentTransaction (online bookings)
    const PaymentTransaction = require('../models/PaymentTransaction');
    const BookingRequest = require('../models/BookingRequest');
    const ownerLoginId = req.user.loginId;
    let txs = [];
    if (ownerLoginId) {
      txs = await PaymentTransaction.find({ owner_id: ownerLoginId.toUpperCase() }).lean();
      if (propertyId) txs = txs.filter(t => String(t.property_id || '') === String(propertyId));
    }

    const bookingIds = txs.map(t => t.booking_id).filter(Boolean);
    const bkRequests = await BookingRequest.find({ _id: { $in: bookingIds } }).lean();
    const bkMap = new Map(bkRequests.map(b => [b._id.toString(), b]));

    const shapedTxs = txs.map(t => {
      const bkObj = t.booking_id ? bkMap.get(t.booking_id.toString()) : null;
      return {
        _id: t._id,
        transactionId: t.razorpay_payment_id || t._id.toString().slice(-8).toUpperCase(),
        tenantName: t.tenant_name || bkObj?.name || '—',
        roomNo: '—',
        tenantPhone: bkObj?.phone || '',
        tenantEmail: bkObj?.email || '',
        propertyId: t.property_id || bkObj?.property_id || '',
        amount: t.owner_amount,
        paymentMethod: t.payment_method || 'online',
        paymentDate: t.payment_date || t.created_at,
        isPartial: false,
        remainingAfter: 0,
        notes: t.notes || 'Booking Payment',
        invoiceId: null,
        billingMonth: t.payment_date ? new Date(t.payment_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '',
        invoiceNumber: t.razorpay_payment_id || '—',
        rentAmount: t.owner_amount,
        electricityBill: 0,
        totalPenalty: 0,
        totalDue: t.owner_amount,
        status: t.payout_status === 'Paid' ? 'received' : 'pending_payout',
      };
    });

    const merged = [...shaped, ...shapedTxs]
      .sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate))
      .slice(0, limit);

    res.json({ success: true, payments: merged });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/wa-templates ───────────────────────────────────
// Diagnostic: fetch the exact template names + language codes registered in Meta
async function getWhatsAppTemplates(req, res) {
  try {
    const { listWhatsAppTemplates, getMailerConfig } = require('../utils/mailer');
    const cfg = getMailerConfig();
    const name = req.query.name || '';
    const data = await listWhatsAppTemplates(name, cfg);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/monthly-summary ────────────────────────────────
async function getMonthlySummary(req, res) {
  try {
    const ownerId = req.user._id;

    // Build last 8 calendar months (oldest → newest)
    const slots = [];
    const now = new Date();
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      slots.push({ key, label: d.toLocaleString('en', { month: 'short' }) });
    }

    const ownerDoc = req.user.loginId ? await Owner.findOne({ loginId: req.user.loginId }).lean() : null;
    const ownerIds = [req.user._id];
    if (ownerDoc?._id) ownerIds.push(ownerDoc._id);

    const keys = slots.map(s => s.key);
    const rows = await RentInvoice.aggregate([
      { $match: { ownerId: { $in: ownerIds }, billingMonth: { $in: keys } } },
      {
        $group: {
          _id: '$billingMonth',
          due: { $sum: '$rentAmount' },
          collected: { $sum: '$paidAmount' },
        }
      },
    ]);

    const map = {};
    rows.forEach(r => { map[r._id] = { due: r.due, collected: r.collected }; });

    const data = slots.map(s => ({
      month: s.label,
      due: map[s.key]?.due || 0,
      collected: map[s.key]?.collected || 0,
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/payments/daily-summary ─────────────────────────
async function getDailyPaymentSummary(req, res) {
  try {
    const ownerId = req.user._id;
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : (() => { const d = new Date(); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d; })();
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const rows = await RentPayment.aggregate([
      { $match: { ownerId, paymentDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate' } },
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Fill every calendar day in the range so the chart has no gaps
    const dayMap = {};
    rows.forEach(r => { dayMap[r._id] = r.amount; });

    const result = [];
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const cur = new Date(start);
    while (cur <= end) {
      const key = cur.toISOString().split('T')[0];
      result.push({
        date: key,
        day: DAYS[cur.getDay()],
        amount: dayMap[key] || 0,
      });
      cur.setDate(cur.getDate() + 1);
    }

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// Helper function to get ownerId by ownerLoginId
async function getOwnerIdByLoginId(ownerLoginId) {
  if (!ownerLoginId) return null;
  try {
    const Owner = require('../models/Owner');
    const owner = await Owner.findOne({ loginId: ownerLoginId }).select('_id').lean();
    return owner?._id || null;
  } catch (err) {
    console.error('Error getting ownerId by loginId:', err);
    return null;
  }
}

// ─── GET /api/rents/tenant/me ────────────────────────────────────────────────
// Tenant dashboard: Get latest invoice with LIVE penalty calculations
async function getTenantInvoiceSummary(req, res) {
  try {
    const tenantLoginId = String(req.user?.loginId || '').trim().toUpperCase();
    if (!tenantLoginId) {
      return res.status(400).json({ success: false, message: 'Authenticated tenant loginId is required' });
    }

    // Find tenant record with property details
    const tenant = await Tenant.findOne({ loginId: tenantLoginId })
      .select('_id loginId ownerLoginId property agreedRent name')
      .lean();

    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant record not found' });
    }

    console.log(`[getTenantInvoiceSummary] Found tenant: ${tenant._id} for loginId: ${tenantLoginId}`);

    // Find all invoices for this tenant - try both tenantId and tenantLoginId
    let invoices = await RentInvoice.find({ tenantId: tenant._id })
      .sort({ billingMonth: -1, dueDate: -1, createdAt: -1 })
      .lean();

    console.log(`[getTenantInvoiceSummary] Found ${invoices.length} invoices by tenantId`);

    // If no invoices found by tenantId, try finding by tenantLoginId in custom fields
    if (invoices.length === 0) {
      invoices = await RentInvoice.find({ tenantLoginId: tenantLoginId })
        .sort({ billingMonth: -1, dueDate: -1, createdAt: -1 })
        .lean();
      console.log(`[getTenantInvoiceSummary] Found ${invoices.length} invoices by tenantLoginId`);
    }

    // Debug: Show sample invoice structure if found
    if (invoices.length > 0) {
      console.log(`[getTenantInvoiceSummary] Sample invoice:`, JSON.stringify(invoices[0], null, 2));
    } else {
      // Debug: Check if ANY invoices exist in the system
      const allInvoices = await RentInvoice.find({}).limit(3).lean();
      console.log(`[getTenantInvoiceSummary] Total invoices in system: ${await RentInvoice.countDocuments()}`);
      if (allInvoices.length > 0) {
        console.log(`[getTenantInvoiceSummary] Sample system invoice:`, JSON.stringify(allInvoices[0], null, 2));
      }

      // If no invoices found for this tenant, check Rent model and create RentInvoice
      console.log(`[getTenantInvoiceSummary] No invoices found for tenant ${tenant._id}, checking Rent model...`);
      const Rent = require('../models/Rent');
      const rentRecord = await Rent.findOne({ tenantLoginId: tenantLoginId })
        .sort({ createdAt: -1 })
        .lean();

      if (rentRecord) {
        console.log(`[getTenantInvoiceSummary] Found Rent record:`, JSON.stringify({ _id: rentRecord._id, paymentStatus: rentRecord.paymentStatus, collectionMonth: rentRecord.collectionMonth, totalDue: rentRecord.totalDue }, null, 2));

        // Create RentInvoice from Rent record
        const billingMonth = rentRecord.collectionMonth || new Date().toISOString().slice(0, 7);
        const invoiceNumber = `INV-${billingMonth}-${String(tenant._id).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

        // Get ownerId from tenant if not in rentRecord
        const ownerId = rentRecord.ownerId || (tenant.ownerLoginId ? await getOwnerIdByLoginId(tenant.ownerLoginId) : null);

        // Get propertyId - try multiple sources
        let propertyId = rentRecord.propertyId;
        if (!propertyId && tenant.property) {
          if (typeof tenant.property === 'object' && tenant.property._id) {
            propertyId = tenant.property._id;
          } else if (typeof tenant.property === 'string') {
            propertyId = tenant.property;
          }
        }

        console.log(`[getTenantInvoiceSummary] Invoice fields: ownerId=${ownerId}, propertyId=${propertyId}, tenant.property=${JSON.stringify(tenant.property)}`);

        if (!ownerId || !propertyId) {
          console.log(`[getTenantInvoiceSummary] Skipping invoice creation due to missing required fields (ownerId: ${!!ownerId}, propertyId: ${!!propertyId})`);
        } else {
          const newInvoice = await RentInvoice.create({
            invoiceNumber,
            tenantId: tenant._id,
            tenantLoginId: tenantLoginId,
            tenantName: rentRecord.tenantName || tenant.loginId,
            billingMonth: billingMonth,
            rentAmount: rentRecord.rentAmount || rentRecord.totalDue || 0,
            totalDue: rentRecord.totalDue || rentRecord.rentAmount || 0,
            paidAmount: rentRecord.paidAmount || 0,
            paymentDate: rentRecord.paymentDate,
            paymentMethod: rentRecord.paymentMethod,
            status: rentRecord.paymentStatus === 'paid' ? 'PAID' : 'PENDING',
            dueDate: rentRecord.dueDate || new Date(),
            ownerId: ownerId,
            propertyId: propertyId,
            unitId: rentRecord.unitId
          });

          console.log(`[getTenantInvoiceSummary] Created RentInvoice ${newInvoice._id} from Rent record`);
          invoices.push(newInvoice);
        }
      } else {
        console.log(`[getTenantInvoiceSummary] No Rent record found for tenant ${tenantLoginId}`);

        // Create RentInvoice from tenant's agreed rent
        if (tenant.agreedRent) {
          const billingMonth = new Date().toISOString().slice(0, 7);
          const invoiceNumber = `INV-${billingMonth}-${String(tenant._id).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

          // Get ownerId from tenant
          const ownerId = tenant.ownerLoginId ? await getOwnerIdByLoginId(tenant.ownerLoginId) : null;

          // Get propertyId from tenant
          let propertyId = null;
          if (tenant.property) {
            if (typeof tenant.property === 'object' && tenant.property._id) {
              propertyId = tenant.property._id;
            } else if (typeof tenant.property === 'string') {
              propertyId = tenant.property;
            }
          }

          console.log(`[getTenantInvoiceSummary] Invoice fields from tenant: ownerId=${ownerId}, propertyId=${propertyId}, tenant.property=${JSON.stringify(tenant.property)}`);

          if (!ownerId || !propertyId) {
            console.log(`[getTenantInvoiceSummary] Skipping invoice creation due to missing required fields (ownerId: ${!!ownerId}, propertyId: ${!!propertyId})`);
          } else {
            const newInvoice = await RentInvoice.create({
              invoiceNumber,
              tenantId: tenant._id,
              tenantLoginId: tenantLoginId,
              tenantName: tenant.name,
              billingMonth: billingMonth,
              rentAmount: tenant.agreedRent,
              totalDue: tenant.agreedRent,
              paidAmount: 0,
              status: 'PENDING',
              dueDate: new Date(),
              ownerId: ownerId,
              propertyId: propertyId
            });

            console.log(`[getTenantInvoiceSummary] Created RentInvoice ${newInvoice._id} from tenant agreed rent`);
            invoices.push(newInvoice);
          }
        }
      }
    }

    // Get current month's invoice (or latest active one).
    // IMPORTANT: always check ALL invoices (including PAID) for the current month first
    // so a freshly-paid invoice is still shown correctly in the tenant dashboard.
    const currentMonth = new Date().toISOString().slice(0, 7);

    // 1. Prefer current billing month — regardless of paid/unpaid status
    const currentMonthInvoice = invoices.find((inv) => inv.billingMonth === currentMonth);

    // 2. Fall back: highest-phase unpaid invoice (for months where no invoice yet exists for current month)
    const activeInvoices = invoices.filter((inv) =>
      !['PAID', 'WAIVED', 'CANCELLED'].includes(String(inv.status || '').toUpperCase())
    );
    const fallbackInvoice =
      activeInvoices.sort((a, b) => {
        const phaseDiff = Number(b.currentPhase || 0) - Number(a.currentPhase || 0);
        if (phaseDiff !== 0) return phaseDiff;
        const dueDiff = Number(b.outstandingAmount || b.totalDue || 0) - Number(a.outstandingAmount || a.totalDue || 0);
        if (dueDiff !== 0) return dueDiff;
        const aDate = new Date(a.dueDate || a.createdAt || 0).getTime();
        const bDate = new Date(b.dueDate || b.createdAt || 0).getTime();
        return bDate - aDate;
      })[0] ||
      invoices[0] ||
      null;

    const currentInvoice = currentMonthInvoice || fallbackInvoice;

    // Evaluate invoice to get LIVE penalties.
    // Skip re-evaluation for already-PAID invoices — their amounts are already final.
    let liveInvoice = currentInvoice;
    const invoiceIsPaid = ['PAID', 'WAIVED'].includes(String(currentInvoice?.status || '').toUpperCase());
    if (currentInvoice && !invoiceIsPaid) {
      try {
        const evaluated = await evaluateInvoice(currentInvoice);
        liveInvoice = {
          ...currentInvoice,
          ...evaluated.updates,
        };
      } catch (evalErr) {
        console.warn('getTenantInvoiceSummary: evaluateInvoice failed:', evalErr.message);
      }
    }

    // ─── NEW: Sync cash payment status from Rent model ───────────────────────
    // The RentInvoice model doesn't have cashRequestStatus, but Rent model does.
    // We need to pull the cash state from Rent to show accurate status in tenant UI.
    const Rent = require('../models/Rent');
    const allRents = await Rent.find({ tenantLoginId: tenantLoginId })
      .select('collectionMonth cashRequestStatus cashOtpHash cashOtpExpiry cashRejectedAt cashRejectedReason paymentStatus')
      .lean();

    const rentMap = {};
    for (const r of allRents) {
      if (r.collectionMonth) rentMap[r.collectionMonth] = r;
    }

    // Hydrate ALL invoices
    for (const inv of invoices) {
      const r = rentMap[inv.billingMonth];
      if (r) {
        inv.cashRequestStatus = r.cashRequestStatus || 'none';
        inv.cashOtpHash = r.cashOtpHash;
        inv.cashOtpExpiry = r.cashOtpExpiry;
        inv.cashRejectedAt = r.cashRejectedAt;
        inv.cashRejectedReason = r.cashRejectedReason;
        // Prioritize Rent model paymentStatus over Invoice status
        // This ensures OTP-verified payments show as paid immediately
        inv.paymentStatus = String(r.paymentStatus || inv.status).toLowerCase() === 'paid' ? 'paid' : 'pending';
        // VERY IMPORTANT: Ensure frontend `targetRentObj._id` maps back to Rent `_id`
        // if this was requested by cash endpoints which expect `Rent.findById()`.
        inv._id = r._id;
      } else {
        inv.paymentStatus = String(inv.status).toUpperCase() === 'PAID' ? 'paid' : 'pending';
      }
    }

    if (liveInvoice) {
      const lr = rentMap[liveInvoice.billingMonth];
      if (lr) {
        liveInvoice.cashRequestStatus = lr.cashRequestStatus || 'none';
        liveInvoice.cashOtpHash = lr.cashOtpHash;
        liveInvoice.cashOtpExpiry = lr.cashOtpExpiry;
        liveInvoice.cashRejectedAt = lr.cashRejectedAt;
        liveInvoice.cashRejectedReason = lr.cashRejectedReason;
        // Prioritize Rent model paymentStatus over Invoice status
        liveInvoice.paymentStatus = String(lr.paymentStatus || liveInvoice.status).toLowerCase() === 'paid' ? 'paid' : 'pending';
        liveInvoice._id = lr._id;
      } else {
        liveInvoice.paymentStatus = String(liveInvoice.status).toUpperCase() === 'PAID' ? 'paid' : 'pending';
      }
    }

    return res.json({
      success: true,
      invoice: liveInvoice,
      invoices,
    });
  } catch (err) {
    console.error('getTenantInvoiceSummary error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to load tenant invoice summary' });
  }
}

// ─── POST /api/rent-collection/repair-missing-payments ────────────────────────
// One-time admin endpoint: finds PAID invoices with no RentPayment record and
// creates the missing entries. Safe to call multiple times (idempotent).
async function repairMissingPayments(req, res) {
  try {
    const paidInvoices = await RentInvoice.find({ status: 'PAID' }).lean();
    const Rent = require('../models/Rent');

    let repaired = 0;
    let skipped = 0;
    let failed = 0;
    const details = [];

    for (const invoice of paidInvoices) {
      try {
        // Skip if payment record already exists
        const existingPayment = await RentPayment.findOne({ invoiceId: invoice._id });
        if (existingPayment) { skipped++; continue; }

        if (!invoice.ownerId || !invoice.tenantId || !invoice.propertyId) {
          details.push({ invoice: invoice.invoiceNumber, result: 'skipped-missing-ids' });
          failed++;
          continue;
        }

        // Deterministic transactionId prevents duplicate rows on re-run
        const transactionId = `REPAIR-${String(invoice._id).slice(-8).toUpperCase()}-${String(invoice.billingMonth || '').replace('-', '')}`;
        const dupCheck = await RentPayment.findOne({ transactionId });
        if (dupCheck) { skipped++; continue; }

        // Find matching Rent for paymentMethod
        const tenantDoc = await Tenant.findById(invoice.tenantId).select('loginId').lean();
        const rentRecord = tenantDoc ? await Rent.findOne({
          $or: [
            { tenantId: invoice.tenantId },
            { tenantLoginId: tenantDoc.loginId }
          ],
          collectionMonth: invoice.billingMonth,
          paymentStatus: { $in: ['paid', 'completed'] }
        }).sort({ updatedAt: -1 }).lean() : null;

        const paidAt = invoice.lastEvaluatedAt || invoice.updatedAt || new Date();
        const amount = Number(invoice.totalDue || invoice.outstandingAmount || invoice.rentAmount || 0);
        const rentPaid = Number(invoice.rentAmount || amount);
        const penaltyPaid = Number(invoice.totalPenalty || 0);
        const payMethod = rentRecord?.paymentMethod === 'razorpay' ? 'online' : 'cash';

        await RentPayment.create({
          invoiceId: invoice._id,
          tenantId: invoice.tenantId,
          propertyId: invoice.propertyId,
          ownerId: invoice.ownerId,
          amount,
          paymentMethod: payMethod,
          transactionId,
          isPartial: false,
          remainingAfter: 0,
          rentPaidAmount: rentPaid,
          penaltyPaidAmount: penaltyPaid,
          paymentDate: paidAt,
          recordedBy: getPerformedBy(req) || 'admin-repair',
          notes: 'Cash payment',
          isLateEntry: true,
        });

        // Ensure invoice fields are correct
        await RentInvoice.findByIdAndUpdate(invoice._id, {
          $set: {
            paidAmount: amount,
            rentPaidAmount: rentPaid,
            penaltyPaidAmount: penaltyPaid,
            outstandingAmount: 0,
            status: 'PAID',
          }
        });

        await RentAuditLog.create({
          action: 'PAYMENT_REPAIRED',
          invoiceId: invoice._id,
          tenantId: invoice.tenantId,
          ownerId: invoice.ownerId,
          performedBy: getPerformedBy(req) || 'admin-repair',
          meta: { invoiceNumber: invoice.invoiceNumber, billingMonth: invoice.billingMonth, amount, payMethod },
        }).catch(() => { });

        details.push({ invoice: invoice.invoiceNumber, billingMonth: invoice.billingMonth, amount, payMethod, result: 'repaired' });
        repaired++;

      } catch (innerErr) {
        details.push({ invoice: invoice.invoiceNumber, result: 'error', error: innerErr.message });
        failed++;
      }
    }

    res.json({ success: true, summary: { total: paidInvoices.length, repaired, skipped, failed }, details });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  generateInvoices,
  previewPenaltyCalculation,
  recordPaymentHandler,
  sendReminder,
  waivePenaltyHandler,
  getDashboard,
  listInvoices,
  getPenaltyConfigs,
  savePenaltyConfig,
  getInvoiceById,
  getTenantInvoiceSummary,
  getCronHealth,
  getMissingContacts,
  listPaymentsHandler,
  getWhatsAppTemplates,
  getDailyPaymentSummary,
  getMonthlySummary,
  repairMissingPayments,
};
