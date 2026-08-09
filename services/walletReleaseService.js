const PaymentTransaction = require('../models/PaymentTransaction');
const Owner = require('../models/Owner');
const BookingRequest = require('../models/BookingRequest');
const Notification = require('../models/Notification');

/**
 * processHeldWalletReleases
 * Checks all 'held' transactions. If move_in_date + 24 hours has passed,
 * releases held funds directly into Owner's available balance ready for instant withdrawal.
 */
async function processHeldWalletReleases() {
  try {
    const now = new Date();
    const heldTransactions = await PaymentTransaction.find({
      status: 'Verified',
      wallet_status: 'held',
    });

    let releasedCount = 0;

    for (const tx of heldTransactions) {
      let releaseEligible = false;
      let moveInDate = null;

      // 1. Try to find Move-in Date from BookingRequest
      if (tx.booking_id) {
        const booking = await BookingRequest.findById(tx.booking_id).catch(() => null);
        if (booking) {
          moveInDate = booking.move_in_date || booking.checkinDate || booking.created_at;
        }
      }

      if (!moveInDate) {
        moveInDate = tx.held_at || tx.payment_date || tx.createdAt;
      }

      if (moveInDate) {
        const eligibleTime = new Date(moveInDate).getTime() + (24 * 60 * 60 * 1000); // Move-in date + 24 hours
        if (now.getTime() >= eligibleTime) {
          releaseEligible = true;
        }
      } else {
        releaseEligible = true; // Fallback immediate if no dates
      }

      if (releaseEligible) {
        // Shift wallet status to 'available'
        tx.wallet_status = 'available';
        tx.available_at = now;
        await tx.save();

        // Update Owner balances
        if (tx.owner_id && tx.owner_amount > 0) {
          const owner = await Owner.findOne({
            $or: [{ loginId: tx.owner_id }, { _id: tx.owner_id }]
          });

          if (owner) {
            const transferAmount = Number(tx.owner_amount || 0);
            owner.heldBalance = Math.max(0, (owner.heldBalance || 0) - transferAmount);
            owner.availableBalance = (owner.availableBalance || 0) + transferAmount;
            owner.walletBalance = (owner.walletBalance || 0) + transferAmount;
            await owner.save();

            // Notify Owner
            try {
              await Notification.create({
                toRole:    'owner',
                toLoginId: String(owner.loginId || tx.owner_id),
                from:      'system',
                type:      'wallet_released',
                title:     '💰 Funds Released to Wallet',
                message:   `₹${transferAmount} for property "${tx.property_name || 'Roomhy'}" is now available for instant bank withdrawal!`,
                meta:      { amount: transferAmount, bookingId: tx.booking_id }
              });
            } catch (_) {}
          }
        }

        releasedCount++;
      }
    }

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
