'use strict';
/**
 * fix-repaired-payment-records.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixes the RentPayment records created by repair-missing-payments.js:
 *  1. Updates amount to include penalty (uses invoice.totalDue, not paidAmount)
 *  2. Cleans the internal note text
 *  3. Ensures the matching RentInvoice also has correct paidAmount + outstanding=0
 *
 * Usage:  node scripts/fix-repaired-payment-records.js
 * Safe to re-run (idempotent).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const RentInvoice = require('../models/RentInvoice');
const RentPayment = require('../models/RentPayment');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;

async function main() {
    if (!MONGO_URI) { console.error('❌ No MONGO_URI in .env'); process.exit(1); }
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all payments created by the repair script
    const repairedPayments = await RentPayment.find({
        transactionId: /^REPAIR-/,
    }).lean();

    console.log(`📊 Found ${repairedPayments.length} repair-created payment(s) to fix.\n`);

    for (const payment of repairedPayments) {
        // Fetch the matching invoice to get the correct totalDue (rent + penalty)
        const invoice = await RentInvoice.findById(payment.invoiceId).lean();
        if (!invoice) {
            console.warn(`  ⚠️  No invoice found for payment ${payment._id} — skipping.`);
            continue;
        }

        // Correct amount: use totalDue (includes rent + penalty + electricity)
        // Fall back chain: totalDue → outstandingAmount → rentAmount
        const correctAmount = Number(invoice.totalDue || invoice.outstandingAmount || invoice.rentAmount || 0);
        const correctRentPaid = Number(invoice.rentAmount || 0);
        const correctPenaltyPaid = Number(invoice.totalPenalty || 0);
        const cleanNote = 'Cash payment';

        console.log(`🔧 Fixing payment ${payment._id}`);
        console.log(`   Invoice : ${invoice.invoiceNumber} (${invoice.billingMonth})`);
        console.log(`   Old amount : ₹${payment.amount}  →  New amount : ₹${correctAmount}`);
        console.log(`   Penalty    : ₹${correctPenaltyPaid}`);

        await RentPayment.findByIdAndUpdate(payment._id, {
            $set: {
                amount: correctAmount,
                rentPaidAmount: correctRentPaid,
                penaltyPaidAmount: correctPenaltyPaid,
                remainingAfter: 0,
                isPartial: false,
                notes: cleanNote,
            }
        });

        // Also make sure the invoice paidAmount is correct
        await RentInvoice.findByIdAndUpdate(invoice._id, {
            $set: {
                paidAmount: correctAmount,
                rentPaidAmount: correctRentPaid,
                penaltyPaidAmount: correctPenaltyPaid,
                outstandingAmount: 0,
                status: 'PAID',
            }
        });

        console.log(`   ✅ Fixed — amount: ₹${correctAmount}, note: "${cleanNote}"\n`);
    }

    console.log('─────────────────────────────────────────────');
    console.log(`✅ Done. ${repairedPayments.length} record(s) fixed.`);
    console.log('─────────────────────────────────────────────\n');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
