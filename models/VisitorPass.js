const mongoose = require('mongoose');

const visitorPassSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
  guestName: { type: String, required: true },
  guestPhone: { type: String, required: true },
  expectedDate: { type: Date, required: true },
  passCode: { type: String, required: true, unique: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Checked-in', 'Checked-out', 'Expired'], default: 'Approved' }
}, { timestamps: true });

module.exports = mongoose.model('VisitorPass', visitorPassSchema);
