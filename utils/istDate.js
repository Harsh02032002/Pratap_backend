'use strict';
// Shared IST (Asia/Kolkata) date helpers for billing-month math.
// Mirrors the Intl-based approach in engine/penaltyEngine.js so billing-period
// boundaries don't drift with the server process's local timezone.

const IST_TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getISTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(date)); // "YYYY-MM-DD"
}

/** "YYYY-MM" for the given instant, in IST. */
function getISTBillingMonth(date = new Date()) {
  return getISTDateString(date).slice(0, 7);
}

/** The UTC instant corresponding to 00:00 IST on the 1st of `billingMonth` ("YYYY-MM"). */
function istMonthStartUTC(billingMonth) {
  const [y, m] = billingMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - IST_OFFSET_MS);
}

/** `billingMonth` ("YYYY-MM") shifted by `delta` whole months. */
function addMonthsToBillingMonth(billingMonth, delta) {
  const [y, m] = billingMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The billing month a transfer's new pricing takes effect in: the month
 * following the transfer date, per the "current month = old, next month =
 * new" business rule. No proration.
 */
function nextBillingMonth(fromDate) {
  return addMonthsToBillingMonth(getISTBillingMonth(fromDate), 1);
}

module.exports = {
  getISTDateString,
  getISTBillingMonth,
  istMonthStartUTC,
  addMonthsToBillingMonth,
  nextBillingMonth,
};
