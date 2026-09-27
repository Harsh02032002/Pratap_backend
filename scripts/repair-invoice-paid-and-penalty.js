'use strict';
/**
 * Repairs invoices damaged by the old cash/PayU payment code, which
 *   - overwrote paidAmount with the latest payment instead of adding to it, and
 *   - (cash OTP) rewrote totalPenalty as "paid − rent − electricity", zeroing the
 *     late fee whenever a small top-up (e.g. electricity only) was paid.
 *
 * Rebuilds from records that were never overwritten:
 *   paidAmount   = sum of RentPayment.amount for the invoice (if larger than stored)
 *   totalPenalty = latest minor + major entry in penaltyHistory, or sum of
 *                  RentPayment.penaltyPaidAmount — only when stored penalty is 0
 *                  and the invoice was never waived.
 *
 * Usage:
 *   node scripts/repair-invoice-paid-and-penalty.js                 # dry run, all invoices
 *   node scripts/repair-invoice-paid-and-penalty.js --invoice=INV-2026-09-0973c4-MTJOA4HN
 *   node scripts/repair-invoice-paid-and-penalty.js --apply         # write changes
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const RentInvoice = require('../models/RentInvoice');
const RentPayment = require('../models/RentPayment');

const APPLY = process.argv.includes('--apply');
const onlyInvoice = (process.argv.find(a => a.startsWith('--invoice=')) || '').split('=')[1];
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;

function penaltyFromHistory(inv) {
  const hist = inv.penaltyHistory || [];
  const lastMinor = hist.filter(h => h.type === 'minor').slice(-1)[0];
  const lastMajor = hist.filter(h => h.type === 'major').slice(-1)[0];
  return {
    minor: Number(lastMinor?.amount || 0),
    major: Number(lastMajor?.amount || 0),
  };
}

async function main() {
  if (!MONGO_URI) { console.error('No MONGO_URI in .env'); process.exit(1); }
  await mongoose.connect(MONGO_URI);
  console.log(APPLY ? 'APPLY mode — changes will be written\n' : 'DRY RUN — nothing will be written (pass --apply to write)\n');

  const filter = { status: { $nin: ['CANCELLED'] } };
  if (onlyInvoice) filter.invoiceNumber = onlyInvoice;
  const invoices = await RentInvoice.find(filter).lean();

  let changed = 0;
  for (const inv of invoices) {
    const payments = await RentPayment.find({ invoiceId: inv._id }).select('amount penaltyPaidAmount').lean();
    const sumPaid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const sumPenaltyPaid = payments.reduce((s, p) => s + Number(p.penaltyPaidAmount || 0), 0);

    const storedPaid = Number(inv.paidAmount || 0);
    const paidAmount = Math.max(storedPaid, sumPaid);

    let totalPenalty = Number(inv.totalPenalty || 0);
    let minorPenaltyAmount = inv.minorPenaltyAmount;
    let majorPenaltyAmount = inv.majorPenaltyAmount;
    const waived = inv.status === 'WAIVED' || !!inv.waiver?.waivedAt;
    if (totalPenalty === 0 && !waived) {
      const h = penaltyFromHistory(inv);
      const fromHistory = h.minor + h.major;
      const restored = Math.max(fromHistory, sumPenaltyPaid);
      if (restored > 0) {
        totalPenalty = restored;
        if (fromHistory >= sumPenaltyPaid) {
          minorPenaltyAmount = h.minor;
          majorPenaltyAmount = h.major;
        }
      }
    }

    if (paidAmount === storedPaid && totalPenalty === Number(inv.totalPenalty || 0)) continue;

    const rent = Number(inv.rentAmount || 0);
    const totalDue = rent + totalPenalty + Number(inv.electricityBill || 0) + Number(inv.advanceChargeAmount || 0);
    const outstandingAmount = Math.max(0, totalDue - paidAmount);
    const status = inv.status === 'WAIVED' ? 'WAIVED'
      : outstandingAmount <= 0 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'PENDING';

    const set = {
      paidAmount, totalPenalty, minorPenaltyAmount, majorPenaltyAmount,
      totalDue, outstandingAmount, status,
      rentPaidAmount: Math.max(Number(inv.rentPaidAmount || 0), Math.min(rent, paidAmount)),
    };

    changed++;
    console.log(`${inv.invoiceNumber} (${inv.billingMonth}) ${inv.tenantName || ''}`);
    console.log(`  paid     ₹${storedPaid} → ₹${paidAmount}   (sum of ${payments.length} payment records: ₹${sumPaid})`);
    console.log(`  penalty  ₹${inv.totalPenalty || 0} → ₹${totalPenalty}`);
    console.log(`  due      ₹${inv.totalDue || 0} → ₹${totalDue}   outstanding ₹${inv.outstandingAmount || 0} → ₹${outstandingAmount}   status ${inv.status} → ${status}\n`);

    if (APPLY) await RentInvoice.updateOne({ _id: inv._id }, { $set: set });
  }

  console.log(`${changed} invoice(s) ${APPLY ? 'repaired' : 'would be repaired'}.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
