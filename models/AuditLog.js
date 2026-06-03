const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
    {
        actorId: { type: String, default: '' },
        actorRole: { type: String, default: '' },
        actorEmail: { type: String, default: '' },
        module: { type: String, required: true },
        action: { type: String, required: true },
        method: { type: String, required: true },
        path: { type: String, required: true },
        statusCode: { type: Number, default: 0 },
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
        payload: { type: mongoose.Schema.Types.Mixed, default: {} },
        createdAt: { type: Date, default: Date.now }
    },
    { versionKey: false }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorRole: 1, createdAt: -1 });
auditLogSchema.index({ module: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
