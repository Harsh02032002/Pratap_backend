'use strict';
const RentInvoice    = require('../models/RentInvoice');
const RentPayment    = require('../models/RentPayment');
const PenaltyConfig  = require('../models/PenaltyConfig');
const RentAuditLog   = require('../models/RentAuditLog');
const CronHealth     = require('../models/CronHealth');
const Tenant         = require('../models/Tenant');
const Owner          = require('../models/Owner');
const globalConfig   = require('../config/rentCollectionConfig');
const {
  generateMonthlyInvoices,
  evaluateInvoice,
  recordPayment,
  waivePenalty,
  getEffectiveConfig,
} = require('../services/invoiceService');
const { queueNotification, dispatchNotification, sendReminderEmailDirect } = require('../services/notificationService');
const { calculatePenalties, generatePreviewBreakdown } = require('../engine/penaltyEngine');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPerformedBy(req) {
  return req.user?.loginId || String(req.user?._id) || 'unknown';
}

async function assertOwnership(invoice, userId) {
  if (!invoice) {
    const err = new Error('Invoice not found');
    err.status = 404;
    throw err;
  }
  if (String(invoice.ownerId) !== String(userId)) {
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

    const current   = calculatePenalties(fakeInvoice, config);
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
    await assertOwnership(invoice, req.user._id);

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
    await assertOwnership(invoice, req.user._id);

    const config    = await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
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
    const _cp        = checkinDoc?.ownerProfile?.payment || {};
    const _ownerUpi    = ownerDoc?.checkinUpiId             || _cp.upiId             || '';
    const _ownerAccNum = ownerDoc?.checkinBankAccountNumber || _cp.bankAccountNumber  || '';
    const _ownerIfsc   = ownerDoc?.checkinIfscCode          || _cp.ifscCode           || '';
    const _ownerBank   = ownerDoc?.checkinBankName          || '';
    const _ownerHolder = ownerDoc?.checkinAccountHolderName || _cp.accountHolderName  || '';

    const [_yr, _mo] = (invoice.billingMonth || '').split('-');
    const billingMonthFormatted = (_yr && _mo)
      ? new Date(parseInt(_yr), parseInt(_mo) - 1).toLocaleString('en', { month: 'long' }) + ' ' + _yr
      : invoice.billingMonth || '';

    const payload = {
      tenantEmail:  tenantDoc?.email || invoice.tenantEmail || req.body.tenantEmail || '',
      tenantName:   tenantDoc?.name  || invoice.tenantName  || req.body.tenantName  || '',
      tenantPhone:  tenantDoc?.phone || invoice.tenantPhone || req.body.tenantPhone || '',
      billingMonth: invoice.billingMonth,
      billingMonthFormatted,
      dueDate: invoice.dueDate
        ? new Date(invoice.dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '',
      rentAmount:   invoice.rentAmount,
      totalPenalty: penalties.totalPenalty,
      daysSinceDue: penalties.daysSinceDue,
      electricityBill:          invoice.electricityBill          || 0,
      electricityUnitsConsumed: invoice.electricityUnitsConsumed || 0,
      electricityUnitCost:      invoice.electricityBill > 0 && invoice.electricityUnitsConsumed > 0
                                  ? Math.round(invoice.electricityBill / invoice.electricityUnitsConsumed)
                                  : 0,
      totalDue: penalties.totalDue + (invoice.electricityBill || 0),
      ownerUpiId:         _ownerUpi,
      ownerBankName:      _ownerBank,
      ownerAccountHolder: _ownerHolder,
      ownerAccountNumber: _ownerAccNum,
      ownerIfscCode:      _ownerIfsc,
    };

    if (!payload.tenantEmail || !payload.tenantEmail.includes('@')) {
      // Audit the skip so owners can see which tenants are blocking reminders
      await RentAuditLog.create({
        action:    'CONTACT_INFO_MISSING',
        invoiceId: invoice._id,
        tenantId:  invoice.tenantId,
        ownerId:   invoice.ownerId,
        meta: { reason: 'tenant_email_missing', channel: 'email', trigger: 'manual_reminder' },
      }).catch(() => {});
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
      const cfg   = getMailerConfig();
      const phone = payload.tenantPhone
        ? normalizePhoneNumber(payload.tenantPhone, cfg.whatsappDefaultCountryCode)
        : '';
      if (isWhatsAppConfigured(cfg) && phone) {
        const phase = penalties.phase;
        // All phases use the single approved template; amount escalates with phase
        const amount = phase === 1
          ? String(payload.rentAmount || 0)
          : String(payload.totalDue   || 0); // rent + electricity + penalty for phase 2/3
        const params = [
          { name: 'tenant_name',   value: payload.tenantName            || 'Tenant' },
          { name: 'property_name', value: payload.billingMonthFormatted || payload.billingMonth || 'this month' },
          { name: 'due_date',      value: payload.dueDate               || 'as scheduled' },
          { name: 'amount',        value: amount },
        ];
        const waSent = await sendWhatsAppTemplate(phone, 'roomhy_rent_due_reminder', 'en', params, cfg);
        if (waSent) {
          channels.push('whatsapp');
          // Follow-up free-form message with payment details
          const payLines = [];
          if (payload.ownerUpiId)         payLines.push(`📱 *UPI ID:* ${payload.ownerUpiId}`);
          if (payload.ownerAccountNumber) {
            payLines.push(`🏦 *Bank Transfer:*`);
            if (payload.ownerBankName)      payLines.push(`   Bank: ${payload.ownerBankName}`);
            if (payload.ownerAccountHolder) payLines.push(`   A/c Holder: ${payload.ownerAccountHolder}`);
            payLines.push(`   A/c No: ${payload.ownerAccountNumber}`);
            if (payload.ownerIfscCode)      payLines.push(`   IFSC: ${payload.ownerIfscCode}`);
          }
          if (payLines.length) {
            const { sendWhatsAppMessage } = require('../utils/mailer');
            const payMsg = `💳 *Complete Your Payment*\n\n${payLines.join('\n')}\n\nPlease confirm once payment is done 🙏`;
            sendWhatsAppMessage(phone, payMsg, cfg).catch(() => {});
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
    await assertOwnership(invoice, req.user._id);

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

    const [all, paid, partial, pending, waived] = await Promise.all([
      RentInvoice.countDocuments({ ownerId }),
      RentInvoice.countDocuments({ ownerId, status: 'PAID' }),
      RentInvoice.countDocuments({ ownerId, status: 'PARTIAL' }),
      RentInvoice.countDocuments({ ownerId, status: 'PENDING' }),
      RentInvoice.countDocuments({ ownerId, status: 'WAIVED' }),
    ]);

    const [phase1, phase2, phase3] = await Promise.all([
      RentInvoice.countDocuments({ ownerId, status: { $in: ['PENDING', 'PARTIAL'] }, currentPhase: 1 }),
      RentInvoice.countDocuments({ ownerId, status: { $in: ['PENDING', 'PARTIAL'] }, currentPhase: 2 }),
      RentInvoice.countDocuments({ ownerId, status: { $in: ['PENDING', 'PARTIAL'] }, currentPhase: 3 }),
    ]);

    const [overdueTotals, allTotals, penaltyTotals] = await Promise.all([
      // Outstanding + penalty only from unpaid invoices
      RentInvoice.aggregate([
        { $match: { ownerId, status: { $in: ['PENDING', 'PARTIAL'] } } },
        { $group: { _id: null, totalOutstanding: { $sum: '$outstandingAmount' } } },
      ]),
      // Gross totals across every invoice
      RentInvoice.aggregate([
        { $match: { ownerId } },
        { $group: { _id: null, totalRentAmount: { $sum: '$rentAmount' }, totalPaid: { $sum: '$paidAmount' } } },
      ]),
      // Total penalty charged across ALL invoices (including PAID ones)
      RentInvoice.aggregate([
        { $match: { ownerId, totalPenalty: { $gt: 0 } } },
        { $group: { _id: null, totalPenalty: { $sum: '$totalPenalty' } } },
      ]),
    ]);

    const totalOutstanding = overdueTotals[0]?.totalOutstanding || 0;
    const totalCollected   = allTotals[0]?.totalPaid     || 0;
    const totalRentAmount  = allTotals[0]?.totalRentAmount || 0;
    const totalPenalty     = penaltyTotals[0]?.totalPenalty || 0;

    res.json({
      success: true,
      stats: { total: all, paid, partial, pending, waived, phase1, phase2, phase3,
               totalOutstanding, totalPenalty, totalCollected, totalRentAmount },
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
    const { status, phase, billingMonth, page = 1, limit = 20 } = req.query;

    const filter = { ownerId };
    if (status) {
      const values = status.split(',').map(v => v.trim()).filter(Boolean);
      filter.status = values.length > 1 ? { $in: values } : values[0];
    }
    if (phase)        filter.currentPhase = parseInt(phase, 10);
    if (billingMonth) filter.billingMonth  = billingMonth;

    const skip  = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const [invoices, total] = await Promise.all([
      RentInvoice.find(filter)
        .populate('tenantId', 'name email phone roomNo bedNo')
        .sort({ dueDate: -1 }).skip(skip).limit(parseInt(limit, 10)).lean(),
      RentInvoice.countDocuments(filter),
    ]);

    res.json({ success: true, invoices, total, page: parseInt(page, 10), pages: Math.ceil(total / limit) });
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
      action:      existing ? 'CONFIG_UPDATED' : 'CONFIG_CREATED',
      ownerId,
      performedBy: getPerformedBy(req),
      meta:        { propertyId, unitId, old: existing, new: cfg },
    }).catch(() => {}); // best-effort — never fail the response over audit logging

    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ─── GET /api/rent-collection/invoices/:id ────────────────────────────────────
async function getInvoiceById(req, res) {
  try {
    const invoice = await RentInvoice.findById(req.params.id).lean();
    await assertOwnership(invoice, req.user._id);

    const config   = invoice.penaltyConfigSnapshot || await getEffectiveConfig(invoice.ownerId, invoice.propertyId, invoice.unitId);
    const live     = calculatePenalties(invoice, config);
    const payments = await RentPayment.find({ invoiceId: req.params.id })
      .sort({ paymentDate: -1 })
      .lean();

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
    const noBoth  = { ...baseFilter, email: { $in: [null, ''] }, phone: { $in: [null, ''] } };
    const either  = { ...baseFilter, $or: [{ email: { $in: [null, ''] } }, { phone: { $in: [null, ''] } }] };

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
        tenantId:   t._id,
        tenantName: t.name,
        email:      t.email  || null,
        phone:      t.phone  || null,
        roomNo:     t.roomNo || null,
        bedNo:      t.bedNo  || null,
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
    const limit   = Math.min(parseInt(req.query.limit) || 200, 500);
    const payments = await RentPayment.find({ ownerId })
      .sort({ paymentDate: -1 })
      .limit(limit)
      .populate('tenantId', 'name roomNo phone email propertyId')
      .populate('invoiceId', 'billingMonth invoiceNumber rentAmount electricityBill totalPenalty totalDue')
      .lean();

    const shaped = payments.map(p => ({
      _id:            p._id,
      transactionId:  p.transactionId || p._id.toString().slice(-8).toUpperCase(),
      tenantName:     p.tenantId?.name    || '—',
      roomNo:         p.tenantId?.roomNo  || '—',
      tenantPhone:    p.tenantId?.phone   || '',
      tenantEmail:    p.tenantId?.email   || '',
      propertyId:     p.tenantId?.propertyId || '',
      amount:         p.amount,
      paymentMethod:  p.paymentMethod,
      paymentDate:    p.paymentDate,
      isPartial:      p.isPartial,
      remainingAfter: p.remainingAfter,
      notes:          p.notes,
      invoiceId:      p.invoiceId?._id || p.invoiceId,
      billingMonth:   p.invoiceId?.billingMonth   || '',
      invoiceNumber:  p.invoiceId?.invoiceNumber  || '',
      rentAmount:     p.invoiceId?.rentAmount      || p.amount,
      electricityBill: p.invoiceId?.electricityBill || 0,
      totalPenalty:   p.invoiceId?.totalPenalty    || 0,
      totalDue:       p.invoiceId?.totalDue        || p.amount,
      status:         'received',
    }));

    // Fetch and merge PaymentTransaction (online bookings)
    const PaymentTransaction = require('../models/PaymentTransaction');
    const BookingRequest = require('../models/BookingRequest');
    const ownerLoginId = req.user.loginId;
    let txs = [];
    if (ownerLoginId) {
      txs = await PaymentTransaction.find({ owner_id: ownerLoginId.toUpperCase() }).lean();
    }

    const bookingIds = txs.map(t => t.booking_id).filter(Boolean);
    const bkRequests = await BookingRequest.find({ _id: { $in: bookingIds } }).lean();
    const bkMap = new Map(bkRequests.map(b => [b._id.toString(), b]));

    const shapedTxs = txs.map(t => {
      const bkObj = t.booking_id ? bkMap.get(t.booking_id.toString()) : null;
      return {
        _id:            t._id,
        transactionId:  t.razorpay_payment_id || t._id.toString().slice(-8).toUpperCase(),
        tenantName:     t.tenant_name || bkObj?.name || '—',
        roomNo:         '—',
        tenantPhone:    bkObj?.phone || '',
        tenantEmail:    bkObj?.email || '',
        propertyId:     t.property_id || bkObj?.property_id || '',
        amount:         t.owner_amount,
        paymentMethod:  t.payment_method || 'online',
        paymentDate:    t.payment_date || t.created_at,
        isPartial:      false,
        remainingAfter: 0,
        notes:          t.notes || 'Booking Payment',
        invoiceId:      null,
        billingMonth:   t.payment_date ? new Date(t.payment_date).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '',
        invoiceNumber:  t.razorpay_payment_id || '—',
        rentAmount:     t.owner_amount,
        electricityBill: 0,
        totalPenalty:   0,
        totalDue:       t.owner_amount,
        status:         t.payout_status === 'Paid' ? 'received' : 'pending_payout',
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
    const cfg  = getMailerConfig();
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
    const now   = new Date();
    for (let i = 7; i >= 0; i--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      slots.push({ key, label: d.toLocaleString('en', { month: 'short' }) });
    }

    const keys = slots.map(s => s.key);
    const rows = await RentInvoice.aggregate([
      { $match: { ownerId, billingMonth: { $in: keys } } },
      { $group: {
        _id:       '$billingMonth',
        due:       { $sum: '$rentAmount' },
        collected: { $sum: '$paidAmount' },
      }},
    ]);

    const map = {};
    rows.forEach(r => { map[r._id] = { due: r.due, collected: r.collected }; });

    const data = slots.map(s => ({
      month:     s.label,
      due:       map[s.key]?.due       || 0,
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

    const start = startDate ? new Date(startDate) : (() => { const d = new Date(); d.setDate(d.getDate() - 6); d.setHours(0,0,0,0); return d; })();
    const end   = endDate   ? new Date(endDate)   : new Date();
    end.setHours(23, 59, 59, 999);

    const rows = await RentPayment.aggregate([
      { $match: { ownerId, paymentDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate' } },
          amount: { $sum: '$amount' },
          count:  { $sum: 1 },
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
        date:   key,
        day:    DAYS[cur.getDay()],
        amount: dayMap[key] || 0,
      });
      cur.setDate(cur.getDate() + 1);
    }

    res.json({ success: true, data: result });
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
  getCronHealth,
  getMissingContacts,
  listPaymentsHandler,
  getWhatsAppTemplates,
  getDailyPaymentSummary,
  getMonthlySummary,
};
