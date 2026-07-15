'use strict';
/**
 * repair-missing-payments.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time repair script: finds every PAID RentInvoice that is missing a
 * corresponding RentPayment record and creates the missing entry.
 *
 * Root cause fixed: the `receipt is not defined` ReferenceError inside
 * verifyCashPaymentOtp caused createRentPaymentHistory to crash silently,
 * leaving the invoice as PAID but with no payment history row.
 *
 * Usage:
 *   node scripts/repair-missing-payments.js
 *
 * Safe to re-run — already-repaired invoices are skipped automatically.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');

const RentInvoice = require('../models/RentInvoice');
const RentPayment = require('../models/RentPayment');
const Rent = require('../models/Rent');
const Tenant = require('../models/Tenant');
const RentAuditLog = require('../models/RentAuditLog');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;

async function main() {
    if (!MONGO_URI) {
        console.error('❌  No MONGO_URI found in .env — cannot connect to database.');
        process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    console.log('✅  Connected to MongoDB');

    // ── Step 1: Find all PAID invoices ─────────────────────────────────────────
    const paidInvoices = await RentInvoice.find({ status: 'PAID' }).lean();
    console.log(`\n📊  Found ${paidInvoices.length} PAID invoice(s) to check.`);

    let repaired = 0;
    let skipped = 0;
    let failed = 0;

    for (const invoice of paidInvoices) {
        try {
            // ── Step 2: Check if a RentPayment already exists ─────────────────────
            const existingPayment = await RentPayment.findOne({ invoiceId: invoice._id });
            if (existingPayment) {
                skipped++;
                continue; // already has a payment record — nothing to do
            }

            console.log(`\n🔧  Repairing invoice: ${invoice.invoiceNumber} (${invoice.billingMonth})`);

            // ── Step 3: Find matching Rent record for extra metadata ───────────────
            const tenantDoc = await Tenant.findById(invoice.tenantId).select('loginId name email phone').lean();
            const rentRecord = tenantDoc ? await Rent.findOne({
                $or: [
                    { tenantId: invoice.tenantId },
                    { tenantLoginId: tenantDoc.loginId }
                ],
                collectionMonth: invoice.billingMonth,
                paymentStatus: { $in: ['paid', 'completed'] }
            }).sort({ updatedAt: -1 }).lean() : null;

            // ── Step 4: Determine payment details from invoice ─────────────────────
            const paidAt = invoice.lastEvaluatedAt || invoice.updatedAt || new Date();
            const amount = Number(invoice.paidAmount || invoice.totalDue || invoice.rentAmount || 0);
            const rentPaid = Number(invoice.rentPaidAmount || invoice.rentAmount || amount);
            const penaltyPaid = Number(invoice.penaltyPaidAmount || invoice.totalPenalty || 0);
            const payMethod = rentRecord?.paymentMethod === 'razorpay' ? 'online'
                : rentRecord?.paymentMethod === 'cash' ? 'cash'
                    : 'cash'; // default to cash for unknown

            // Build a deterministic transaction ID so we can't create duplicates
            const transactionId = `REPAIR-${String(invoice._id).slice(-8).toUpperCase()}-${String(invoice.billingMonth).replace('-', '')}`;

            // Guard against duplicate transactionId from previous repair run
            const dupCheck = await RentPayment.findOne({ transactionId });
            if (dupCheck) {
                console.log(`   ℹ️  Already repaired (found repair transactionId) — skipping.`);
                skipped++;
                continue;
            }

            if (!invoice.ownerId || !invoice.tenantId || !invoice.propertyId) {
                console.warn(`   ⚠️  Invoice ${invoice.invoiceNumber} missing ownerId/tenantId/propertyId — skipping.`);
                failed++;
                continue;
            }

            // ── Step 5: Create the missing RentPayment ────────────────────────────
            await RentPayment.create({
                invoiceId: invoice._id,
                tenantId: invoice.tenantId,
                propertyId: invoice.propertyId,
                ownerId: invoice.ownerId,
                amount,
                paymentMethod: payMethod,
                transactionId,
                isPartial: false,
                remainingAfter: 0,
                rentPaidAmount: rentPaid,
                penaltyPaidAmount: penaltyPaid,
                paymentDate: paidAt,
                recordedBy: 'system-repair',
        notes:             "Cash payment",
                isLateEntry: true,
            });

            // ── Step 6: Ensure RentInvoice fields are fully correct ───────────────
            await RentInvoice.findByIdAndUpdate(invoice._id, {
                $set: {
                    paidAmount: Math.max(invoice.paidAmount || 0, amount),
                    rentPaidAmount: Math.max(invoice.rentPaidAmount || 0, rentPaid),
                    penaltyPaidAmount: penaltyPaid,
                    outstandingAmount: 0,
                    status: 'PAID',
                }
            });

            // ── Step 7: Audit log ─────────────────────────────────────────────────
            await RentAuditLog.create({
                action: 'PAYMENT_REPAIRED',
                invoiceId: invoice._id,
                tenantId: invoice.tenantId,
                ownerId: invoice.ownerId,
                propertyId: invoice.propertyId,
                performedBy: 'system-repair',
                meta: {
                    invoiceNumber: invoice.invoiceNumber,
                    billingMonth: invoice.billingMonth,
                    amount,
                    payMethod,
                    note: 'RentPayment record created retrospectively by repair script',
                },
            }).catch(() => { }); // non-blocking

            console.log(`   ✅  Created RentPayment: ${transactionId} | ₹${amount} | ${payMethod}`);
            repaired++;

        } catch (err) {
            console.error(`   ❌  Failed for invoice ${invoice.invoiceNumber}:`, err.message);
            failed++;
        }
    }

    console.log('\n─────────────────────────────────────────────');
    console.log(`✅  Repair complete.`);
    console.log(`   Repaired : ${repaired}`);
    console.log(`   Skipped  : ${skipped} (already had payment records)`);
    console.log(`   Failed   : ${failed}`);
    console.log('─────────────────────────────────────────────\n');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
