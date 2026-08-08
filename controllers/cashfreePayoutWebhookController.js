const Owner = require('../models/Owner');
const PaymentTransaction = require('../models/PaymentTransaction');

/**
 * Cashfree Payout Webhook Controller
 * POST /api/payouts/cashfree/webhook
 */
exports.handlePayoutWebhook = async (req, res) => {
  console.log('🔔 [Cashfree Payout Webhook Received]', JSON.stringify(req.body || {}).slice(0, 300));

  try {
    const payload = req.body || {};
    const eventType = payload.type || payload.event || (payload.data?.transfer?.status === 'SUCCESS' ? 'TRANSFER_SUCCESS' : 'UNKNOWN');

    console.log(`[Cashfree Payout Webhook Event]: ${eventType}`);

    const data = payload.data || {};
    const transfer = data.transfer || payload.transfer || {};
    const beneDetails = data.beneficiary_details || payload.beneficiary_details || {};

    const transferId = transfer.transfer_id || payload.transfer_id || '';
    const cfTransferId = String(transfer.cf_transfer_id || payload.cf_transfer_id || '');
    const amount = parseFloat(transfer.amount || payload.amount || 0);
    const utr = transfer.utr || payload.utr || '';
    const beneId = beneDetails.bene_id || transfer.bene_id || payload.bene_id || '';

    switch (eventType) {
      case 'TRANSFER_SUCCESS': {
        console.log(`✅ [Cashfree Payout Webhook] Transfer Successful! TransferID: ${transferId}, UTR: ${utr}, Amount: ₹${amount}`);

        // Find owner by beneficiary ID or transfer log
        let owner = null;
        if (beneId) {
          owner = await Owner.findOne({
            $or: [
              { 'bankDetails.cf_beneficiary_id': beneId },
              { loginId: beneId.replace(/^BENE_/, '') }
            ]
          });
        }

        if (owner) {
          // Move amount from Available to Withdrawn
          const prevAvail = owner.availableBalance || owner.walletBalance || 0;
          const newAvail = Math.max(0, prevAvail - amount);
          const newWithdrawn = (owner.withdrawnBalance || 0) + amount;

          owner.availableBalance = newAvail;
          owner.walletBalance = newAvail;
          owner.withdrawnBalance = newWithdrawn;
          await owner.save();

          console.log(`💸 [Cashfree Payout Webhook] Updated Owner ${owner.loginId}: Available = ₹${newAvail}, Withdrawn = ₹${newWithdrawn}`);

          // Update PaymentTransaction / Ledger
          if (transferId) {
            await PaymentTransaction.updateOne(
              { $or: [{ cf_transfer_id: transferId }, { transaction_id: transferId }] },
              {
                $set: {
                  wallet_status: 'withdrawn',
                  cf_transfer_id: cfTransferId || transferId,
                  utr: utr,
                  processed_at: new Date(),
                  notes: `Payout transferred successfully. UTR: ${utr}`
                }
              }
            ).catch(() => {});
          }
        }
        break;
      }

      case 'TRANSFER_FAILED':
      case 'TRANSFER_REVERSED': {
        console.warn(`⚠️ [Cashfree Payout Webhook] Transfer ${eventType} for TransferID: ${transferId}`);

        let owner = null;
        if (beneId) {
          owner = await Owner.findOne({
            $or: [
              { 'bankDetails.cf_beneficiary_id': beneId },
              { loginId: beneId.replace(/^BENE_/, '') }
            ]
          });
        }

        if (owner && amount > 0) {
          // Revert amount back to Available balance
          owner.availableBalance = (owner.availableBalance || 0) + amount;
          owner.walletBalance = owner.availableBalance;
          await owner.save();

          console.log(`↩️ [Cashfree Payout Webhook] Reverted ₹${amount} back to Owner ${owner.loginId} Available balance.`);
        }

        if (transferId) {
          await PaymentTransaction.updateOne(
            { $or: [{ cf_transfer_id: transferId }, { transaction_id: transferId }] },
            {
              $set: {
                wallet_status: 'failed',
                notes: `Payout ${eventType.toLowerCase()}. Reason: ${transfer.status_description || 'Transfer failed'}`
              }
            }
          ).catch(() => {});
        }
        break;
      }

      case 'BENEFICIARY_STATUS': {
        console.log(`ℹ️ [Cashfree Payout Webhook] Beneficiary status event for BeneID: ${beneId}`);
        if (beneId) {
          await Owner.updateOne(
            { $or: [{ 'bankDetails.cf_beneficiary_id': beneId }, { loginId: beneId.replace(/^BENE_/, '') }] },
            { $set: { 'bankDetails.isVerified': true } }
          ).catch(() => {});
        }
        break;
      }

      default:
        console.log(`ℹ️ [Cashfree Payout Webhook] Unhandled payout event type: ${eventType}`);
        break;
    }

    // Return HTTP 200 immediately
    return res.status(200).json({ success: true, message: 'Payout webhook processed successfully' });
  } catch (err) {
    console.error('❌ [Cashfree Payout Webhook Error]', err);
    return res.status(200).json({ success: false, message: 'Error processing payout webhook: ' + err.message });
  }
};
