'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const penaltyHistorySchema = new Schema({
  phase: { type: Number, required: true },
  type: { type: String, enum: ['minor', 'major'] },
  amount: { type: Number, required: true },
  appliedAt: { type: Date, default: Date.now },
  daysSinceDue: { type: Number },
  note: String,
}, { _id: false });

const phaseHistorySchema = new Schema({
  phase: { type: Number, required: true },
  enteredAt: { type: Date, default: Date.now },
  daysSinceDue: { type: Number },
}, { _id: false });

const waiverSchema = new Schema({
  waivedAmount: Number,
  reason: String,
  waivedBy: String,
  waivedAt: Date,
}, { _id: false });

const rentInvoiceSchema = new Schema({
  invoiceNumber: { type: String, unique: true, required: true },

  ownerId: { type: Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  unitId: { type: Schema.Types.ObjectId },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  tenantName: { type: String, default: '' },
  tenantEmail: { type: String, default: '' },
  tenantPhone: { type: String, default: '' },

  billingMonth: { type: String, required: true }, // "YYYY-MM"

  rentAmount: { type: Number, required: true },
  dueDate: { type: Date, required: true },  // SOURCE OF TRUTH for all phase logic

  // Electricity bill (populated when owner submits meter reading)
  electricityBill: { type: Number, default: 0 },
  electricityUnitsConsumed: { type: Number, default: 0 },
  electricityPrevReading: { type: Number, default: 0 },
  electricityCurrReading: { type: Number, default: 0 },
  electricityReadingAdded: { type: Boolean, default: false },
  electricitySplitCount: { type: Number, default: 1 },   // how many tenants share this room's bill
  electricityTotalBill: { type: Number, default: 0 },   // original total bill before splitting

  minorPenaltyAmount: { type: Number, default: 0 },
  majorPenaltyAmount: { type: Number, default: 0 },
  totalPenalty: { type: Number, default: 0 },
  totalDue: { type: Number, default: 0 },
  paidAmount: { type: Number, default: 0 }, // total collected (rent + penalty) — display only
  rentPaidAmount: { type: Number, default: 0 }, // rent-only tracker — used for penalty calculation
  penaltyPaidAmount: { type: Number, default: 0 }, // penalty-only tracker
  outstandingAmount: { type: Number, default: 0 },

  currentPhase: { type: Number, default: 1 },
  daysSinceDue: { type: Number, default: 0 },

  penaltyHistory: [penaltyHistorySchema],
  phaseHistory: [phaseHistorySchema],

  status: {
    type: String,
    enum: ['PENDING', 'PARTIAL', 'PAID', 'WAIVED', 'CANCELLED'],
    default: 'PENDING',
    index: true,
  },

  waiver: waiverSchema,

  penaltyConfigSnapshot: Schema.Types.Mixed,
  lastEvaluatedAt: Date,

  notes: String,
}, {
  timestamps: true,
  collection: 'rent_invoices',
});

rentInvoiceSchema.index({ dueDate: 1, status: 1 });        // primary cron query
rentInvoiceSchema.index({ ownerId: 1, billingMonth: 1 });
rentInvoiceSchema.index({ tenantId: 1, status: 1 });
rentInvoiceSchema.index({ propertyId: 1, billingMonth: 1 });
// Prevents duplicate invoices for same tenant+month even under concurrent cron/API calls
rentInvoiceSchema.index({ tenantId: 1, billingMonth: 1 }, { unique: true });

module.exports = mongoose.model('RentInvoice', rentInvoiceSchema);
