'use strict';

/**
 * cashfreePayoutController.js
 * ────────────────────────────
 * Handles all Cashfree Payout API endpoints.
 *
 * Routes:
 *   POST /api/payouts/cashfree/beneficiary
 *   POST /api/payouts/cashfree/withdraw
 *   POST /api/payouts/cashfree/webhook        ← raw body
 *   GET  /api/payouts/cashfree/status/:transferId
 */

const Owner              = require('../models/Owner');
const PaymentTransaction = require('../models/PaymentTransaction');
const PayoutLog          = require('../models/PayoutLog');
const Notification       = require('../models/Notification');
const cfPayout = require('../services/cashfreePayoutService');

// ─── ADD / UPDATE BENEFICIARY ─────────────────────────────────────────────────

/**
 * POST /api/payouts/cashfree/beneficiary
 * Body: { ownerId (loginId), accountHolderName, accountNumber, ifsc, bankName, upiId }
 * Auth: owner or superadmin
 */
exports.addBeneficiary = async (req, res) => {
  try {
    const { ownerId, accountHolderName, accountNumber, ifsc, bankName, upiId } = req.body;
    const user = req.user;

    // Resolve which owner to update
    const targetLoginId = ownerId || (user?.role === 'owner' ? user.loginId : null);
    if (!targetLoginId) {
      return res.status(400).json({ success: false, message: 'ownerId is required' });
    }

    // Only owner for themselves, or superadmin for any owner
    if (user?.role === 'owner' && user.loginId !== targetLoginId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const owner = await Owner.findOne({ loginId: targetLoginId });
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

    // Validate: need either bank details or UPI
    const hasBank = !!(accountNumber && ifsc);
    const hasUpi  = !!(upiId && upiId.includes('@'));

    if (!hasBank && !hasUpi) {
      return res.status(400).json({
        success: false,
        message: 'Provide either accountNumber + ifsc (bank) or a valid UPI ID'
      });
    }

    // Save bank details to owner doc
    owner.bankDetails = {
      accountHolderName: accountHolderName || owner.bankDetails?.accountHolderName,
      accountNumber:     accountNumber     || owner.bankDetails?.accountNumber,
      ifsc:              ifsc              || owner.bankDetails?.ifsc,
      bankName:          bankName          || owner.bankDetails?.bankName,
      upiId:             upiId            || owner.bankDetails?.upiId,
      isVerified:        false,
      cf_beneficiary_id: owner.bankDetails?.cf_beneficiary_id,
    };

    // Register with Cashfree
    const beneId = `ROOMHY_${targetLoginId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const result = await cfPayout.addBeneficiary(owner, beneId);

    if (result.success) {
      owner.bankDetails.isVerified        = true;
      owner.bankDetails.verifiedAt        = new Date();
      owner.bankDetails.cf_beneficiary_id = beneId;
    }

    await owner.save();

    return res.json({
      success:       result.success,
      beneficiary_id: beneId,
      isVerified:    owner.bankDetails.isVerified,
      message:       result.success ? 'Bank account registered successfully' : result.error,
    });

  } catch (err) {
    console.error('[CashfreePayoutCtrl] addBeneficiary error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── WITHDRAW (Owner initiates withdrawal) ─────────────────────────────────────

/**
 * POST /api/payouts/cashfree/withdraw
 * Body: { amount } — must be ≤ availableBalance
 * Auth: owner
 *
 * Owner can ONLY withdraw AVAILABLE balance (not held balance).
 */
exports.initiateWithdraw = async (req, res) => {
  try {
    const user = req.user;

    if (!user || user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can withdraw' });
    }

    const owner = await Owner.findOne({ loginId: user.loginId });
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

    // Validate bank details registered
    if (!owner.bankDetails?.cf_beneficiary_id) {
      return res.status(400).json({
        success: false,
        message: 'Please add your bank account details before withdrawing'
      });
    }

    const available = owner.availableBalance || 0;
    let withdrawAmount = parseFloat(req.body.amount) || available;

    if (withdrawAmount <= 0) {
      return res.status(400).json({ success: false, message: 'No available balance to withdraw' });
    }

    if (withdrawAmount > available) {
      return res.status(400).json({
        success: false,
        message: `Requested ₹${withdrawAmount} exceeds available balance ₹${available}`
      });
    }

    if (!process.env.PAYOUT_ENABLED || process.env.PAYOUT_ENABLED !== 'true') {
      return res.status(400).json({
        success: false,
        message: 'Payouts are currently disabled. Please contact support.'
      });
    }

    // Find the available transactions to associate with this payout
    const availableTxns = await PaymentTransaction.find({
      owner_id:      user.loginId,
      wallet_status: 'available',
    }).sort({ available_at: 1 }).lean();

    if (!availableTxns.length) {
      return res.status(400).json({
        success: false,
        message: 'No available transactions to withdraw'
      });
    }

    // Use the first available transaction as the "primary" payout anchor
    const primaryTx = availableTxns[0];

    // Initiate payout
    const beneId    = owner.bankDetails.cf_beneficiary_id;
    const transferId = `WD_${user.loginId}_${Date.now()}`;

    const result = await cfPayout.initiateTransfer({
      beneId,
      amount:     withdrawAmount,
      transferId,
      remarks:    `Roomhy Withdrawal - ${user.loginId}`,
    });

    if (!result.success) {
      return res.status(502).json({ success: false, message: result.error });
    }

    // Update balances
    owner.availableBalance  = parseFloat((available - withdrawAmount).toFixed(2));
    owner.withdrawnBalance  = parseFloat(((owner.withdrawnBalance || 0) + withdrawAmount).toFixed(2));
    owner.walletBalance     = owner.availableBalance; // keep in sync
    await owner.save();

    // Mark transactions as withdrawn
    let remaining = withdrawAmount;
    for (const tx of availableTxns) {
      if (remaining <= 0) break;
      await PaymentTransaction.findByIdAndUpdate(tx._id, {
        $set: {
          wallet_status:    'withdrawn',
          withdrawn_at:     new Date(),
          payout_status:    'Processing',
          payout_reference: result.cf_transfer_id,
          payout_date:      new Date(),
        }
      });
      remaining -= tx.owner_amount;
    }

    // Log payout
    await PayoutLog.create({
      transaction_id:    primaryTx._id,
      owner_id:          user.loginId,
      owner_name:        owner.name || '',
      amount:            withdrawAmount,
      mode:              owner.bankDetails.upiId ? 'upi' : 'bank',
      cf_beneficiary_id: beneId,
      cf_transfer_id:    result.cf_transfer_id,
      cf_reference_id:   transferId,
      status:            'queued',
      account_holder:    owner.bankDetails.accountHolderName,
      account_number:    owner.bankDetails.accountNumber,
      ifsc_code:         owner.bankDetails.ifsc,
      bank_name:         owner.bankDetails.bankName,
      upi_id:            owner.bankDetails.upiId,
      cf_transfer_request: { beneId, amount: withdrawAmount, transferId },
      cf_transfer_response: result,
      initiated_by:      'owner',
    });

    // Notify
    try {
      await Notification.create({
        toRole:    'owner',
        toLoginId: user.loginId,
        from:      'system',
        type:      'payout_initiated',
        title:     '💸 Withdrawal Initiated',
        message:   `Your withdrawal of ₹${withdrawAmount} has been initiated. It will be credited to your bank account in 1-3 business days.`,
        meta:      { amount: withdrawAmount, transferId }
      });
    } catch (_) {}

    return res.json({
      success:          true,
      cf_transfer_id:   result.cf_transfer_id,
      transfer_id:      transferId,
      amount:           withdrawAmount,
      new_available_balance: owner.availableBalance,
      new_withdrawn_balance: owner.withdrawnBalance,
    });

  } catch (err) {
    console.error('[CashfreePayoutCtrl] initiateWithdraw error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PAYOUT WEBHOOK ───────────────────────────────────────────────────────────

/**
 * POST /api/payouts/cashfree/webhook
 * Cashfree fires this when a transfer status changes.
 */
exports.handlePayoutWebhook = async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const sig     = req.headers['x-webhook-signature'] || '';
    const ts      = req.headers['x-webhook-timestamp'] || '';

    const valid = cfPayout.verifyPayoutWebhookSignature(rawBody, sig, ts);
    if (!valid) {
      console.warn('[CashfreePayoutCtrl] ❌ Invalid payout webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const event     = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const eventType = event.event || '';
    const data      = event.data || {};

    console.log(`[CashfreePayoutCtrl] Payout webhook: ${eventType}`);

    const transferId  = data.transfer?.transferId || data.transferId;
    const cfTransferId = data.transfer?.referenceId || data.referenceId;
    const newStatus   = data.transfer?.transferStatus || data.status || '';
    const utr         = data.transfer?.utr || data.utr;

    if (!transferId) {
      return res.status(200).json({ success: true, message: 'No transferId — ignored' });
    }

    // Map Cashfree payout status to our enum
    let ourStatus = 'processing';
    if (newStatus === 'SUCCESS')  ourStatus = 'processed';
    if (newStatus === 'FAILED')   ourStatus = 'failed';
    if (newStatus === 'REVERSED') ourStatus = 'reversed';

    // Update PayoutLog
    await PayoutLog.findOneAndUpdate(
      { cf_reference_id: transferId },
      { $set: { status: ourStatus, cf_transfer_id: cfTransferId || cfTransferId } }
    );

    // Update PaymentTransaction payout_status
    const txUpdate = { payout_status: ourStatus === 'processed' ? 'Paid' : ourStatus === 'failed' ? 'Failed' : 'Processing' };
    if (utr) txUpdate.payout_reference = utr;
    await PaymentTransaction.updateMany(
      { payout_reference: cfTransferId || transferId },
      { $set: txUpdate }
    );

    // Notify owner of success/failure
    if (ourStatus === 'processed' || ourStatus === 'failed') {
      const log = await PayoutLog.findOne({ cf_reference_id: transferId }).lean();
      if (log?.owner_id) {
        await Notification.create({
          toRole:    'owner',
          toLoginId: log.owner_id,
          from:      'system',
          type:      ourStatus === 'processed' ? 'payout_success' : 'payout_failed',
          title:     ourStatus === 'processed' ? '✅ Payout Successful' : '❌ Payout Failed',
          message:   ourStatus === 'processed'
            ? `Your withdrawal of ₹${log.amount} has been credited to your bank account${utr ? ` (UTR: ${utr})` : ''}.`
            : `Your withdrawal of ₹${log.amount} failed. Please contact support.`,
          meta: { amount: log.amount, utr, transferId }
        }).catch(() => {});
      }
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[CashfreePayoutCtrl] payout webhook error:', err);
    return res.status(200).json({ success: false, message: err.message });
  }
};

// ─── GET PAYOUT STATUS ────────────────────────────────────────────────────────

/**
 * GET /api/payouts/cashfree/status/:transferId
 * Auth: superadmin or owner (own transfers only)
 */
exports.getPayoutStatus = async (req, res) => {
  try {
    const { transferId } = req.params;

    const [log, cfStatus] = await Promise.all([
      PayoutLog.findOne({ $or: [{ cf_reference_id: transferId }, { cf_transfer_id: transferId }] }).lean(),
      cfPayout.getTransferStatus(transferId),
    ]);

    return res.json({
      success:   true,
      db_status: log?.status,
      cf_status: cfStatus.status,
      utr:       cfStatus.utr,
      log,
      cashfree:  cfStatus.data,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── WALLET SUMMARY ───────────────────────────────────────────────────────────

/**
 * GET /api/payouts/cashfree/wallet
 * Auth: owner
 * Returns owner's wallet breakdown.
 */
exports.getWalletSummary = async (req, res) => {
  try {
    const user = req.user;
    if (!user || user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can view wallet' });
    }

    const owner = await Owner.findOne({ loginId: user.loginId }).lean();
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

    // Get per-booking wallet entries
    const ledger = await PaymentTransaction.find({ owner_id: user.loginId })
      .sort({ payment_date: -1 })
      .lean();

    const held      = ledger.filter(t => t.wallet_status === 'held');
    const available = ledger.filter(t => t.wallet_status === 'available');
    const withdrawn = ledger.filter(t => t.wallet_status === 'withdrawn');

    return res.json({
      success: true,
      wallet: {
        heldBalance:      owner.heldBalance      || 0,
        availableBalance: owner.availableBalance || 0,
        withdrawnBalance: owner.withdrawnBalance  || 0,
        bankDetails: owner.bankDetails ? {
          accountHolderName: owner.bankDetails.accountHolderName,
          maskedAccountNumber: owner.bankDetails.accountNumber
            ? `XXXX${String(owner.bankDetails.accountNumber).slice(-4)}` : null,
          ifsc:       owner.bankDetails.ifsc,
          bankName:   owner.bankDetails.bankName,
          upiId:      owner.bankDetails.upiId,
          isVerified: owner.bankDetails.isVerified,
        } : null,
      },
      ledger: {
        held:      held.map(t => ({ id: t._id, bookingId: t.booking_id, amount: t.owner_amount, heldAt: t.held_at, moveInDate: t.move_in_date })),
        available: available.map(t => ({ id: t._id, bookingId: t.booking_id, amount: t.owner_amount, availableAt: t.available_at })),
        withdrawn: withdrawn.map(t => ({ id: t._id, bookingId: t.booking_id, amount: t.owner_amount, withdrawnAt: t.withdrawn_at, ref: t.payout_reference })),
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Aliases for route handlers
exports.withdraw = exports.initiateWithdraw;
exports.initiatePayout = exports.initiateWithdraw;
exports.getTransferStatus = exports.getPayoutStatus;

