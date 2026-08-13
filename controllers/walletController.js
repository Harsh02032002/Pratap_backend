const Owner = require('../models/Owner');
const BookingRequest = require('../models/BookingRequest');
const PaymentTransaction = require('../models/PaymentTransaction');
const PayoutRequest = require('../models/PayoutRequest');
const { directBankTransfer } = require('../services/cashfreePayoutService');

/**
 * GET /api/wallet/owner/balance
 * Returns live held, available, and withdrawn balances for Owner.
 */
exports.getOwnerWalletBalance = async (req, res) => {
  try {
    const loginId = req.user?.loginId || req.query.ownerLoginId || req.query.loginId;
    if (!loginId) {
      return res.status(400).json({ success: false, message: 'loginId is required' });
    }

    // First auto-release any eligible held funds (move-in date + 24 hours)
    // Held balance removed - funds go directly to wallet

    const Rent = require('../models/Rent');
    const RentPayment = require('../models/RentPayment');

    const owner = await Owner.findOne({
      $or: [{ loginId }, { _id: req.user?._id }]
    }).lean();

    if (!owner) {
      return res.status(404).json({ success: false, message: 'Owner account not found' });
    }

    // Fetch transactions & booking requests
    const [availableTx, payoutLogs, ownerBookings, rentPayments, rents] = await Promise.all([
      PaymentTransaction.find({ $or: [{ owner_id: loginId }, { owner_login_id: loginId }], wallet_status: 'available' }).sort({ createdAt: -1 }).lean(),
      PayoutRequest.find({ login_id: loginId, user_type: 'owner' }).sort({ createdAt: -1 }).lean(),
      BookingRequest.find({
        $or: [{ owner_id: loginId }, { ownerLoginId: loginId }],
        paymentStatus: { $in: ['PAID', 'completed'] }
      }).lean(),
      // 💰 Include manual/cash rent payments recorded by admin (RentPayment uses ObjectId, not loginId)
      RentPayment.find({ ownerId: owner._id }).sort({ createdAt: -1 }).lean().catch(() => []),
      Rent.find({ ownerLoginId: loginId, ownerPayoutStatus: 'paid' }).sort({ createdAt: -1 }).lean().catch(() => []),
    ]);

    let liveAvailable = owner.availableBalance || owner.walletBalance || 0;

    const calcAvail = availableTx.reduce((s, t) => s + (t.owner_amount || Math.round((t.total_amount || 0) * 0.95)), 0);

    if (calcAvail > 0) liveAvailable = Math.max(liveAvailable, calcAvail);

    // 💰 Add manual RentPayments (admin recorded cash/bank transfers)
    const rentPaymentSum = rentPayments.reduce((s, r) => s + (r.amount || r.paidAmount || 0), 0);
    const rentSum = rents.reduce((s, r) => s + (r.paidAmount || r.amount || 0), 0);
    const manualTotal = Math.max(rentPaymentSum, rentSum); // take the larger to avoid double-count

    if (manualTotal > 0) {
      // Subtract already-withdrawn amount so we don't show withdrawn funds as available
      const withdrawn = owner.withdrawnBalance || 0;
      const manualAvailable = Math.max(0, manualTotal - withdrawn);
      liveAvailable = Math.max(liveAvailable, manualAvailable);
      console.log(`💰 [WalletCtrl] Owner ${loginId}: RentPayment sum ₹${rentPaymentSum}, Rent sum ₹${rentSum}, manualAvailable ₹${manualAvailable}`);
    }

    // Fallback: If no transaction objects, but confirmed paid booking requests exist
    if (liveAvailable === 0 && ownerBookings.length > 0) {
      const bookingSum = ownerBookings.reduce((s, b) => s + (b.total_amount || b.rent_amount || 2500), 0);
      liveAvailable = Math.round(bookingSum * 0.95);
    }

    return res.json({
      success: true,
      wallet: {
        availableBalance:  liveAvailable,
        walletBalance:     liveAvailable,
        withdrawnBalance:  owner.withdrawnBalance || 0,
        bankDetails:       owner.bankDetails || {},
      },
      availableTransactions: availableTx,
      payoutHistory:         payoutLogs,
    });
  } catch (err) {
    console.error('[WalletCtrl] getOwnerWalletBalance error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/wallet/owner/withdraw-instant
 * Instant direct Cashfree Payout into Owner's registered Bank Account / UPI.
 */
exports.withdrawOwnerFundsInstant = async (req, res) => {
  try {
    const loginId = req.user?.loginId || req.body.loginId;
    const { amount, bankDetails } = req.body;

    if (!loginId) {
      return res.status(400).json({ success: false, message: 'loginId is required' });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please enter a valid withdrawal amount (> ₹0)' });
    }

    // Run auto-release check first
    // Held balance removed - funds go directly to wallet

    const owner = await Owner.findOne({
      $or: [{ loginId }, { _id: req.user?._id }]
    });

    if (!owner) {
      return res.status(404).json({ success: false, message: 'Owner account not found' });
    }

    const currentAvailable = owner.availableBalance || owner.walletBalance || 0;
    if (numAmount > currentAvailable && currentAvailable > 0) {
      return res.status(400).json({
        success: false,
        message: `Insufficient available balance. You have ₹${currentAvailable} available to withdraw.`
      });
    }

    const targetBank = bankDetails || owner.bankDetails || {};
    if (!targetBank.accountNumber && !targetBank.upiId) {
      return res.status(400).json({
        success: false,
        message: 'Please update your Bank Account Number or UPI ID in Bank Details to withdraw.'
      });
    }

    const transferId = `PO_OWNER_${Date.now()}_${Math.floor(Math.random()*1000)}`;

    // Create pending PayoutRequest
    const payoutDoc = await PayoutRequest.create({
      user_type: 'owner',
      login_id: loginId,
      user_name: owner.name || 'Property Owner',
      amount: numAmount,
      cf_transfer_id: transferId,
      bank_details: {
        accountNumber: targetBank.accountNumber || '',
        ifsc: targetBank.ifsc || '',
        bankName: targetBank.bankName || '',
        accountHolderName: targetBank.accountHolderName || owner.name || '',
        upiId: targetBank.upiId || ''
      },
      status: 'PROCESSING'
    });

    // Deduct owner available balance immediately to prevent double withdrawal
    owner.availableBalance = Math.max(0, (owner.availableBalance || 0) - numAmount);
    owner.walletBalance    = Math.max(0, (owner.walletBalance || 0) - numAmount);
    owner.withdrawnBalance = (owner.withdrawnBalance || 0) + numAmount;
    await owner.save();

    // Trigger Instant Cashfree Payout
    const payoutRes = await directBankTransfer({
      transferId,
      amount: numAmount,
      bankDetails: targetBank,
      remarks: `Roomhy Owner Payout ${loginId}`
    });

    if (payoutRes.success) {
      payoutDoc.status = 'SUCCESS';
      payoutDoc.cf_reference_id = payoutRes.referenceId;
      payoutDoc.completed_at = new Date();
      await payoutDoc.save();

      return res.json({
        success: true,
        message: `₹${numAmount} successfully transferred to your bank account!`,
        transferId: payoutRes.transferId,
        referenceId: payoutRes.referenceId,
        payout: payoutDoc
      });
    } else {
      // Revert owner balance if payout failed
      owner.availableBalance = (owner.availableBalance || 0) + numAmount;
      owner.walletBalance    = (owner.walletBalance || 0) + numAmount;
      owner.withdrawnBalance = Math.max(0, (owner.withdrawnBalance || 0) - numAmount);
      await owner.save();

      payoutDoc.status = 'FAILED';
      payoutDoc.failure_reason = payoutRes.error || 'Bank transfer failed';
      await payoutDoc.save();

      return res.status(502).json({
        success: false,
        message: payoutRes.error || 'Bank transfer failed. Amount remains in your available balance.'
      });
    }

  } catch (err) {
    console.error('[WalletCtrl] withdrawOwnerFundsInstant error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/wallet/admin/balance
 * Returns total platform commission collected, total admin withdrawn, and available admin earnings.
 */
exports.getAdminWalletBalance = async (req, res) => {
  try {
    const [transactions, bookingRequests, adminPayouts] = await Promise.all([
      PaymentTransaction.find().lean(),
      BookingRequest.find({
        $or: [
          { payment_status: 'completed' },
          { paymentStatus: 'PAID' },
          { booking_status: 'confirmed' },
          { status: 'completed' }
        ]
      }).lean(),
      PayoutRequest.find({ user_type: 'admin', status: 'SUCCESS' }).lean()
    ]);

    let totalRevenue = transactions.reduce((acc, t) => acc + (t.total_amount || t.booking_amount || 0), 0);
    let totalCommission = transactions.reduce((acc, t) => acc + (t.commission || Math.round((t.total_amount || t.booking_amount || 0) * 0.05)), 0);

    // Dynamic aggregation fallback if transactions array is small
    if (bookingRequests.length > 0) {
      const bRevenue = bookingRequests.reduce((acc, b) => acc + (b.total_amount || b.rent_amount || b.bid_amount || 2500), 0);
      const bCommission = Math.round(bRevenue * 0.05);
      if (bRevenue > totalRevenue) totalRevenue = bRevenue;
      if (bCommission > totalCommission) totalCommission = bCommission;
    }

    const totalOwnerHeld = transactions.filter(t => t.wallet_status === 'held').reduce((acc, t) => acc + (t.owner_amount || Math.round((t.total_amount || 0) * 0.95)), 0);
    const totalOwnerAvailable = transactions.filter(t => t.wallet_status === 'available').reduce((acc, t) => acc + (t.owner_amount || Math.round((t.total_amount || 0) * 0.95)), 0);
    
    const totalAdminWithdrawn = adminPayouts.reduce((acc, p) => acc + (p.amount || 0), 0);
    const availableAdminBalance = Math.max(0, totalCommission - totalAdminWithdrawn);

    const history = await PayoutRequest.find({ user_type: 'admin' }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      metrics: {
        totalRevenue,
        totalCommission,
        totalOwnerHeld,
        totalOwnerAvailable,
        totalAdminWithdrawn,
        availableAdminBalance
      },
      payoutHistory: history
    });
  } catch (err) {
    console.error('[WalletCtrl] getAdminWalletBalance error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/wallet/admin/withdraw-instant
 * Direct payout of Admin Platform Commission to Admin Cashfree registered Bank Account.
 */
exports.withdrawAdminEarningsInstant = async (req, res) => {
  try {
    const { amount, bankDetails } = req.body;
    const numAmount = parseFloat(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please enter a valid withdrawal amount' });
    }

    const balanceRes = await exports.getAdminWalletBalance(req, {
      json: (data) => data,
      status: () => ({ json: (data) => data })
    });

    const availableAdmin = balanceRes?.metrics?.availableAdminBalance || 0;
    if (numAmount > availableAdmin) {
      return res.status(400).json({
        success: false,
        message: `Insufficient admin earnings. You have ₹${availableAdmin} available to withdraw.`
      });
    }

    const transferId = `PO_ADMIN_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    const adminBank = bankDetails || {
      accountNumber: process.env.ADMIN_BANK_ACCOUNT || 'ADMIN_CASHFREE_MERCHANT_ACC',
      ifsc:          process.env.ADMIN_BANK_IFSC    || 'UTIB0000000',
      bankName:      'Registered Merchant Account',
      accountHolderName: 'Roomhy Technologies Private Limited'
    };

    const payoutDoc = await PayoutRequest.create({
      user_type: 'admin',
      login_id: req.user?.loginId || 'superadmin',
      user_name: 'Superadmin Platform Wallet',
      amount: numAmount,
      cf_transfer_id: transferId,
      bank_details: adminBank,
      status: 'PROCESSING'
    });

    const payoutRes = await directBankTransfer({
      transferId,
      amount: numAmount,
      bankDetails: adminBank,
      remarks: 'Roomhy Platform Commission Withdrawal'
    });

    if (payoutRes.success) {
      payoutDoc.status = 'SUCCESS';
      payoutDoc.cf_reference_id = payoutRes.referenceId;
      payoutDoc.completed_at = new Date();
      await payoutDoc.save();

      return res.json({
        success: true,
        message: `₹${numAmount} platform earnings transferred to Admin Bank Account!`,
        transferId: payoutRes.transferId,
        referenceId: payoutRes.referenceId,
        payout: payoutDoc
      });
    } else {
      payoutDoc.status = 'FAILED';
      payoutDoc.failure_reason = payoutRes.error || 'Transfer failed';
      await payoutDoc.save();

      return res.status(502).json({
        success: false,
        message: payoutRes.error || 'Bank transfer failed'
      });
    }
  } catch (err) {
    console.error('[WalletCtrl] withdrawAdminEarningsInstant error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
