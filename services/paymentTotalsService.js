'use strict';

/**
 * paymentTotalsService — database-side money totals for dashboard endpoints.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Dashboard endpoints only ever needed a single number, but were fetching every
 * matching payment document and summing it in JavaScript:
 *
 *     const transactions = await PaymentTransaction.find({ owner_id }).lean();
 *     const total = transactions.reduce((s, t) => s + (t.owner_amount || 0), 0);
 *
 * That transfers the whole result set to Node just to collapse it to one scalar,
 * and the workload grows with transaction volume forever. These helpers push the
 * $sum into MongoDB so only the scalar crosses the wire.
 *
 * EQUIVALENCE NOTES (why these match the JS they replaced)
 * ───────────────────────────────────────────────────────
 * • `PaymentTransaction.owner_amount`, `RentPayment.amount` and
 *   `Enquiry.paidAmount` are all declared `Number` in their schemas, so a
 *   stored value is always numeric. For a missing/null field MongoDB's $sum
 *   contributes 0 and the old `|| 0` produced 0 — identical.
 * • A value of exactly 0 also matches: `0 || 0` is 0, and $sum adds 0.
 * • An empty match returns no group document at all, so every helper falls back
 *   to 0 rather than undefined — dashboards expect a number.
 *
 * Filters are passed in by the caller and used verbatim as the $match stage, so
 * owner/property scoping and status rules stay exactly where they were defined.
 */

const PaymentTransaction = require('../models/PaymentTransaction');
const RentPayment = require('../models/RentPayment');
const Enquiry = require('../models/Enquiry');
const { withAggregateDeadline } = require('../utils/queryDeadline');

/**
 * Run a `$match` + `$group`/`$sum` and return the scalar, or 0 when nothing matched.
 *
 * @param {import('mongoose').Model} Model
 * @param {object} match     used verbatim as the $match stage
 * @param {string} field     the numeric field to sum, without the `$` prefix
 * @param {'read'|'report'|'job'} [cls='read']  server-side deadline class
 * @returns {Promise<number>}
 */
async function sumField(Model, match, field, cls = 'read') {
  const [row] = await withAggregateDeadline(
    Model.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: `$${field}` } } },
    ]),
    cls,
  );
  return row?.total ?? 0;
}

/**
 * Owner's share of online booking payments.
 * Replaces: PaymentTransaction.find(filter).select('owner_amount') + reduce.
 *
 * No status filter — deliberately. The JS this replaces summed every
 * transaction row for the owner regardless of status, and changing that would
 * change the number the dashboard has always reported.
 *
 * @param {object} filter e.g. { owner_id: 'ROOMHY1234', property_id: '…' }
 */
const sumPaymentTransactions = (filter) => sumField(PaymentTransaction, filter, 'owner_amount');

/**
 * Manually recorded rent payments.
 * Replaces: RentPayment.find(filter).select('amount') + reduce.
 *
 * @param {object} filter e.g. { ownerId: ObjectId, propertyId: ObjectId }
 */
const sumRentPayments = (filter) => sumField(RentPayment, filter, 'amount');

/**
 * Booking deposits captured on enquiries.
 * Replaces: Enquiry.find(filter).select('paidAmount') + reduce.
 *
 * The caller supplies the status filter, so which enquiry states count as
 * revenue stays defined at the call site.
 *
 * @param {object} filter
 */
const sumEnquiryPaidAmounts = (filter) => sumField(Enquiry, filter, 'paidAmount');

/**
 * Platform-wide PaymentTransaction totals for the admin wallet.
 *
 * Replaces an unfiltered `PaymentTransaction.find()` — the entire collection
 * loaded into Node — followed by four separate reduce() passes over it. One
 * $group produces all four figures instead.
 *
 * Reproducing the old JS exactly (verified against the schema):
 *
 * • `total_amount` and `commission` are NOT declared on the schema, and the
 *   schema is strict, so neither was ever persisted — both were always
 *   `undefined` at runtime. Every `t.total_amount || …` chain therefore always
 *   fell through to its next term, and `t.commission || …` always fell through
 *   to the computed 5%. The stages below encode that resolved behaviour.
 *
 * • Commission used `Math.round(x)` PER DOCUMENT, then summed — not a round of
 *   the sum. That per-document rounding is preserved.
 *
 * • `$round` is deliberately NOT used: it rounds half-to-even (banker's), while
 *   JS `Math.round` rounds half-up. They disagree at exactly .5 — e.g. a
 *   booking_amount of 10 gives 0.5, where Math.round is 1 and $round is 0.
 *   `$floor(x + 0.5)` reproduces Math.round for non-negative amounts, which is
 *   the only range booking_amount takes.
 *
 * @returns {Promise<{totalRevenue:number,totalCommission:number,totalOwnerHeld:number,totalOwnerAvailable:number,transactionCount:number}>}
 */
async function getAdminTransactionTotals() {
  const bookingAmount = { $ifNull: ['$booking_amount', 0] };
  const ownerAmount = { $ifNull: ['$owner_amount', 0] };

  const [row] = await withAggregateDeadline(PaymentTransaction.aggregate([
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: bookingAmount },
        // Math.round(booking_amount * 0.05), per document, then summed.
        totalCommission: {
          $sum: { $floor: { $add: [{ $multiply: [bookingAmount, 0.05] }, 0.5] } },
        },
        totalOwnerHeld: {
          $sum: { $cond: [{ $eq: ['$wallet_status', 'held'] }, ownerAmount, 0] },
        },
        totalOwnerAvailable: {
          $sum: { $cond: [{ $eq: ['$wallet_status', 'available'] }, ownerAmount, 0] },
        },
        transactionCount: { $sum: 1 },
      },
    },
  ]));

  return {
    totalRevenue: row?.totalRevenue ?? 0,
    totalCommission: row?.totalCommission ?? 0,
    totalOwnerHeld: row?.totalOwnerHeld ?? 0,
    totalOwnerAvailable: row?.totalOwnerAvailable ?? 0,
    transactionCount: row?.transactionCount ?? 0,
  };
}

module.exports = {
  sumField,
  sumPaymentTransactions,
  sumRentPayments,
  sumEnquiryPaidAmounts,
  getAdminTransactionTotals,
};
