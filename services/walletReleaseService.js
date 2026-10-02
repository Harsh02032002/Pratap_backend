const PaymentTransaction = require('../models/PaymentTransaction');
const Owner = require('../models/Owner');
const BookingRequest = require('../models/BookingRequest');
const Notification = require('../models/Notification');
const mongoose = require('mongoose');

/**
 * processHeldWalletReleases
 * Checks all 'held' transactions. If move_in_date + 24 hours has passed,
 * releases held funds directly into Owner's available balance ready for instant withdrawal.
 *
 * Batched: one BookingRequest lookup and one Owner lookup for the whole run
 * instead of one each per transaction, and the wallet_status/Owner balance
 * updates go through bulkWrite instead of a per-transaction .save().
 */
async function processHeldWalletReleases() {
  try {
    const now = new Date();
    const heldTransactions = await PaymentTransaction.find({
      status: 'Verified',
      wallet_status: 'held',
    }).select('booking_id held_at payment_date createdAt owner_id owner_amount property_name');

    if (heldTransactions.length === 0) {
      return { success: true, releasedCount: 0 };
    }

    const bookingIds = [...new Set(heldTransactions.map((tx) => tx.booking_id).filter(Boolean))];
    const bookings = bookingIds.length
      ? await BookingRequest.find({ _id: { $in: bookingIds } }).select('move_in_date checkinDate created_at').lean()
      : [];
    const bookingById = new Map(bookings.map((b) => [String(b._id), b]));

    const eligible = [];
    for (const tx of heldTransactions) {
      let moveInDate = null;
      const booking = tx.booking_id ? bookingById.get(String(tx.booking_id)) : null;
      if (booking) {
        moveInDate = booking.move_in_date || booking.checkinDate || booking.created_at;
      }
      if (!moveInDate) {
        moveInDate = tx.held_at || tx.payment_date || tx.createdAt;
      }

      let releaseEligible;
      if (moveInDate) {
        const eligibleTime = new Date(moveInDate).getTime() + (24 * 60 * 60 * 1000); // Move-in date + 24 hours
        releaseEligible = now.getTime() >= eligibleTime;
      } else {
        releaseEligible = true; // Fallback immediate if no dates
      }

      if (releaseEligible) eligible.push(tx);
    }

    if (eligible.length === 0) {
      return { success: true, releasedCount: 0 };
    }

    // Resolve every distinct owner referenced by an eligible transaction in one query.
    const ownerIdStrings = [...new Set(eligible.map((tx) => String(tx.owner_id || '')).filter(Boolean))];
    const objIdCandidates = ownerIdStrings.filter((id) => mongoose.Types.ObjectId.isValid(id) && id.match(/^[0-9a-fA-F]{24}$/));
    const owners = ownerIdStrings.length
      ? await Owner.find({
          $or: [
            { loginId: { $in: ownerIdStrings.map((id) => id.toUpperCase()) } },
            ...(objIdCandidates.length ? [{ _id: { $in: objIdCandidates } }] : []),
          ],
        })
      : [];
    const ownerByRef = new Map();
    for (const owner of owners) {
      ownerByRef.set(String(owner.loginId || '').toUpperCase(), owner);
      ownerByRef.set(String(owner._id), owner);
    }

    // Accumulate each owner's total release amount across all their eligible
    // transactions in this run before writing — several transactions can
    // belong to the same owner in one pass.
    const ownerTransferTotals = new Map(); // ownerDoc -> accumulated amount
    const txBulkOps = [];
    const notifications = [];

    for (const tx of eligible) {
      txBulkOps.push({
        updateOne: {
          filter: { _id: tx._id },
          update: { $set: { wallet_status: 'available', available_at: now } },
        },
      });

      if (tx.owner_id && tx.owner_amount > 0) {
        const owner = ownerByRef.get(String(tx.owner_id).toUpperCase()) || ownerByRef.get(String(tx.owner_id));
        if (owner) {
          const transferAmount = Number(tx.owner_amount || 0);
          ownerTransferTotals.set(owner, (ownerTransferTotals.get(owner) || 0) + transferAmount);
          notifications.push({
            toRole: 'owner',
            toLoginId: String(owner.loginId || tx.owner_id),
            from: 'system',
            type: 'wallet_released',
            title: '💰 Funds Released to Wallet',
            message: `₹${transferAmount} for property "${tx.property_name || 'Roomhy'}" is now available for instant bank withdrawal!`,
            meta: { amount: transferAmount, bookingId: tx.booking_id },
          });
        }
      }
    }

    if (txBulkOps.length) {
      await PaymentTransaction.bulkWrite(txBulkOps, { ordered: false });
    }

    if (ownerTransferTotals.size) {
      const ownerBulkOps = [];
      for (const [owner, transferAmount] of ownerTransferTotals.entries()) {
        const newHeld = Math.max(0, (owner.heldBalance || 0) - transferAmount);
        const newAvailable = (owner.availableBalance || 0) + transferAmount;
        const newWallet = (owner.walletBalance || 0) + transferAmount;
        ownerBulkOps.push({
          updateOne: {
            filter: { _id: owner._id },
            update: { $set: { heldBalance: newHeld, availableBalance: newAvailable, walletBalance: newWallet } },
          },
        });
      }
      await Owner.bulkWrite(ownerBulkOps, { ordered: false });
    }

    if (notifications.length) {
      await Notification.insertMany(notifications, { ordered: false }).catch(() => {});
    }

    const releasedCount = eligible.length;
    if (releasedCount > 0) {
      console.log(`[WalletReleaseService] ✅ Released ${releasedCount} held transactions to Available Balance.`);
    }

    return { success: true, releasedCount };
  } catch (err) {
    console.error('[WalletReleaseService] ❌ Error processing held releases:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  processHeldWalletReleases,
};
