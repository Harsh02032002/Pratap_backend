const Owner = require('../models/Owner');
const BookingRequest = require('../models/BookingRequest');
const PaymentTransaction = require('../models/PaymentTransaction');
const PayoutRequest = require('../models/PayoutRequest');
const { sumRentPayments, sumField, getAdminTransactionTotals } = require('../services/paymentTotalsService');

/**
 * GET /api/wallet/owner/balance
 * Returns live held, available, and withdrawn balances for Owner.
 */
exports.getOwnerWalletBalance = async (req, res) => {
  try {
    // IDENTITY COMES FROM THE SESSION, NEVER THE QUERY STRING.
    // This used to fall back to req.query.ownerLoginId / req.query.loginId, so
    // with the route unauthenticated anyone could read any owner's wallet by
    // passing their loginId — and even once authenticated, an owner could read
    // another owner's balance the same way.
    const loginId = req.user?.loginId;
    if (!loginId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // First auto-release any eligible held funds (move-in date + 24 hours)
    // Held balance removed - funds go directly to wallet

    const Rent = require('../models/Rent');
    const RentPayment = require('../models/RentPayment');

    // Was `$or: [{ loginId }, { _id: req.user?._id }]`: the first clause matched
    // on a caller-supplied loginId, which is an ownership bypass. Scope strictly
    // to the authenticated account.
    const owner = await Owner.findOne({ _id: req.user._id }).lean();

    if (!owner) {
      return res.status(404).json({ success: false, message: 'Owner account not found' });
    }

    // Transaction + payout documents are returned to the client below, so they
    // are still fetched. The two rent totals are summed by MongoDB.
    const [availableTx, payoutLogs, ownerBookings, rentPaymentSum, rentSum] = await Promise.all([
      PaymentTransaction.find({ $or: [{ owner_id: loginId }, { owner_login_id: loginId }], wallet_status: 'available' }).sort({ createdAt: -1 }).lean(),
      PayoutRequest.find({ login_id: loginId, user_type: 'owner' }).sort({ createdAt: -1 }).lean(),
      BookingRequest.find({
        $or: [{ owner_id: loginId }, { ownerLoginId: loginId }],
        paymentStatus: { $in: ['PAID', 'completed'] }
      }).lean(),
      // 💰 Manual/cash rent payments recorded by admin. Only the totals are
      // used below, so MongoDB sums them — the documents are never returned.
      // (RentPayment is keyed by ObjectId, Rent by loginId.)
      sumRentPayments({ ownerId: owner._id }).catch(() => 0),
      sumField(Rent, { ownerLoginId: loginId, ownerPayoutStatus: 'paid' }, 'paidAmount').catch(() => 0),
    ]);

    let liveAvailable = owner.availableBalance || owner.walletBalance || 0;

    const calcAvail = availableTx.reduce((s, t) => s + (t.owner_amount || Math.round((t.total_amount || 0) * 0.95)), 0);

    if (calcAvail > 0) liveAvailable = Math.max(liveAvailable, calcAvail);

    // 💰 Add manual RentPayments (admin recorded cash/bank transfers)
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
      // Same `|| 2500` falsy-chain caveat as above — kept in JS for exactness.
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
    // IDENTITY FROM THE SESSION ONLY. This previously read
    // `req.user?.loginId || req.body.loginId` on an UNAUTHENTICATED route, so a
    // request body alone chose whose funds to withdraw.
    const loginId = req.user?.loginId;
    if (!loginId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const { amount } = req.body;

    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please enter a valid withdrawal amount (> ₹0)' });
    }

    // Scoped to the authenticated account; the old $or let a caller-supplied
    // loginId select a different owner.
    const owner = await Owner.findOne({ _id: req.user._id });

    if (!owner) {
      return res.status(404).json({ success: false, message: 'Owner account not found' });
    }

    const currentAvailable = owner.availableBalance || owner.walletBalance || 0;
    // The old condition was `numAmount > currentAvailable && currentAvailable > 0`,
    // which SKIPPED THE LIMIT ENTIRELY when the balance was 0 — any amount could
    // be withdrawn from an empty wallet.
    if (numAmount > currentAvailable) {
      return res.status(400).json({
        success: false,
        message: `Insufficient available balance. You have ₹${currentAvailable} available to withdraw.`
      });
    }

    // PAYOUT DESTINATION IS NOT CALLER-SUPPLIED. req.body.bankDetails used to be
    // accepted here, so a withdrawal could be redirected to an arbitrary account.
    // Only the owner's saved bank details are used, which is what the error
    // message below already assumed.
    const targetBank = owner.bankDetails || {};
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

    // Deduct immediately to prevent double withdrawal. This was a
    // read-modify-write via owner.save(), so two withdrawals submitted at the
    // same time both read the same starting balance and both succeeded. The
    // condition is evaluated by MongoDB as part of the update, so exactly one of
    // two concurrent withdrawals can win.
    if (owner.availableBalance === undefined || owner.availableBalance === null) {
      // Older owner documents only carry walletBalance; normalise once so the
      // conditional guard below has a field to compare against.
      await Owner.updateOne({ _id: owner._id }, { $set: { availableBalance: currentAvailable } });
    }

    const debited = await Owner.findOneAndUpdate(
      { _id: owner._id, availableBalance: { $gte: numAmount } },
      {
        $inc: {
          availableBalance: -numAmount,
          walletBalance: -numAmount,
          withdrawnBalance: numAmount
        }
      },
      { new: true }
    );

    if (!debited) {
      payoutDoc.status = 'FAILED';
      payoutDoc.failure_reason = 'Balance changed before the debit could be applied';
      await payoutDoc.save();
      return res.status(409).json({
        success: false,
        message: 'Your balance changed while this withdrawal was being processed. Please check your balance and try again.'
      });
    }

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

      // Dispatch FCM Push Notification to Owner
      try {
        const fcmService = require('../services/fcmService');
        fcmService.sendToUser(loginId, {
          title: '💸 Payout Credited!',
          body: `₹${numAmount} rent payout has been credited to your bank account.`,
          data: { type: 'payout_success', amount: String(numAmount) }
        }).catch(() => {});
      } catch (_) {}

      return res.json({
        success: true,
        message: `₹${numAmount} successfully transferred to your bank account!`,
        transferId: payoutRes.transferId,
        referenceId: payoutRes.referenceId,
        payout: payoutDoc
      });
    } else {
      // Revert with the exact inverse $inc, not a re-save of a now-stale
      // in-memory document (which would clobber any concurrent balance change).
      await Owner.updateOne({ _id: owner._id }, {
        $inc: {
          availableBalance: numAmount,
          walletBalance: numAmount,
          withdrawnBalance: -numAmount
        }
      });

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
 * Shared by GET /api/wallet/admin/balance and the instant-withdraw endpoint,
 * so there is exactly one implementation of "what is the admin's available
 * balance" — previously withdrawAdminEarningsInstant called the route handler
 * below through a fake req/res shim just to read one field back out of it.
 */
async function computeAdminBalanceMetrics() {
  const [txTotals, bookingRequests, adminWithdrawnTotal] = await Promise.all([
    // One $group replaces loading every PaymentTransaction into memory and
    // running four separate reduce() passes over the array.
    getAdminTransactionTotals(),
    BookingRequest.find({
      $or: [
        { payment_status: 'completed' },
        { paymentStatus: 'PAID' },
        { booking_status: 'confirmed' },
        { status: 'completed' }
      ]
    }).lean(),
    sumField(PayoutRequest, { user_type: 'admin', status: 'SUCCESS' }, 'amount')
  ]);

  let totalRevenue = txTotals.totalRevenue;
  let totalCommission = txTotals.totalCommission;

  // Fallback when PaymentTransaction rows are sparse: derive revenue from
  // booking requests instead. Deliberately still summed in JS — the
  // `|| 2500` chain treats 0 as absent, which $ifNull does not, so an
  // aggregation would not be exactly equivalent. This branch only runs when
  // it beats the transaction total, and BookingRequest volume is far smaller.
  if (bookingRequests.length > 0) {
    const bRevenue = bookingRequests.reduce((acc, b) => acc + (b.total_amount || b.rent_amount || b.bid_amount || 2500), 0);
    const bCommission = Math.round(bRevenue * 0.05);
    if (bRevenue > totalRevenue) totalRevenue = bRevenue;
    if (bCommission > totalCommission) totalCommission = bCommission;
  }

  const totalOwnerHeld = txTotals.totalOwnerHeld;
  const totalOwnerAvailable = txTotals.totalOwnerAvailable;

  const totalAdminWithdrawn = adminWithdrawnTotal;
  const availableAdminBalance = Math.max(0, totalCommission - totalAdminWithdrawn);

  return { totalRevenue, totalCommission, totalOwnerHeld, totalOwnerAvailable, totalAdminWithdrawn, availableAdminBalance };
}

/**
 * GET /api/wallet/admin/balance
 * Returns total platform commission collected, total admin withdrawn, and available admin earnings.
 */
exports.getAdminWalletBalance = async (req, res) => {
  try {
    const metrics = await computeAdminBalanceMetrics();
    const history = await PayoutRequest.find({ user_type: 'admin' }).sort({ createdAt: -1 }).lean();

    return res.json({
      success: true,
      metrics,
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
    // bankDetails is deliberately NOT read from the body any more: it used to
    // override the configured platform account, which turned this into a
    // payout-redirect primitive. The destination is now always the configured
    // merchant account.
    const { amount } = req.body;
    const numAmount = parseFloat(amount);

    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Please enter a valid withdrawal amount' });
    }

    // Was: re-running the whole getAdminWalletBalance route handler through a
    // fake req/res shim just to read one field back — which also redid a
    // PayoutRequest history fetch this withdrawal never needed. Call the
    // shared computation directly (same booking-fallback logic included, so
    // this stays exactly the same number getAdminWalletBalance would show).
    const { availableAdminBalance: availableAdmin } = await computeAdminBalanceMetrics();
    if (numAmount > availableAdmin) {
      return res.status(400).json({
        success: false,
        message: `Insufficient admin earnings. You have ₹${availableAdmin} available to withdraw.`
      });
    }

    const transferId = `PO_ADMIN_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    const adminBank = {
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
