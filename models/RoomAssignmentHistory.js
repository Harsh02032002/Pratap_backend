'use strict';
// Historical record of which room/rent applied to a tenant over time.
// Written at onboarding (one open-ended row) and at transfer (closes the old
// row, opens a new one). Billing code resolves "what applied during month X"
// from here instead of the tenant's current room/rent, so a later transfer
// can never change what an earlier billing period looked like.
//
// Boundary convention: effectiveFrom is inclusive, effectiveTo is exclusive.
// effectiveTo === null means "current, open-ended".
const mongoose = require('mongoose');
const { Schema } = mongoose;

const roomAssignmentHistorySchema = new Schema({
  // No field-level `index: true` here — the compound {tenantId,effectiveFrom}
  // index below already serves tenantId-prefixed lookups, and a second,
  // separately-declared plain index would auto-generate the SAME default
  // name ("tenantId_1") as this schema's own indexes, causing Mongo to
  // reject whichever one is created second (IndexOptionsConflict, code 86) —
  // exactly what happened with the unique index below before this fix; it
  // was silently never created.
  tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  roomId:     { type: Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
  roomNo:     { type: String, required: true },
  bedNo:      { type: String },
  agreedRent: { type: Number, required: true },

  effectiveFrom: { type: Date, required: true },
  effectiveTo:   { type: Date, default: null },

  reason:      { type: String, enum: ['onboarding', 'transfer'], required: true },
  performedBy: String,

  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'room_assignment_history',
});

roomAssignmentHistorySchema.index({ tenantId: 1, effectiveFrom: 1 });
roomAssignmentHistorySchema.index({ roomId: 1, effectiveFrom: 1 });
// DB-level guard against two concurrent transfer requests for the same
// tenant both closing the same "open" row and each inserting their own new
// open row — a race the application-level close-then-open in
// roomAssignmentService can't fully prevent on its own. At most one
// effectiveTo:null row per tenant, enforced by Mongo, not just by app logic.
roomAssignmentHistorySchema.index(
  { tenantId: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: null }, name: 'one_open_assignment_per_tenant' }
);

module.exports = mongoose.models.RoomAssignmentHistory
  || mongoose.model('RoomAssignmentHistory', roomAssignmentHistorySchema);
