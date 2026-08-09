const axios = require('axios');
const crypto = require('crypto');

/**
 * Cashfree Payout Service V2 / V3
 * Handles instant direct bank transfers for Owners and Admin Platform Commission.
 */

function getConfig() {
  const isSandbox = process.env.CASHFREE_MODE !== 'production';
  const baseUrl = isSandbox
    ? 'https://sandbox.cashfree.com/payout'
    : 'https://api.cashfree.com/payout';

  return {
    clientId:     process.env.CASHFREE_CLIENT_ID || process.env.CF_APP_ID || '',
    secretKey:    process.env.CASHFREE_SECRET_KEY || process.env.CF_SECRET_KEY || '',
    baseUrl,
    isSandbox,
  };
}

function getHeaders(config) {
  return {
    'X-Client-Id':     config.clientId,
    'X-Client-Secret': config.secretKey,
    'Content-Type':    'application/json',
    'x-api-version':   '2024-01-01',
  };
}

/**
 * directBankTransfer
 * Instantly transfers money from Cashfree Payout balance directly to Bank Account / UPI ID.
 */
async function directBankTransfer({ transferId, amount, bankDetails, remarks = 'Roomhy Payout' }) {
  const config = getConfig();

  if (!config.clientId || !config.secretKey) {
    console.warn('[CashfreePayout] Credentials missing, running mock payout success mode for development.');
    return {
      success: true,
      transferId,
      referenceId: `UTR_MOCK_${Date.now()}`,
      status: 'SUCCESS',
      isMock: true,
    };
  }

  try {
    const payload = {
      transfer_id: transferId,
      transfer_amount: Number(amount),
      transfer_mode: bankDetails.upiId ? 'upi' : 'imps',
      transfer_remarks: remarks,
      beneficiary_details: {
        beneficiary_id: `BEN_${transferId.slice(-12)}`,
        beneficiary_name: bankDetails.accountHolderName || 'Account Holder',
        beneficiary_account_number: bankDetails.accountNumber,
        beneficiary_ifsc: bankDetails.ifsc,
        beneficiary_upi: bankDetails.upiId || undefined,
      }
    };

    const { data } = await axios.post(`${config.baseUrl}/transfers`, payload, {
      headers: getHeaders(config),
      timeout: 15000,
    });

    console.log(`[CashfreePayout] ✅ Transfer initiated: ${transferId} | Status: ${data.status}`);

    return {
      success:     true,
      transferId:  data.transfer_id || transferId,
      referenceId: data.reference_id || data.utr || null,
      status:      data.status || 'SUCCESS',
      data,
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || 'Payout failed';
    console.error('[CashfreePayout] ❌ Transfer error:', errMsg);
    return {
      success: false,
      error: errMsg,
      details: err.response?.data,
    };
  }
}

module.exports = {
  directBankTransfer,
};
