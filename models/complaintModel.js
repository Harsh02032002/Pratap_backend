const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
  tenantId: { type: String, required: true },
  ownerId: { type: String, required: true },
  propertyId: { type: String },
  subject: { type: String, required: true },
  description: { type: String, required: true },
  status: { type: String, enum: ['pending', 'in_progress', 'resolved'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Complaint', complaintSchema);
