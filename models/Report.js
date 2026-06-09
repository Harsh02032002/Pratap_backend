const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true, index: true },
    reportName: { type: String, required: true },
    category: { type: String, default: '' },
    format: { type: String, enum: ['PDF', 'Excel', 'CSV'], default: 'CSV' },
    generatedBy: { type: String, default: '' },
    recordCount: { type: Number, default: 0 },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['Pending', 'Completed', 'Failed'], default: 'Completed' },
    fileUrl: { type: String, default: '' },
    generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Report', reportSchema);
