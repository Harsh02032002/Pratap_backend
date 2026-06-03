const mongoose = require('mongoose');

const PropertyEnquirySchema = new mongoose.Schema({
  enquiryId: { type: String, required: true, unique: true, index: true },
  type: { type: String, default: 'property_from_visit' },
  submittedAt: { type: Date, default: Date.now },
  submittedBy: { type: String },
  submittedById: { type: String },
  visitId: { type: String },
  visitArea: { type: String },
  propertyName: { type: String },
  propertyType: { type: String },
  amenities: [{ type: String }],
  rules: {
    visitorsAllowed: { type: String, default: 'Yes' },
    cookingAllowed: { type: String, default: 'Yes' },
    smokingAllowed: { type: String, default: 'No' },
    petsAllowed: { type: String, default: 'No' },
    entryExit: { type: String }
  },
  images: [{ type: String }],
  ownerName: { type: String },
  ownerEmail: { type: String },
  ownerPhone: { type: String },
  address: { type: String },
  city: { type: String },
  area: { type: String },
  gender: { type: String },
  monthlyRent: { type: Number },
  deposit: { type: String },
  roomCount: { type: Number },
  bedCount: { type: Number },
  vacantRooms: { type: Number },
  vacantBeds: { type: Number },
  occupiedRooms: { type: Number },
  occupiedBeds: { type: Number },
  pendingCredentials: {
    loginId: { type: String },
    password: { type: String },
    role: { type: String, default: 'owner' }
  },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  approvedAt: { type: Date },
  approvedBy: { type: String },
  credentialsSent: { type: Boolean, default: false },
  generatedCredentials: {
    loginId: { type: String },
    tempPassword: { type: String }
  },
  rejectReason: { type: String },
  rejectedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('PropertyEnquiry', PropertyEnquirySchema);
