'use strict';
const mongoose = require('mongoose');
const SystemSettings = require('../models/SystemSettings');
const PaymentTransaction = require('../models/PaymentTransaction');
const PayoutLog = require('../models/PayoutLog');
const RentInvoice = require('../models/RentInvoice');
const RefundRequest = require('../models/RefundRequest');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const BookingRequest = require('../models/BookingRequest');
const Coupon = require('../models/Coupon');
const NotificationLog = require('../models/NotificationLog');
const Rent = require('../models/Rent');

// Helper to get global system settings or create default
async function getSettings() {
  let settings = await SystemSettings.findOne({});
  if (!settings) {
    settings = await SystemSettings.create({
      commission_percentage: 10,
      revenueBalance: 0,
      fixedFee: 500,
      perBedFee: 50,
      invoicePrefix: 'RHY-',
      invoiceCounter: 1000,
      dueReminderDays: 3
    });
  }
  return settings;
}

// ─── CATEGORY 1: TENANT TRANSACTION MANAGEMENT ─────────────────────────────────
exports.getTenantReceipts = async (req, res) => {
  try {
    const invoices = await RentInvoice.find({ status: { $in: ['PAID', 'PARTIAL'] } })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ success: true, receipts: invoices });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getTenantHistory = async (req, res) => {
  try {
    const transactions = await PaymentTransaction.find({})
      .sort({ payment_date: -1 })
      .lean();
    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getTenantOtherCharges = async (req, res) => {
  try {
    const invoices = await RentInvoice.find({
      $or: [
        { electricityBill: { $gt: 0 } },
        { totalPenalty: { $gt: 0 } }
      ]
    }).sort({ createdAt: -1 }).lean();

    const charges = [];
    invoices.forEach(inv => {
      if (inv.electricityBill > 0) {
        charges.push({
          id: inv._id + '-elec',
          invoiceNumber: inv.invoiceNumber,
          tenantName: inv.tenantName || 'Tenant',
          type: 'Electricity Bill',
          amount: inv.electricityBill,
          date: inv.createdAt,
          status: inv.status
        });
      }
      if (inv.totalPenalty > 0) {
        charges.push({
          id: inv._id + '-pen',
          invoiceNumber: inv.invoiceNumber,
          tenantName: inv.tenantName || 'Tenant',
          type: 'Late Payment Fine',
          amount: inv.totalPenalty,
          date: inv.createdAt,
          status: inv.status
        });
      }
    });

    res.json({ success: true, charges });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getTenantTracking = async (req, res) => {
  try {
    const transactions = await PaymentTransaction.find({
      status: { $in: ['Created', 'Verified'] }
    }).sort({ created_at: -1 }).lean();
    res.json({ success: true, tracking: transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 2: OWNER TRANSACTION MANAGEMENT ──────────────────────────────────
exports.getOwnerReceipts = async (req, res) => {
  try {
    // Receipts represent payout-ready/processed transactions with gross, fee, net
    const txs = await PaymentTransaction.find({}).sort({ payment_date: -1 }).lean();
    res.json({ success: true, receipts: txs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOwnerHistory = async (req, res) => {
  try {
    const logs = await PayoutLog.find({}).sort({ created_at: -1 }).lean();
    res.json({ success: true, history: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOwnerServiceFees = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).sort({ payment_date: -1 }).lean();
    const serviceFees = txs.map(t => ({
      transaction_id: t._id,
      owner_id: t.owner_id,
      owner_name: t.owner_name || 'N/A',
      property_name: t.property_name || 'N/A',
      gross_booking: t.booking_amount,
      commission_percentage: t.commission_percentage,
      roomhy_fee: t.commission_amount,
      owner_net: t.owner_amount,
      date: t.payment_date
    }));
    res.json({ success: true, serviceFees });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 3: OWNER WALLET & PAYOUT ──────────────────────────────────────────
exports.getPayoutCycle = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, payoutCycle: settings.dueReminderDays === 3 ? 'weekly' : 'monthly', gracePeriodDays: settings.dueReminderDays });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePayoutCycle = async (req, res) => {
  try {
    const { cycle, gracePeriodDays } = req.body;
    const settings = await getSettings();
    settings.dueReminderDays = gracePeriodDays || (cycle === 'weekly' ? 3 : 5);
    await settings.save();
    res.json({ success: true, message: 'Payout cycle settings updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPayoutOptions = async (req, res) => {
  try {
    const owners = await Owner.find({ isDeleted: { $ne: true } })
      .select('loginId name profile walletBalance pendingBalance withdrawnBalance settings')
      .lean();
    res.json({ success: true, ownersOptions: owners });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateOwnerPayoutOption = async (req, res) => {
  try {
    const { loginId, bankName, accountNumber, ifscCode, checkoutTime, payoutMode } = req.body;
    const owner = await Owner.findOne({ loginId });
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });
    
    if (!owner.profile) owner.profile = {};
    if (bankName) owner.profile.bankName = bankName;
    if (accountNumber) owner.profile.accountNumber = accountNumber;
    if (ifscCode) owner.profile.ifscCode = ifscCode;
    if (payoutMode) owner.profile.payoutMode = payoutMode; // 'manual' or 'auto'
    
    if (checkoutTime) {
      if (!owner.settings) owner.settings = {};
      owner.settings.checkoutTime = checkoutTime;
    }
    
    await owner.save();
    res.json({ success: true, message: 'Owner financial details updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPendingPayouts = async (req, res) => {
  try {
    const pending = await PaymentTransaction.find({ payout_status: { $in: ['Pending', 'Failed'] } })
      .sort({ payment_date: 1 })
      .lean();
    res.json({ success: true, pending });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.processPayout = async (req, res) => {
  try {
    const { transactionId, manual, notes } = req.body;
    const tx = await PaymentTransaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction record not found' });
    if (tx.payout_status === 'Paid') {
      return res.status(400).json({ success: false, message: 'This transaction payout has already been paid.' });
    }

    const owner = await Owner.findOne({ loginId: tx.owner_id });
    if (owner) {
      owner.walletBalance = Math.max(0, (owner.walletBalance || 0) + tx.owner_amount);
      owner.withdrawnBalance = (owner.withdrawnBalance || 0) + tx.owner_amount;
      await owner.save();
    }

    tx.payout_status = 'Paid';
    tx.payout_date = new Date();
    tx.payout_reference = 'RHY-PAY-' + Math.floor(10000000 + Math.random() * 90000000);
    tx.payout_initiated_by = req.body.adminId || 'superadmin';
    tx.notes = notes || tx.notes || 'Payout processed successfully';
    await tx.save();

    await PayoutLog.create({
      transaction_id: tx._id,
      owner_id: tx.owner_id,
      owner_name: tx.owner_name || owner?.name || 'Owner',
      amount: tx.owner_amount,
      mode: manual ? 'upi' : 'bank',
      status: 'sandbox_success',
      account_holder: tx.payout_account_holder || owner?.profile?.name || 'Owner',
      account_number: tx.payout_account_number || owner?.profile?.accountNumber || 'N/A',
      ifsc_code: tx.payout_ifsc_code || owner?.profile?.ifscCode || 'N/A',
      bank_name: tx.payout_bank_name || owner?.profile?.bankName || 'N/A',
      payout_id: tx.payout_reference
    });

    res.json({ success: true, message: 'Payout transferred and completed successfully!', transaction: tx });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getFailedPayouts = async (req, res) => {
  try {
    const failed = await PayoutLog.find({ status: { $in: ['failed', 'sandbox_failed'] } })
      .sort({ created_at: -1 })
      .lean();
    res.json({ success: true, failed });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getBankTransferTracking = async (req, res) => {
  try {
    const logs = await PayoutLog.find({ status: { $in: ['processed', 'sandbox_success'] } })
      .sort({ created_at: -1 })
      .lean();
    res.json({ success: true, tracking: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCashReceivedTracking = async (req, res) => {
  try {
    const cashRents = await Rent.find({
      paymentMethod: 'cash',
      paymentStatus: { $in: ['paid', 'completed'] }
    }).sort({ paymentDate: -1 }).lean();
    res.json({ success: true, cashReceived: cashRents });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 4: ROOMHY REVENUE MANAGEMENT ──────────────────────────────────────
exports.getPlatformFees = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, fixedFee: settings.fixedFee, perBedFee: settings.perBedFee });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePlatformFees = async (req, res) => {
  try {
    const { fixedFee, perBedFee } = req.body;
    const settings = await getSettings();
    if (fixedFee !== undefined) settings.fixedFee = fixedFee;
    if (perBedFee !== undefined) settings.perBedFee = perBedFee;
    await settings.save();
    res.json({ success: true, message: 'Platform fees configuration updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCommissionDetails = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ 
      success: true, 
      commissionPercentage: settings.commission_percentage,
      gstPercentage: settings.gst_percentage !== undefined ? settings.gst_percentage : 18
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateCommissionDetails = async (req, res) => {
  try {
    const { commissionPercentage, gstPercentage } = req.body;
    const settings = await getSettings();
    if (commissionPercentage !== undefined) settings.commission_percentage = commissionPercentage;
    if (gstPercentage !== undefined) settings.gst_percentage = gstPercentage;
    await settings.save();
    res.json({ success: true, message: 'Platform global commission and GST configuration updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDiscounts = async (req, res) => {
  try {
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, discounts: coupons });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createDiscount = async (req, res) => {
  try {
    const { ownerLoginId, code, discount, validity } = req.body;
    const coup = await Coupon.create({
      ownerLoginId: ownerLoginId || 'global',
      code: code.toUpperCase(),
      discount,
      validity: validity || 'Unlimited validity',
      status: 'Active'
    });
    res.json({ success: true, discount: coup });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getRevenueTracking = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const metrics = {
      totalCollected: 0,
      totalCommissions: 0,
      totalOwnerEarnings: 0
    };
    txs.forEach(t => {
      metrics.totalCollected += (t.booking_amount || 0);
      metrics.totalCommissions += (t.commission_amount || 0);
      metrics.totalOwnerEarnings += (t.owner_amount || 0);
    });
    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 5: INVOICE SYSTEM ────────────────────────────────────────────────
exports.getInvoiceGenerationSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, invoicePrefix: settings.invoicePrefix, invoiceCounter: settings.invoiceCounter });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.triggerInvoicesGeneration = async (req, res) => {
  try {
    // Generate monthly rent invoices for active tenants who do not have one for this month
    const billingMonth = new Date().toISOString().slice(0, 7); // e.g. "2026-06"
    const tenants = await Tenant.find({ isDeleted: { $ne: true }, status: 'active' }).lean();
    const settings = await getSettings();
    
    let generated = 0;
    for (const tenant of tenants) {
      const existing = await RentInvoice.findOne({ tenantId: tenant._id, billingMonth });
      if (!existing) {
        const prefix = settings.invoicePrefix || 'RHY-';
        const num = settings.invoiceCounter + 1;
        settings.invoiceCounter = num;
        await settings.save();

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 5); // due in 5 days

        await RentInvoice.create({
          invoiceNumber: `${prefix}${num}`,
          ownerId: tenant.ownerId || tenant.ownerLoginId,
          propertyId: tenant.propertyId,
          tenantId: tenant._id,
          tenantName: tenant.name,
          tenantEmail: tenant.email,
          tenantPhone: tenant.phone,
          billingMonth,
          rentAmount: tenant.rent || 5000,
          dueDate,
          outstandingAmount: tenant.rent || 5000,
          totalDue: tenant.rent || 5000,
          status: 'PENDING'
        });
        generated++;
      }
    }
    res.json({ success: true, message: `Successfully generated ${generated} invoices for the month of ${billingMonth}!` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getInvoiceGstBreakdown = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const gstReport = txs.map(t => {
      const cgst = Math.round(t.commission_amount * 0.09 * 100) / 100;
      const sgst = Math.round(t.commission_amount * 0.09 * 100) / 100;
      const totalTax = cgst + sgst;
      return {
        id: t._id,
        invoiceNumber: String(t._id).slice(-8).toUpperCase(),
        owner_name: t.owner_name,
        gross_collection: t.booking_amount,
        commission: t.commission_amount,
        cgst_9: cgst,
        sgst_9: sgst,
        total_tax: totalTax,
        date: t.payment_date
      };
    });
    res.json({ success: true, gstReport });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateInvoiceNumbering = async (req, res) => {
  try {
    const { invoicePrefix, invoiceCounter } = req.body;
    const settings = await getSettings();
    if (invoicePrefix !== undefined) settings.invoicePrefix = invoicePrefix;
    if (invoiceCounter !== undefined) settings.invoiceCounter = invoiceCounter;
    await settings.save();
    res.json({ success: true, message: 'Invoice numbering prefix/counter updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getInvoiceHistory = async (req, res) => {
  try {
    const invoices = await RentInvoice.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, invoices });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 6: REFUND MANAGEMENT ──────────────────────────────────────────────
exports.getRefundHistory = async (req, res) => {
  try {
    const refunds = await RefundRequest.find({}).sort({ created_at: -1 }).lean();
    res.json({ success: true, refunds });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getRefundApprovals = async (req, res) => {
  try {
    const pendingRefunds = await RefundRequest.find({ refund_status: 'pending' })
      .sort({ created_at: 1 })
      .lean();
    res.json({ success: true, approvals: pendingRefunds });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.processRefundRequest = async (req, res) => {
  try {
    const { bookingId, amount, upiId, method, user_name, user_phone, user_email, payment_id, user_id } = req.body;
    const ref = await RefundRequest.create({
      booking_id: bookingId,
      payment_id: payment_id || 'RHY-PAY-' + Math.floor(1000 + Math.random() * 9000),
      user_id: user_id || 'U' + Math.floor(1000 + Math.random() * 9000),
      user_name: user_name || 'Guest',
      user_phone: user_phone || 'N/A',
      user_email: user_email || 'N/A',
      request_type: 'refund',
      refund_method: method || 'upi',
      upi_id: upiId || 'n/a',
      refund_amount: amount || 500,
      refund_status: 'pending'
    });
    res.json({ success: true, refundRequest: ref, message: 'Refund request raised successfully and sent for approval!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.approveRefund = async (req, res) => {
  try {
    const { refundId, approve, notes } = req.body;
    const refund = await RefundRequest.findById(refundId);
    if (!refund) return res.status(404).json({ success: false, message: 'Refund request not found' });

    if (approve) {
      refund.refund_status = 'processed';
      refund.refund_date = new Date();
      refund.refund_transaction_id = 'RHY-REF-' + Math.floor(10000000 + Math.random() * 90000000);
      refund.admin_notes = notes || 'Approved and processed successfully';
    } else {
      refund.refund_status = 'rejected';
      refund.admin_notes = notes || 'Rejected by administrator';
    }
    await refund.save();
    res.json({ success: true, message: `Refund request successfully ${approve ? 'approved and processed' : 'rejected'}!`, refund });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 7: ALERTS & AUTOMATION ───────────────────────────────────────────
exports.getAutomationSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      success: true,
      dueReminderDays: settings.dueReminderDays,
      paymentSuccessTemplate: settings.paymentSuccessTemplate,
      paymentFailureTemplate: settings.paymentFailureTemplate,
      rentDueTemplate: settings.rentDueTemplate
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateAutomationSettings = async (req, res) => {
  try {
    const { dueReminderDays, paymentSuccessTemplate, paymentFailureTemplate, rentDueTemplate } = req.body;
    const settings = await getSettings();
    if (dueReminderDays !== undefined) settings.dueReminderDays = dueReminderDays;
    if (paymentSuccessTemplate !== undefined) settings.paymentSuccessTemplate = paymentSuccessTemplate;
    if (paymentFailureTemplate !== undefined) settings.paymentFailureTemplate = paymentFailureTemplate;
    if (rentDueTemplate !== undefined) settings.rentDueTemplate = rentDueTemplate;
    await settings.save();
    res.json({ success: true, message: 'Alerts & Automation templates updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// ─── CATEGORY 8: ANALYTICS & REPORTS ────────────────────────────────────────────
exports.getRoomhyMonthlyRevenue = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const data = months.map(m => ({ month: m, revenue: 0, commission: 0 }));
    
    txs.forEach(t => {
      if (!t.payment_date) return;
      const m = new Date(t.payment_date).getMonth();
      data[m].revenue += (t.booking_amount || 0);
      data[m].commission += (t.commission_amount || 0);
    });

    res.json({ success: true, roomhyRevenue: data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getOwnerMonthlyRevenue = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const revenueMap = {};

    txs.forEach(t => {
      const key = t.owner_name || t.owner_id || 'Unknown Owner';
      if (!revenueMap[key]) {
        revenueMap[key] = { owner: key, gross: 0, commission: 0, net: 0 };
      }
      revenueMap[key].gross += (t.booking_amount || 0);
      revenueMap[key].commission += (t.commission_amount || 0);
      revenueMap[key].net += (t.owner_amount || 0);
    });

    res.json({ success: true, ownerRevenue: Object.values(revenueMap) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDueRentReports = async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const User = require('../models/user');
    const Rent = require('../models/Rent');

    // Fetch active non-deleted tenants from Tenant and User models
    const [activeTenants, activeUsers] = await Promise.all([
      Tenant.find({ isDeleted: { $ne: true }, status: { $nin: ['inactive', 'suspended', 'deleted'] } }).select('_id loginId name phone email').lean(),
      User.find({ role: { $in: ['tenant', 'user'] }, isDeleted: { $ne: true } }).select('_id loginId name phone email').lean()
    ]);

    const activeTenantIds = new Set();
    const activeTenantLogins = new Set();
    const tenantMap = {};

    activeTenants.forEach(t => {
      if (t._id) { activeTenantIds.add(t._id.toString()); tenantMap[t._id.toString()] = t; }
      if (t.loginId) { activeTenantLogins.add(String(t.loginId).toLowerCase()); tenantMap[String(t.loginId).toLowerCase()] = t; }
    });
    activeUsers.forEach(u => {
      if (u._id) { activeTenantIds.add(u._id.toString()); if (!tenantMap[u._id.toString()]) tenantMap[u._id.toString()] = u; }
      if (u.loginId) { activeTenantLogins.add(String(u.loginId).toLowerCase()); if (!tenantMap[String(u.loginId).toLowerCase()]) tenantMap[String(u.loginId).toLowerCase()] = u; }
    });

    // Query live pending/unpaid rents from Rent collection
    const liveRents = await Rent.find({
      paymentStatus: { $ne: 'paid' },
      isDeleted: { $ne: true }
    }).sort({ createdAt: -1 }).lean();

    // Filter to ONLY include tenants that are currently active in DB (NOT deleted)
    const validDueRents = liveRents.filter(r => {
      const tid = r.tenantId ? r.tenantId.toString() : '';
      const tlogin = r.tenantLoginId ? String(r.tenantLoginId).toLowerCase() : '';
      return activeTenantIds.has(tid) || activeTenantLogins.has(tlogin);
    });

    const aging = validDueRents.map((r, i) => {
      const dueD = r.dueDate ? new Date(r.dueDate) : new Date(r.createdAt || Date.now());
      const days = Math.floor((new Date() - dueD) / 86400000);
      const tid = r.tenantId ? r.tenantId.toString() : String(r.tenantLoginId || '').toLowerCase();
      const t = tenantMap[tid] || {};

      return {
        id: r._id || `DUE-${i}`,
        invoiceNumber: r.invoiceNumber || `INV-${r.collectionMonth || '2026'}-${String(r._id).slice(-6).toUpperCase()}`,
        tenantName: t.name || r.tenantName || 'Tenant User',
        tenantPhone: t.phone || r.tenantPhone || '',
        tenantEmail: t.email || r.tenantEmail || '',
        dueAmount: Number(r.totalDue || r.rentAmount || 0) - Number(r.paidAmount || 0),
        dueDate: dueD.toISOString(),
        daysOverdue: Math.max(0, days),
        status: r.paymentStatus || 'pending'
      };
    });

    res.json({ success: true, dueRents: aging });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getProfitLoss = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const refunds = await RefundRequest.find({ refund_status: 'processed' }).lean();

    let totalRevenue = 0;
    let netCommission = 0;
    txs.forEach(t => {
      totalRevenue += (t.booking_amount || 0);
      netCommission += (t.commission_amount || 0);
    });

    let totalRefunds = 0;
    refunds.forEach(r => {
      totalRefunds += (r.refund_amount || 0);
    });

    const netProfit = netCommission - totalRefunds;

    res.json({
      success: true,
      profitLoss: {
        grossRevenue: totalRevenue,
        commissionRevenue: netCommission,
        outflowsRefunds: totalRefunds,
        netOperatingIncome: netProfit
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCashflowDashboard = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const payouts = await PayoutLog.find({ status: 'sandbox_success' }).lean();
    const refunds = await RefundRequest.find({ refund_status: 'processed' }).lean();

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const data = months.map(m => ({ month: m, inflow: 0, outflow: 0 }));

    txs.forEach(t => {
      if (!t.payment_date) return;
      const m = new Date(t.payment_date).getMonth();
      data[m].inflow += (t.booking_amount || 0);
    });

    payouts.forEach(p => {
      if (!p.created_at) return;
      const m = new Date(p.created_at).getMonth();
      data[m].outflow += (p.amount || 0);
    });

    refunds.forEach(r => {
      if (!r.refund_date) return;
      const m = new Date(r.refund_date).getMonth();
      data[m].outflow += (r.refund_amount || 0);
    });

    res.json({ success: true, cashflow: data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getTransactionsReport = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).sort({ payment_date: -1 }).lean();
    res.json({ success: true, transactions: txs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getRentDueRemindersAlerts = async (req, res) => {
  try {
    const logs = await NotificationLog.find({})
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    const Tenant = require('../models/Tenant');
    const User = require('../models/user');
    const Property = require('../models/Property');

    // Get all valid tenant records from Tenant & User models
    const validTenants = await Tenant.find({ isDeleted: { $ne: true } }).select('_id name phone email status property propertyId loginId').lean();
    const validUsers = await User.find({ role: { $in: ['tenant', 'user'] }, isDeleted: { $ne: true } }).select('_id name phone email loginId').lean();

    const validTenantIdsSet = new Set();
    const validTenantMap = {};

    validTenants.forEach(t => {
      if (t._id) { validTenantIdsSet.add(t._id.toString()); validTenantMap[t._id.toString()] = t; }
      if (t.loginId) { validTenantIdsSet.add(String(t.loginId).toLowerCase()); validTenantMap[String(t.loginId).toLowerCase()] = t; }
    });
    validUsers.forEach(u => {
      if (u._id) { validTenantIdsSet.add(u._id.toString()); if (!validTenantMap[u._id.toString()]) validTenantMap[u._id.toString()] = u; }
      if (u.loginId) { validTenantIdsSet.add(String(u.loginId).toLowerCase()); if (!validTenantMap[String(u.loginId).toLowerCase()]) validTenantMap[String(u.loginId).toLowerCase()] = u; }
    });

    let enriched = [];

    if (logs && logs.length > 0) {
      // ONLY include logs whose tenant exists in DB!
      const validLogs = logs.filter(l => {
        if (!l.tenantId && !l.toLoginId) return false;
        const tid = (l.tenantId || l.toLoginId || '').toString().toLowerCase();
        return validTenantIdsSet.has(tid);
      });

      const propertyIds = validLogs.map(l => l.propertyId).filter(Boolean);
      const properties = await Property.find({ _id: { $in: propertyIds } }).select('name title address').lean();
      const propMap = properties.reduce((acc, p) => ({ ...acc, [p._id.toString()]: p }), {});

      enriched = validLogs.map(log => {
        const tid = (log.tenantId || log.toLoginId || '').toString().toLowerCase();
        const t = validTenantMap[tid] || {};
        const p = propMap[log.propertyId?.toString()] || {};
        const rawChan = (log.channel || log.type || 'whatsapp').toLowerCase();
        const channel = rawChan === 'dashboard' || rawChan === 'system' ? 'whatsapp' : rawChan;
        return {
          ...log,
          tenantName: t.name || 'Tenant User',
          tenantPhone: t.phone || 'N/A',
          tenantEmail: t.email || 'N/A',
          propertyName: p.name || p.title || 'Property',
          channel
        };
      });
    }

    // If no valid logs found, fetch real unpaid rents for existing DB tenants ONLY
    if (enriched.length === 0) {
      const Rent = require('../models/Rent');
      const dueRents = await Rent.find({ paymentStatus: { $ne: 'paid' } }).sort({ createdAt: -1 }).limit(100).lean();
      
      const filteredDueRents = dueRents.filter(r => {
        const tid = (r.tenantId || r.tenantLoginId || '').toString().toLowerCase();
        return validTenantIdsSet.has(tid);
      });

      enriched = filteredDueRents.map(r => ({
        tenantName: r.tenantName || 'Tenant User',
        tenantPhone: r.tenantPhone || 'N/A',
        tenantEmail: r.tenantEmail || 'N/A',
        propertyName: r.propertyName || 'Property',
        channel: 'whatsapp',
        phase: 1,
        status: r.paymentStatus === 'partially_paid' ? 'queued' : 'sent',
        attempts: 1,
        createdAt: r.dueDate || r.createdAt || new Date()
      }));
    }

    return res.json({ success: true, alerts: enriched });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPaymentAlerts = async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({})
      .sort({ payment_date: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, alerts: txs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPayoutAlerts = async (req, res) => {
  try {
    const logs = await PayoutLog.find({})
      .sort({ created_at: -1 })
      .limit(100)
      .lean();
      
    const pendingTxs = await PaymentTransaction.find({
      payout_status: { $in: ['Pending', 'Processing', 'Failed'] }
    })
      .sort({ payment_date: -1 })
      .limit(100)
      .lean();
      
    res.json({ success: true, logs, pending: pendingTxs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
