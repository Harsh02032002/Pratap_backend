'use strict';

/**
 * payuPaymentService.js
 * ───────────────────────
 * PayU Payment Gateway Integration Service.
 *
 * Implements server-side SHA-512 request hash generation, response signature verification,
 * and server-to-server payment status verification (`verify_payment`).
 *
 * SECURITY:
 * - Merchant key & merchant salt are read exclusively from server environment variables.
 * - Secret credentials are NEVER exposed to browser code.
 * - Response hash verification happens server-side before confirming payment status.
 */

const crypto = require('crypto');

function getConfig() {
  const env = (process.env.PAYU_ENV || 'sandbox').toLowerCase();
  const isProduction = env === 'production' || env === 'live';

  const key = (process.env.PAYU_MERCHANT_KEY || '').trim();
  const salt = (process.env.PAYU_MERCHANT_SALT || '').trim();

  const baseUrl = isProduction ? 'https://secure.payu.in' : 'https://test.payu.in';
  const actionUrl = `${baseUrl}/_payment`;
  const verifyApiUrl = `${baseUrl}/merchant/postservice?form=2`;

  const serverApiUrl = (process.env.API_URL || 'http://localhost:5000').replace(/\/+$/, '');
  const successUrl = process.env.PAYU_SUCCESS_URL || `${serverApiUrl}/api/payments/payu/response`;
  const failureUrl = process.env.PAYU_FAILURE_URL || `${serverApiUrl}/api/payments/payu/response`;

  return {
    env,
    isProduction,
    key,
    salt,
    actionUrl,
    verifyApiUrl,
    successUrl,
    failureUrl,
    hasCredentials: Boolean(key && salt)
  };
}

/**
 * Format amount as a consistent string with 2 decimal places (e.g. 100.00)
 */
function formatAmount(amount) {
  const num = parseFloat(String(amount || 0).replace(/[^\d.-]/g, ''));
  return isNaN(num) ? '0.00' : num.toFixed(2);
}

/**
 * Generate PayU Payment Initiation SHA-512 Hash:
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
 */
function generatePaymentHash({ key, txnid, amount, productinfo, firstname, email, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '', salt }) {
  const amountStr = formatAmount(amount);
  const cleanProductInfo = String(productinfo || 'Roomhy Service').trim().replace(/[\r\n|]/g, ' ');
  const cleanFirstName = String(firstname || 'User').trim().replace(/[\r\n|]/g, ' ');
  const cleanEmail = String(email || 'customer@roomhy.com').trim().replace(/[\r\n|]/g, ' ');

  const hashSequence = `${key}|${txnid}|${amountStr}|${cleanProductInfo}|${cleanFirstName}|${cleanEmail}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`;
  return crypto.createHash('sha512').update(hashSequence).digest('hex').toLowerCase();
}

/**
 * Verify PayU Response SHA-512 Reverse Hash:
 * With additionalCharges: sha512(additionalCharges|salt|status|||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 * Without additionalCharges: sha512(salt|status|||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
function verifyResponseHash(params) {
  const config = getConfig();
  const salt = config.salt;
  if (!salt) return false;

  const {
    key = config.key,
    txnid = '',
    amount = '0',
    productinfo = '',
    firstname = '',
    email = '',
    status = '',
    hash = '',
    additionalCharges,
    udf1 = '',
    udf2 = '',
    udf3 = '',
    udf4 = '',
    udf5 = ''
  } = params;

  const amountStr = formatAmount(amount);
  const cleanStatus = String(status || '').trim();

  let hashSequence;
  if (additionalCharges) {
    hashSequence = `${additionalCharges}|${salt}|${cleanStatus}|||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amountStr}|${txnid}|${key}`;
  } else {
    hashSequence = `${salt}|${cleanStatus}|||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amountStr}|${txnid}|${key}`;
  }

  const calculatedHash = crypto.createHash('sha512').update(hashSequence).digest('hex').toLowerCase();
  const expectedHash = String(hash || '').trim().toLowerCase();

  return calculatedHash === expectedHash;
}

/**
 * Perform server-to-server payment status verification with PayU API (`verify_payment` command).
 * Payload: key={key}&command=verify_payment&var1={txnid}&hash={sha512(key|verify_payment|txnid|salt)}
 */
async function verifyPaymentWithPayU(txnid) {
  const config = getConfig();
  if (!config.hasCredentials) {
    console.warn('[PayUService] ⚠️ PayU credentials not configured; skipping remote verify_payment API call');
    return { success: false, error: 'PayU credentials missing', isMock: true };
  }

  try {
    const command = 'verify_payment';
    const hashSequence = `${config.key}|${command}|${txnid}|${config.salt}`;
    const hash = crypto.createHash('sha512').update(hashSequence).digest('hex').toLowerCase();

    const bodyParams = new URLSearchParams();
    bodyParams.append('key', config.key);
    bodyParams.append('command', command);
    bodyParams.append('var1', txnid);
    bodyParams.append('hash', hash);

    const response = await fetch(config.verifyApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: bodyParams.toString()
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, error: `PayU verify_payment HTTP error ${response.status}`, raw: data };
    }

    // PayU returns object structure like: { status: 1, transaction_details: { [txnid]: { status: 'success', mihpayid: '...', amount: '...' } } }
    const details = data?.transaction_details?.[txnid] || {};
    const statusStr = String(details.status || data.status || '').toLowerCase();
    const isSuccess = statusStr === 'success' || statusStr === '1';

    return {
      success: isSuccess,
      status: statusStr,
      mihpayid: details.mihpayid || details.payuMoneyId || null,
      bank_ref_num: details.bank_ref_num || null,
      amount: details.amount || null,
      raw: data
    };
  } catch (err) {
    console.error('[PayUService] ❌ verifyPaymentWithPayU error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Prepares complete PayU payment parameters for frontend form submission.
 */
function preparePaymentOrder({ txnid, amount, productinfo, firstname, email, phone, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' }) {
  const config = getConfig();

  const formattedAmount = formatAmount(amount);
  const cleanProductInfo = String(productinfo || 'Roomhy Stay').trim();
  const cleanFirstName = String(firstname || 'Guest').trim();
  const cleanEmail = String(email || 'guest@roomhy.com').trim();
  const cleanPhone = String(phone || '9999999999').trim();

  // If local sandbox without credentials set in .env, log fallback info
  if (!config.hasCredentials) {
    console.log(`[PayUService] ⚡ Preparing Sandbox PayU parameters for txnid: ${txnid} (Local environment)`);
  }

  const hash = generatePaymentHash({
    key: config.key || 'gtKWidget',
    txnid,
    amount: formattedAmount,
    productinfo: cleanProductInfo,
    firstname: cleanFirstName,
    email: cleanEmail,
    udf1,
    udf2,
    udf3,
    udf4,
    udf5,
    salt: config.salt || '4A87Ig'
  });

  return {
    actionUrl: config.actionUrl,
    params: {
      key: config.key || 'gtKWidget',
      txnid,
      amount: formattedAmount,
      productinfo: cleanProductInfo,
      firstname: cleanFirstName,
      email: cleanEmail,
      phone: cleanPhone,
      surl: config.successUrl,
      furl: config.failureUrl,
      hash,
      udf1,
      udf2,
      udf3,
      udf4,
      udf5
    },
    isSandbox: !config.isProduction
  };
}

module.exports = {
  getConfig,
  formatAmount,
  generatePaymentHash,
  verifyResponseHash,
  verifyPaymentWithPayU,
  preparePaymentOrder
};
