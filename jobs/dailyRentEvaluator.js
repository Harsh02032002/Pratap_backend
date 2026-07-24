'use strict';
const cron = require('node-cron');
const mongoose = require('mongoose');
const RentInvoice = require('../models/RentInvoice');
const RentAuditLog = require('../models/RentAuditLog');
const CronHealth = require('../models/CronHealth');
const globalConfig = require('../config/rentCollectionConfig');
const { evaluateInvoice, generateMonthlyInvoices } = require('../services/invoiceService');
const { queueNotification, dispatchNotification, retryFailedNotifications } = require('../services/notificationService');
const { shouldSendPhase1Reminder } = require('../engine/penaltyEngine');
const { acquireLock, releaseLock } = require('../services/cronLockService');
const Tenant = require('../models/Tenant');
const Owner = require('../models/Owner');
const User = require('../models/user');
const CheckinRecord = require('../models/CheckinRecord');

// ─── Date helpers for WhatsApp template variables ────────────────────────────

function formatBillingMonth(billingMonth) {
  if (!billingMonth) return '';
  const [yr, mo] = billingMonth.split('-');
  if (!yr || !mo) return billingMonth;
  return new Date(parseInt(yr), parseInt(mo) - 1)
    .toLocaleString('en', { month: 'long' }) + ' ' + yr; // "June 2026"
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  }); // "1 Jun 2026"
}

// ─── Daily evaluator — runs once per day ─────────────────────────────────────

async function runDailyRentEvaluator() {
  if (mongoose.connection.readyState !== 1) {
    console.warn('[DailyEvaluator] DB not connected, skipping');
    return;
  }

  // ── Acquire distributed cron lock ────────────────────────────────────────────
  const lockAcquired = await acquireLock('dailyRentEvaluator', globalConfig.cronLockTimeoutMinutes);
  if (!lockAcquired) {
    console.warn('[DailyEvaluator] Another instance is already running — skipping this execution');
    return;
  }

  // ── Create RUNNING health record ─────────────────────────────────────────────
  const startedAt = new Date();
  let healthRecord = null;
  try {
    healthRecord = await CronHealth.create({
      jobName: 'dailyRentEvaluator',
      startedAt,
      status: 'RUNNING',
    });
  } catch (_) {
    // Health tracking failure must never prevent the evaluator from running
  }

  const batchSize = globalConfig.cronBatchSize;
  let skip = 0;

  // Metrics accumulated across all batches
  let totalProcessed = 0;
  let totalErrors = 0;
  let totalQueued = 0;
  let totalSent = 0;
  let totalFailed = 0;

  console.log('[DailyEvaluator] Starting evaluation run...');

  try {
    while (true) {
      const invoices = await RentInvoice.find({
        status: { $in: ['PENDING', 'PARTIAL'] },
      }).skip(skip).limit(batchSize).lean();

      if (!invoices.length) break;

      const bulkOps = [];
      const auditOps = [];

      for (const invoice of invoices) {
        try {
          const { invoiceId, updates, newPenalties, phaseHistoryAddition, penalties, config } =
            await evaluateInvoice(invoice);

          const pushOps = {};
          if (newPenalties.length) {
            pushOps.penaltyHistory = { $each: newPenalties };
          }
          if (phaseHistoryAddition.length) {
            pushOps.phaseHistory = { $each: phaseHistoryAddition };
          }

          const updateDoc = { $set: updates };
          if (Object.keys(pushOps).length) updateDoc.$push = pushOps;

          bulkOps.push({
            updateOne: {
              filter: { _id: invoiceId },
              update: updateDoc,
            },
          });

          // Stage audit log entries (written after bulkWrite)
          if (phaseHistoryAddition.length) {
            auditOps.push({
              action: 'PHASE_TRANSITION',
              invoiceId,
              ownerId: invoice.ownerId,
              tenantId: invoice.tenantId,
              meta: { oldPhase: invoice.currentPhase, newPhase: penalties.phase, daysSinceDue: penalties.daysSinceDue },
            });
          }
          for (const p of newPenalties) {
            auditOps.push({
              action: 'PENALTY_APPLIED',
              invoiceId,
              ownerId: invoice.ownerId,
              tenantId: invoice.tenantId,
              meta: { type: p.type, amount: p.amount, daysSinceDue: p.daysSinceDue },
            });
          }

          const notifStats = await queueNotificationsForInvoice(invoice, penalties, config);
          totalQueued += notifStats.queued;
          totalSent += notifStats.sent;
          totalFailed += notifStats.failed;

          totalProcessed++;
        } catch (err) {
          totalErrors++;
          console.error(`[DailyEvaluator] Error on invoice ${invoice._id}:`, err.message);
        }
      }

      if (bulkOps.length) {
        await RentInvoice.bulkWrite(bulkOps, { ordered: false });
      }

      // Best-effort audit log batch write — never let logging failures halt the cron
      if (auditOps.length) {
        await RentAuditLog.insertMany(auditOps, { ordered: false }).catch(err =>
          console.error('[DailyEvaluator] Audit log batch failed:', err.message),
        );
      }

      skip += batchSize;
      if (invoices.length < batchSize) break;
    }

    console.log(`[DailyEvaluator] Done. Processed: ${totalProcessed}, Errors: ${totalErrors}`);

    // Flush queued/failed notifications from this run AND prior runs
    try {
      await retryFailedNotifications();
      await retryFailedNotifications(); // second pass — handles queues > 50
    } catch (err) {
      console.error('[DailyEvaluator] Notification flush failed:', err.message);
    }

    // ── Mark health record SUCCESS ──────────────────────────────────────────────
    if (healthRecord) {
      const completedAt = new Date();
      await CronHealth.findByIdAndUpdate(healthRecord._id, {
        $set: {
          status: 'SUCCESS',
          completedAt,
          durationMs: completedAt - startedAt,
          invoicesProcessed: totalProcessed,
          notificationsQueued: totalQueued,
          notificationsSent: totalSent,
          notificationsFailed: totalFailed,
        },
      }).catch(() => { });
    }

  } catch (err) {
    // ── Mark health record FAILED ───────────────────────────────────────────────
    console.error('[DailyEvaluator] Fatal error:', err.message);
    if (healthRecord) {
      const completedAt = new Date();
      await CronHealth.findByIdAndUpdate(healthRecord._id, {
        $set: {
          status: 'FAILED',
          completedAt,
          durationMs: completedAt - startedAt,
          invoicesProcessed: totalProcessed,
          notificationsQueued: totalQueued,
          notificationsSent: totalSent,
          notificationsFailed: totalFailed,
          errorMessage: err.message,
        },
      }).catch(() => { });
    }
  } finally {
    // Always release — even if we crashed halfway through
    await releaseLock('dailyRentEvaluator').catch(() => { });
  }
}

// ─── Queue notifications based on phase ──────────────────────────────────────
// Returns { queued, sent, failed } stats for this invoice's notifications.

async function queueNotificationsForInvoice(invoice, penalties, config) {
  const { phase, daysSinceDue } = penalties;
  const notifs = config.notifications || {};
  const channels = {
    email: notifs.email !== false,
    dashboard: notifs.dashboard !== false,
    whatsapp: Boolean(notifs.whatsapp),
  };

  const phaseKey = phase === 1
    ? `phase1-${daysSinceDue}`
    : phase === 2
      ? 'phase2'
      : `phase3-${Math.floor(daysSinceDue / 3)}`;

  const shouldNotify = phase === 1
    ? shouldSendPhase1Reminder(daysSinceDue, phase, config)
    : true;

  if (!shouldNotify) return { queued: 0, sent: 0, failed: 0 };

  // Look up live tenant contact and owner bank details
  // invoice.ownerId is a User._id — resolve loginId via User model first
  const [tenantDoc, ownerUserDoc] = await Promise.all([
    Tenant.findById(invoice.tenantId).select('name email phone').lean(),
    User.findById(invoice.ownerId).select('loginId').lean(),
  ]);
  const ownerLoginId = ownerUserDoc?.loginId || '';
  const [ownerDoc, checkinDoc] = ownerLoginId ? await Promise.all([
    Owner.findOne({ loginId: ownerLoginId })
      .select('checkinUpiId checkinBankAccountNumber checkinIfscCode checkinBankName checkinBranchName checkinAccountHolderName')
      .lean(),
    CheckinRecord.findOne({ role: 'owner', loginId: ownerLoginId }).lean(),
  ]) : [null, null];
  const _cp = checkinDoc?.ownerProfile?.payment || {};
  const _ownerUpi = ownerDoc?.checkinUpiId || _cp.upiId || '';
  const _ownerAccNum = ownerDoc?.checkinBankAccountNumber || _cp.bankAccountNumber || '';
  const _ownerIfsc = ownerDoc?.checkinIfscCode || _cp.ifscCode || '';
  const _ownerBank = ownerDoc?.checkinBankName || '';
  const _ownerHolder = ownerDoc?.checkinAccountHolderName || _cp.accountHolderName || '';

  const electricityBill = invoice.electricityBill || 0;
  const electricityUnitsConsumed = invoice.electricityUnitsConsumed || 0;

  const payload = {
    tenantEmail: tenantDoc?.email || invoice.tenantEmail || '',
    tenantName: tenantDoc?.name || invoice.tenantName || '',
    tenantPhone: tenantDoc?.phone || invoice.tenantPhone || '',
    billingMonth: invoice.billingMonth,
    billingMonthFormatted: formatBillingMonth(invoice.billingMonth),
    dueDate: formatDate(invoice.dueDate),
    rentAmount: invoice.rentAmount,
    totalPenalty: penalties.totalPenalty,
    totalDue: penalties.totalDue + electricityBill,
    daysSinceDue,
    electricityBill,
    electricityUnitsConsumed,
    electricityUnitCost: electricityBill > 0 && electricityUnitsConsumed > 0
      ? Math.round(electricityBill / electricityUnitsConsumed) : 0,
    subject: `Rent ${phase === 1 ? 'Reminder' : phase === 2 ? 'Penalty Notice' : 'Final Notice'} — ${invoice.billingMonth}`,
    ownerUpiId: _ownerUpi,
    ownerBankName: _ownerBank,
    ownerAccountHolder: _ownerHolder,
    ownerAccountNumber: _ownerAccNum,
    ownerIfscCode: _ownerIfsc,
  };

  const notifBase = {
    invoiceId: invoice._id,
    tenantId: invoice.tenantId,
    ownerId: invoice.ownerId,
    propertyId: invoice.propertyId,
    phase,
    phaseKey,
    payload,
  };

  const stats = { queued: 0, sent: 0, failed: 0 };

  for (const [channel, enabled] of [['email', channels.email], ['dashboard', channels.dashboard], ['whatsapp', channels.whatsapp]]) {
    if (!enabled) continue;

    // Feature 4: log missing contact and skip — only for Phase 2+ where penalties
    // are active and the owner most urgently needs to reach the tenant.
    if (channel === 'email' && !payload.tenantEmail) {
      if (phase >= 2) {
        await RentAuditLog.create({
          action: 'CONTACT_INFO_MISSING',
          invoiceId: invoice._id,
          tenantId: invoice.tenantId,
          ownerId: invoice.ownerId,
          meta: {
            reason: 'tenant_email_missing',
            channel: 'email',
            phase,
            billingMonth: invoice.billingMonth,
          },
        }).catch(() => { });
      }
      continue;
    }

    const log = await queueNotification({ ...notifBase, channel, templateId: `phase${phase}_${channel}` });
    if (log) {
      stats.queued++;
      const result = await dispatchNotification(log._id);
      if (result === 'sent') stats.sent++;
      if (result === 'failed') stats.failed++;
    }
  }

  return stats;
}

// ─── Monthly invoice generator — 1st of each month ───────────────────────────

async function runMonthlyInvoiceGenerator() {
  if (mongoose.connection.readyState !== 1) return;

  const now = new Date();
  const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  console.log(`[InvoiceGenerator] Generating invoices for ${billingMonth}...`);

  try {
    const Property = require('../models/Property');
    const tenants = await Tenant.find({
      status: { $in: ['active', 'pending'] },
      $or: [
        { paymentLinkStatus: 'paid' },
        { paymentLinkStatus: { $exists: false } }
      ],
      isDeleted: { $ne: true },
      agreedRent: { $gt: 0 },
    }).lean();

    const grouped = {};
    for (const t of tenants) {
      let ownerUserId = null;
      if (t.ownerLoginId) {
        const ownerUser = await User.findOne({ loginId: t.ownerLoginId, role: 'owner' }).select('_id').lean();
        ownerUserId = ownerUser?._id;
      }
      if (!ownerUserId && t.property) {
        const prop = await Property.findById(t.property).select('ownerLoginId').lean();
        if (prop?.ownerLoginId) {
          const ownerUser = await User.findOne({ loginId: prop.ownerLoginId, role: 'owner' }).select('_id').lean();
          ownerUserId = ownerUser?._id;
        }
      }
      if (!ownerUserId) continue;

      const key = String(ownerUserId);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push({
        tenantId: t._id,
        propertyId: t.property,
        unitId: t.room,
        rentAmount: t.agreedRent || 0,
      });
    }

    for (const [ownerId, tenantList] of Object.entries(grouped)) {
      await generateMonthlyInvoices(ownerId, billingMonth, tenantList);
    }

    console.log(`[InvoiceGenerator] Done for ${billingMonth}`);
  } catch (err) {
    console.error('[InvoiceGenerator] Error:', err.message);
  }
}

// ─── Register all cron jobs ───────────────────────────────────────────────────

function registerAllCronJobs() {
  // ── Morning run ───────────────────────────────────────────────────────────────
  cron.schedule(globalConfig.cronSchedule, async () => {
    try { await runDailyRentEvaluator(); }
    catch (err) { console.error('[CronJob] Daily evaluator failed:', err.message); }
  }, { timezone: globalConfig.timezone });

  // ── Afternoon run — 1:48 PM IST ───────────────────────────────────────────────
  // yaad rkhna 2  time corns ka yaha hai second wala
  cron.schedule('21 13 * * *', async () => {
    try { await runDailyRentEvaluator(); }
    catch (err) { console.error('[CronJob] Afternoon evaluator failed:', err.message); }
  }, { timezone: globalConfig.timezone });

  cron.schedule(globalConfig.invoiceGenCronSchedule, async () => {
    try { await runMonthlyInvoiceGenerator(); }
    catch (err) { console.error('[CronJob] Invoice generator failed:', err.message); }
  }, { timezone: globalConfig.timezone });

  cron.schedule(globalConfig.notifRetryCronSchedule, async () => {
    try { await retryFailedNotifications(); }
    catch (err) { console.error('[CronJob] Notification retry failed:', err.message); }
  }, { timezone: globalConfig.timezone });

  console.log('✅ Rent collection cron jobs registered');
}

module.exports = {
  registerAllCronJobs,
  runDailyRentEvaluator,
  runMonthlyInvoiceGenerator,
  queueNotificationsForInvoice,
};
