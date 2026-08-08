'use strict';

/**
 * cashfreePayoutService.js
 * ────────────────────────
 * Cashfree Payouts integration.
 * Uses Cashfree Payout API v2024-01-01 via axios.
 *
 * SAFETY GUARANTEES:
 * 1. Never throws to caller — always returns { success, ... }
 * 2. Never modifies DB directly — that's the controller's job
 * 3. All secrets from env vars only
 *
 * Required ENV:
 *   CASHFREE_ENV                  = TEST | PROD
 *   CASHFREE_PAYOUT_CLIENT_ID     = Payout Client ID
 *   CASHFREE_PAYOUT_CLIENT_SECRET = Payout Client Secret
 *   CASHFREE_PAYOUT_WEBHOOK_SECRET= Payout webhook signature secret
 *
 * Payout flow:
 *   1. Get OAuth token → /payout/v1/authorize
 *   2. Add beneficiary → /payout/v1/addBeneficiary
 *   3. Transfer → /payout/v1/directTransfer
 *   4. Check status → /payout/v1/getTransferStatus
 */

const axios = require('axios');
const crypto = require('crypto');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

function getConfig() {
  const env = (process.env.CASHFREE_ENV || 'TEST').toUpperCase();
  const isSandbox = env !== 'PROD';
  return {
    isSandbox,
    clientId:      process.env.CASHFREE_PAYOUT_CLIENT_ID || '',
    clientSecret:  process.env.CASHFREE_PAYOUT_CLIENT_SECRET || '',
    webhookSecret: process.env.CASHFREE_PAYOUT_WEBHOOK_SECRET || '',
    baseUrl: isSandbox
      ? 'https://payout-gamma.cashfree.com'
      : 'https://payout-api.cashfree.com',
    apiVersion: '2024-01-01',
  };
}

// ─── OAUTH TOKEN (Payout uses Basic Auth, not same as PG) ─────────────────────

let _tokenCache = null; // { token, expiresAt }

async function getPayoutToken(config) {
  // Return cached token if still valid (with 60s buffer)
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60000) {
    return { success: true, token: _tokenCache.token };
  }

  try {
    const { data } = await axios.post(
      `${config.baseUrl}/payout/v1/authorize`,
      {},
      {
        headers: {
          'X-Client-Id':     config.clientId,
          'X-Client-Secret': config.clientSecret,
        },
        timeout: 10000,
      }
    );

    if (data.status !== 'SUCCESS') {
      return { success: false, error: data.message || 'Payout auth failed' };
    }

    const token = data.data.token;
    const expiresAt = Date.now() + (data.data.expiry || 120) * 1000;

    _tokenCache = { token, expiresAt };

    return { success: true, token };
  } catch (err) {
    _tokenCache = null;
    const errMsg = err.response?.data?.message || err.message;
    console.error('[CashfreePayout] ❌ Auth failed:', errMsg);
    return { success: false, error: errMsg };
  }
}

function getPayoutHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

// ─── ADD BENEFICIARY ──────────────────────────────────────────────────────────

/**
 * addBeneficiary(owner, beneId)
 * Registers an owner as a Cashfree Payout beneficiary.
 *
 * @param {Object} owner   - Owner document with bankDetails
 * @param {string} beneId  - Unique beneficiary ID (e.g., owner.loginId)
 * @returns {{ success, beneficiary_id, error }}
 */
async function addBeneficiary(owner, beneId) {
  const config = getConfig();

  if (!config.clientId || !config.clientSecret) {
    return { success: false, error: 'Cashfree Payout credentials not configured' };
  }

  const tokenResult = await getPayoutToken(config);
  if (!tokenResult.success) return tokenResult;

  // Resolve bank details from bankDetails or checkin fields
  const bank = owner.bankDetails || {};
  const accountNumber = bank.accountNumber || owner.checkinBankAccountNumber;
  const ifsc = bank.ifsc || owner.checkinIfscCode;
  const accountName = bank.accountHolderName || owner.checkinAccountHolderName || owner.name;
  const upiId = bank.upiId || owner.checkinUpiId;

  const hasBank = !!(accountNumber && ifsc);
  const hasUpi = !!(upiId && upiId.includes('@'));

  if (!hasBank && !hasUpi) {
    return {
      success: false,
      error: 'Owner has no valid bank account (accountNumber + IFSC) or UPI configured',
    };
  }

  try {
    const payload = {
      beneId,
      name:  accountName || 'Owner',
      email: owner.email || owner.profile?.email || `${beneId}@roomhy.com`,
      phone: owner.checkinPhone || owner.phone || '9999999999',
      bankAccount: hasBank ? accountNumber : undefined,
      ifsc:        hasBank ? ifsc : undefined,
      vpa:         hasUpi ? upiId : undefined,
      address1:    owner.address || 'India',
    };

    // Remove undefined keys
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const { data } = await axios.post(
      `${config.baseUrl}/payout/v1/addBeneficiary`,
      payload,
      { headers: getPayoutHeaders(tokenResult.token), timeout: 15000 }
    );

    if (data.status === 'SUCCESS' || data.subCode === '200') {
      console.log(`[CashfreePayout] ✅ Beneficiary added: ${beneId}`);
      return {
        success:       true,
        beneficiary_id: beneId,
        mode:          hasBank ? 'bank' : 'upi',
        data,
      };
    }

    // ALREADY_EXISTS is acceptable — beneficiary is already registered
    if (data.subCode === '409' || (data.message || '').toLowerCase().includes('already')) {
      console.log(`[CashfreePayout] ℹ️ Beneficiary already exists: ${beneId}`);
      return {
        success:       true,
        beneficiary_id: beneId,
        already_exists: true,
        mode:           hasBank ? 'bank' : 'upi',
      };
    }

    return { success: false, error: data.message || 'addBeneficiary failed', data };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error('[CashfreePayout] ❌ addBeneficiary failed:', errMsg);
    return { success: false, error: errMsg };
  }
}

// ─── GET BENEFICIARY ──────────────────────────────────────────────────────────

/**
 * getBeneficiary(beneId)
 * Fetches beneficiary details from Cashfree.
 */
async function getBeneficiary(beneId) {
  const config = getConfig();
  const tokenResult = await getPayoutToken(config);
  if (!tokenResult.success) return tokenResult;

  try {
    const { data } = await axios.get(
      `${config.baseUrl}/payout/v1/getBeneficiary/${beneId}`,
      { headers: getPayoutHeaders(tokenResult.token), timeout: 10000 }
    );
    return { success: true, data, status: data.status };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ─── DIRECT TRANSFER ──────────────────────────────────────────────────────────

/**
 * initiateTransfer(params)
 * Transfers money to a registered beneficiary.
 *
 * @param {string} params.beneId       - Beneficiary ID
 * @param {number} params.amount       - Amount in INR
 * @param {string} params.transferId   - Unique transfer ID (idempotency key)
 * @param {string} params.remarks      - Transfer narration
 * @returns {{ success, transfer_id, cf_transfer_id, status, error }}
 */
async function initiateTransfer({ beneId, amount, transferId, remarks = 'Roomhy Owner Payout' }) {
  const config = getConfig();

  if (!config.clientId || !config.clientSecret) {
    return { success: false, error: 'Cashfree Payout credentials not configured' };
  }

  const tokenResult = await getPayoutToken(config);
  if (!tokenResult.success) return tokenResult;

  try {
    const payload = {
      beneId,
      amount:     parseFloat(amount.toFixed(2)),
      transferId,
      remarks,
    };

    const { data } = await axios.post(
      `${config.baseUrl}/payout/v1/directTransfer`,
      payload,
      { headers: getPayoutHeaders(tokenResult.token), timeout: 15000 }
    );

    if (data.status === 'SUCCESS') {
      const cfTransferId = data.data?.referenceId || data.data?.utr || transferId;
      console.log(`[CashfreePayout] ✅ Transfer initiated: ${cfTransferId} | ₹${amount} | Bene: ${beneId}`);
      return {
        success:        true,
        transfer_id:    transferId,
        cf_transfer_id: cfTransferId,
        status:         data.data?.transferStatus || 'INITIATED',
        data,
      };
    }

    // Handle pending/queued
    if (data.subCode === '200') {
      return {
        success:        true,
        transfer_id:    transferId,
        cf_transfer_id: data.data?.referenceId || transferId,
        status:         data.data?.transferStatus || 'PENDING',
        data,
      };
    }

    return { success: false, error: data.message || 'Transfer failed', data };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error('[CashfreePayout] ❌ initiateTransfer failed:', errMsg);
    return { success: false, error: errMsg, details: err.response?.data };
  }
}

// ─── TRANSFER STATUS ──────────────────────────────────────────────────────────

/**
 * getTransferStatus(transferId)
 * Check the current status of a payout transfer.
 * @returns {{ success, status, utr, data, error }}
 */
async function getTransferStatus(transferId) {
  const config = getConfig();
  const tokenResult = await getPayoutToken(config);
  if (!tokenResult.success) return tokenResult;

  try {
    const { data } = await axios.get(
      `${config.baseUrl}/payout/v1/getTransferStatus?transferId=${transferId}`,
      { headers: getPayoutHeaders(tokenResult.token), timeout: 10000 }
    );

    return {
      success: true,
      status:  data.data?.transferStatus || data.status,
      utr:     data.data?.utr,
      data,
    };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ─── VERIFY PAYOUT WEBHOOK SIGNATURE ──────────────────────────────────────────

/**
 * verifyPayoutWebhookSignature(rawBody, signature, timestamp)
 * Same HMAC-SHA256 scheme as PG webhook.
 */
function verifyPayoutWebhookSignature(rawBody, signature, timestamp) {
  try {
    const secret = process.env.CASHFREE_PAYOUT_WEBHOOK_SECRET || '';
    if (!secret) {
      console.warn('[CashfreePayout] ⚠️ CASHFREE_PAYOUT_WEBHOOK_SECRET not set — skipping check');
      return true;
    }

    const signedPayload = timestamp + rawBody;
    const computedSig = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('base64');

    return computedSig === signature;
  } catch (err) {
    console.error('[CashfreePayout] ❌ Webhook signature error:', err.message);
    return false;
  }
}

// ─── FULL PAYOUT ORCHESTRATION ─────────────────────────────────────────────────

/**
 * initiateOwnerPayout(tx, ownerDoc, options)
 * ────────────────────────────────────────────
 * Main entry point for owner withdrawal.
 * Performs:
 *   1. Add/verify beneficiary
 *   2. Initiate transfer
 *   3. Create PayoutLog entry
 *
 * @param {Object} tx        - PaymentTransaction document
 * @param {Object} ownerDoc  - Owner document
 * @param {Object} options   - { initiated_by: 'superadmin' }
 * @returns {{ success, cf_transfer_id, status, log_id, error }}
 *
 * NEVER THROWS. Always returns object.
 */
async function initiateOwnerPayout(tx, ownerDoc, options = {}) {
  const config = getConfig();
  const PayoutLog = require('../models/PayoutLog');

  if (!config.clientId || !config.clientSecret) {
    return { success: false, error: 'Cashfree Payout credentials not configured' };
  }

  if (!process.env.PAYOUT_ENABLED || process.env.PAYOUT_ENABLED !== 'true') {
    return { success: false, error: 'PAYOUT_ENABLED is not set to true' };
  }

  const amountToPay = tx.owner_amount || 0;
  if (amountToPay <= 0) {
    return { success: false, error: `Invalid payout amount: ₹${amountToPay}` };
  }

  const beneId = `ROOMHY_${(ownerDoc.loginId || String(ownerDoc._id)).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const transferId = `TXFR_${String(tx._id)}_${Date.now()}`;

  const bank = ownerDoc.bankDetails || {};
  const accountNumber = bank.accountNumber || ownerDoc.checkinBankAccountNumber;
  const ifsc = bank.ifsc || ownerDoc.checkinIfscCode;
  const upiId = bank.upiId || ownerDoc.checkinUpiId;
  const mode = (upiId && upiId.includes('@')) ? 'upi' : 'bank';

  const logData = {
    transaction_id:  String(tx._id),
    owner_id:        ownerDoc.loginId || String(ownerDoc._id),
    owner_name:      tx.owner_name || ownerDoc.name || '',
    amount:          amountToPay,
    mode,
    is_sandbox:      config.isSandbox,
    account_holder:  bank.accountHolderName || ownerDoc.checkinAccountHolderName || null,
    account_number:  mode === 'bank' ? accountNumber : null,
    ifsc_code:       mode === 'bank' ? ifsc : null,
    bank_name:       bank.bankName || ownerDoc.checkinBankName || null,
    upi_id:          mode === 'upi' ? upiId : null,
    initiated_by:    options.initiated_by || 'superadmin',
    status:          'initiated',
    cf_beneficiary_id: beneId,
    cf_reference_id:   transferId,
  };

  const log = { ...logData };

  try {
    // ── STEP 1: Add Beneficiary ──────────────────────────────────────────────
    const beneResult = await addBeneficiary(ownerDoc, beneId);
    log.cf_beneficiary_request  = { beneId };
    log.cf_beneficiary_response = beneResult;

    if (!beneResult.success) {
      log.status = 'failed';
      log.error_step = 'beneficiary';
      log.error_message = beneResult.error;
      await saveLog(PayoutLog, log);
      return { success: false, error: beneResult.error, log_id: log._savedId };
    }

    log.status = 'beneficiary_added';

    // ── STEP 2: Initiate Transfer ────────────────────────────────────────────
    const transferResult = await initiateTransfer({
      beneId,
      amount: amountToPay,
      transferId,
      remarks: `Roomhy Owner Payout - ${String(tx._id).substring(0, 8)}`,
    });

    log.cf_transfer_request  = { beneId, amount: amountToPay, transferId };
    log.cf_transfer_response = transferResult;

    if (!transferResult.success) {
      log.status = 'failed';
      log.error_step = 'transfer';
      log.error_message = transferResult.error;
      await saveLog(PayoutLog, log);
      return { success: false, error: transferResult.error, log_id: log._savedId };
    }

    log.cf_transfer_id = transferResult.cf_transfer_id;
    log.status = 'queued';

    await saveLog(PayoutLog, log);

    console.log(`[CashfreePayout] ✅ Payout queued | Owner: ${logData.owner_id} | ₹${amountToPay} | TransferId: ${transferId}`);

    return {
      success:        true,
      cf_transfer_id: transferResult.cf_transfer_id,
      transfer_id:    transferId,
      status:         log.status,
      log_id:         log._savedId,
      mode,
    };

  } catch (unexpectedErr) {
    log.status = 'failed';
    log.error_step = 'unexpected';
    log.error_message = unexpectedErr.message || 'Unexpected error in payout service';
    console.error('[CashfreePayout] ❌ Unexpected error:', unexpectedErr.message);
    try { await saveLog(PayoutLog, log); } catch (_) {}
    return { success: false, error: log.error_message };
  }
}

// ─── SAVE LOG ─────────────────────────────────────────────────────────────────

async function saveLog(PayoutLog, log) {
  try {
    const saved = await PayoutLog.create(log);
    log._savedId = String(saved._id);
  } catch (logErr) {
    console.warn('[CashfreePayout] ⚠️ PayoutLog save failed (non-blocking):', logErr.message);
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  initiateOwnerPayout,
  addBeneficiary,
  getBeneficiary,
  initiateTransfer,
  getTransferStatus,
  verifyPayoutWebhookSignature,
};
