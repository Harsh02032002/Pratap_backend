/**
 * Shared onboarding utilities — extracted from rentController.js to avoid
 * circular dependencies when tenantController needs receipt/owner helpers.
 */
const Owner = require('../models/Owner');

/**
 * Build a receipt data object from Rent + optional RentInvoice documents.
 * Pure data — no DB writes, no I/O.
 */
function buildOnboardingReceipt({ rent, invoice, paidAt }) {
    const paymentDate = paidAt || rent?.paymentDate || new Date();
    const amount = Number(invoice?.totalDue || rent?.totalDue || rent?.rentAmount || 0);
    const receiptNumber = `RCPT-${String(rent?._id || invoice?._id || 'CASH')
        .slice(-6)
        .toUpperCase()}-${String(Date.now()).slice(-6)}`;

    return {
        receiptNumber,
        paymentMethod: rent?.paymentMethod || 'cash',
        status: 'PAID',
        amount,
        tenantName: rent?.tenantName || '',
        tenantPhone: rent?.tenantPhone || '',
        tenantEmail: rent?.tenantEmail || '',
        propertyName: rent?.propertyName || '',
        roomNumber: rent?.roomNumber || '',
        collectionMonth: rent?.collectionMonth || invoice?.billingMonth || '',
        ownerLoginId: rent?.ownerLoginId || '',
        invoiceId: invoice?._id ? String(invoice._id) : '',
        rentId: rent?._id ? String(rent._id) : '',
        paidAt: paymentDate.toISOString(),
        verifiedAt: paymentDate.toISOString(),
        billingMonth: invoice?.billingMonth || rent?.collectionMonth || '',
        totalDue: Number(invoice?.totalDue || rent?.totalDue || amount),
        totalPenalty: Number(invoice?.totalPenalty || 0),
        rentAmount: Number(invoice?.rentAmount || rent?.rentAmount || amount),
    };
}

/**
 * Resolve the owner's email address from their loginId string.
 */
async function resolveOwnerEmail(ownerLoginId) {
    const ownerId = String(ownerLoginId || '').trim().toUpperCase();
    if (!ownerId) return '';
    const owner = await Owner.findOne({ loginId: ownerId })
        .select('email profile.email')
        .lean();
    return (owner && (owner.email || owner.profile?.email)) || '';
}

module.exports = { buildOnboardingReceipt, resolveOwnerEmail };
