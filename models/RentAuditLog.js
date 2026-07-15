'use strict';
// Business-event audit log for rent collection.
// Separate from the existing AuditLog.js (which logs HTTP requests).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ACTIONS = [
  'INVOICE_CREATED',
  'PAYMENT_RECORDED',
  'PENALTY_APPLIED',
  'PENALTY_WAIVED',
  'PHASE_TRANSITION',
  'NOTIFICATION_SENT',
  'NOTIFICATION_FAILED',
  'CONTACT_INFO_MISSING', // reminder skipped — tenant has no email/phone on file
  'CONFIG_CREATED',
  'CONFIG_UPDATED',
  'INVOICE_CANCELLED',
  'CASH_REQUESTED',
  'CASH_APPROVED',
  'OTP_GENERATED',
  'OTP_SENT',
  'CASH_VERIFIED',
  'CASH_REJECTED',
];

const rentAuditLogSchema = new Schema({
  action:     { type: String, enum: ACTIONS, required: true, index: true },
  invoiceId:  { type: Schema.Types.ObjectId, ref: 'RentInvoice' },
  tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant' },
  ownerId:    { type: Schema.Types.ObjectId, ref: 'Owner',    index: true },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property' },

  performedBy: String,
  meta:        Schema.Types.Mixed,

  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'rent_audit_logs',
});

// Single TTL index — 90 days. Do NOT also set `expires` on the field or Mongoose warns about duplicate index.
rentAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
rentAuditLogSchema.index({ invoiceId: 1, action: 1 });

module.exports = mongoose.model('RentAuditLog', rentAuditLogSchema);
