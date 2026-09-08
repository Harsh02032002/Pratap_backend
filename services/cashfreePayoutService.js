'use strict';

/**
 * cashfreePayoutService.js
 * ─────────────────────────
 * Cashfree Payouts API Integration.
 * Handles instant direct bank transfers for Owners and Admin Platform Commission.
 */

const axios = require('axios');

function isPlaceholder(val) {
  if (!val) return true;
  const str = String(val).trim().toUpperCase();
  return str.startsWith('YOUR_') || str.includes('YOUR_LIVE_') || str.includes('PLACEHOLDER') || str.length < 5;
}

function getConfig() {
  const env = (process.env.CASHFREE_ENV || process.env.CASHFREE_MODE || 'TEST').toUpperCase();
  const isSandbox = env !== 'PROD' && process.env.CASHFREE_MODE !== 'production';

  const rawClientId = process.env.CASHFREE_PAYOUT_CLIENT_ID || process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || process.env.CF_APP_ID || '';
  const rawSecretKey = process.env.CASHFREE_PAYOUT_CLIENT_SECRET || process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_SECRET || process.env.CF_SECRET_KEY || '';

  const clientId = isPlaceholder(rawClientId) ? '' : rawClientId;
  const secretKey = isPlaceholder(rawSecretKey) ? '' : rawSecretKey;

  return {
    clientId,
    secretKey,
    baseUrl:      isSandbox ? 'https://sandbox.cashfree.com/payout' : 'https://api.cashfree.com/payout',
    payoutApiUrl: isSandbox ? 'https://payout-api.cashfree.com/payout' : 'https://payout-api.cashfree.com/payout',
    isSandbox,
  };
}

let _cachedPayoutToken = null;
let _cachedPayoutTokenExpiry = 0;

/**
 * getPayoutAuthToken(config)
 * Obtains a Bearer Authorization Token required for Cashfree Payouts API.
 */
async function getPayoutAuthToken(config) {
  if (_cachedPayoutToken && Date.now() < _cachedPayoutTokenExpiry) {
    return _cachedPayoutToken;
  }

  const authUrls = [
    `${config.payoutApiUrl}/v1/authorize`,
    `${config.baseUrl}/v1/authorize`,
    `https://api.cashfree.com/payout/v1/authorize`
  ];

  let lastErr = null;
  for (const url of authUrls) {
    try {
      const { data } = await axios.post(url, {}, {
        headers: {
          'X-Client-Id':     config.clientId,
          'X-Client-Secret': config.secretKey,
          'Content-Type':    'application/json',
        },
        timeout: 10000,
      });

      if (data?.status === 'SUCCESS' && data?.data?.token) {
        _cachedPayoutToken = data.data.token;
        _cachedPayoutTokenExpiry = Date.now() + 50 * 60 * 1000; // 50 min validity
        console.log('[CashfreePayout] ✅ Payout Authorization Token generated successfully');
        return _cachedPayoutToken;
      } else if (data?.message) {
        lastErr = data.message;
      }
    } catch (err) {
      lastErr = err.response?.data?.message || err.message;
    }
  }

  throw new Error(lastErr || 'Could not obtain Cashfree Payout authorization token');
}

/**
 * directBankTransfer
 * Instantly transfers money from Cashfree Payout balance directly to Bank Account / UPI ID.
 */
async function directBankTransfer({ transferId, amount, bankDetails = {}, remarks = 'Roomhy Payout' }) {
  const config = getConfig();

  if (!config.clientId || !config.secretKey) {
    return {
      success: false,
      error: 'Cashfree Payout credentials missing or placeholder detected in server .env. Please configure CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET from Cashfree Dashboard -> Payouts -> Developers.',
    };
  }

  try {
    const token = await getPayoutAuthToken(config);

    const isUpi = Boolean(bankDetails.upiId && String(bankDetails.upiId).includes('@'));
    const cleanAmount = parseFloat(Number(amount).toFixed(2));
    const cleanTransferId = String(transferId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

    const payload = {
      transferId:   cleanTransferId,
      amount:       cleanAmount,
      transferMode: isUpi ? 'upi' : 'banktransfer',
      remarks:      remarks || 'Roomhy Owner Payout',
      beneDetails:  isUpi ? {
        name:  bankDetails.accountHolderName || 'Account Holder',
        email: bankDetails.email || 'owner@roomhy.com',
        phone: bankDetails.phone || '9999999999',
        vpa:   String(bankDetails.upiId).trim(),
      } : {
        name:        bankDetails.accountHolderName || 'Account Holder',
        email:       bankDetails.email || 'owner@roomhy.com',
        phone:       bankDetails.phone || '9999999999',
        bankAccount: String(bankDetails.accountNumber || '').trim(),
        ifsc:        String(bankDetails.ifsc || '').trim().toUpperCase(),
      }
    };

    const transferUrls = [
      `${config.payoutApiUrl}/v1.2/directTransfer`,
      `${config.baseUrl}/v1.2/directTransfer`,
      `${config.payoutApiUrl}/v1/directTransfer`,
      `https://api.cashfree.com/payout/v1.2/directTransfer`
    ];

    let transferRes = null;
    let transferErr = null;

    for (const url of transferUrls) {
      try {
        const { data } = await axios.post(url, payload, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
          },
          timeout: 15000,
        });

        if (data && (data.status === 'SUCCESS' || data.status === 'PENDING' || data.subCode === '200')) {
          transferRes = data;
          break;
        } else if (data && data.message) {
          transferErr = data.message;
        }
      } catch (err) {
        transferErr = err.response?.data?.message || err.message;
        if (err.response?.status === 401) {
          _cachedPayoutToken = null; // Clear expired token
        }
      }
    }

    if (transferRes) {
      const refId = transferRes.data?.utr || transferRes.data?.referenceId || transferRes.reference_id || cleanTransferId;
      console.log(`[CashfreePayout] ✅ Direct bank transfer succeeded: ${cleanTransferId} | UTR: ${refId}`);
      return {
        success:     true,
        transferId:  transferRes.data?.transferId || cleanTransferId,
        referenceId: refId,
        status:      transferRes.data?.status || 'SUCCESS',
        data:        transferRes,
      };
    }

    return {
      success: false,
      error:   transferErr || 'Cashfree Direct Transfer Failed',
    };

  } catch (err) {
    const errMsg = err.message || 'Payout failed';
    console.error('[CashfreePayout] ❌ Transfer error:', errMsg);
    return {
      success: false,
      error:   errMsg,
    };
  }
}

module.exports = {
  directBankTransfer,
  getPayoutAuthToken,
  getConfig,
};
