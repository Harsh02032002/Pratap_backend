const mongoose = require('mongoose');

const EnquirySchema = new mongoose.Schema({
  ownerLoginId: { type: String, required: true },
  propertyId: { type: String },
  propertyName: { type: String },
  studentId: { type: String },
  studentName: { type: String },
  studentEmail: { type: String },
  studentPhone: { type: String },
  location: { type: String },
  status: { type: String, default: 'pending' },
  paidAmount: { type: Number, default: 0 },
  chatOpen: { type: Boolean, default: false },
  visitAllowed: { type: Boolean, default: false },
  ts: { type: Date, default: Date.now },
  source: { type: String, default: 'Website' },
  interest: { type: String },
  budget: { type: String },
  notes: { type: String, default: '' },
  nextFollowup: { type: String },
  assignedStaff: { type: String },
  visitTime: { type: String }
});

module.exports = mongoose.model('Enquiry', EnquirySchema);
