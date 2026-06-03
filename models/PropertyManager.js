const mongoose = require('mongoose');

const PropertyManagerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  loginId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  ownerLoginId: { type: String, required: true },
  assignedProperty: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Property', 
    required: true 
  },
  permissions: {
    canViewTenants: { type: Boolean, default: true },
    canAddTenants: { type: Boolean, default: true },
    canCollectRent: { type: Boolean, default: true },
    canViewReports: { type: Boolean, default: true },
    canManageComplaints: { type: Boolean, default: true },
    canManageRooms: { type: Boolean, default: true }
  },
  status: { 
    type: String, 
    enum: ['active', 'inactive'], 
    default: 'active' 
  },
  requirePasswordReset: {
    type: Boolean,
    default: false
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('PropertyManager', PropertyManagerSchema);
