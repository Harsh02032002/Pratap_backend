const mongoose = require('mongoose');

const LedgerEntrySchema = new mongoose.Schema({
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    tenantLoginId: { type: String, required: true },
    ownerLoginId: { type: String, required: true },
    date: { type: Date, default: Date.now },
    details: { type: String, required: true },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }
});

module.exports = mongoose.models.LedgerEntry || mongoose.model('LedgerEntry', LedgerEntrySchema);
