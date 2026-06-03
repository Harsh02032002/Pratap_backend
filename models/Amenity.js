const mongoose = require('mongoose');

const AmenitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    icon: { type: String, default: 'check' },
    category: { 
      type: String, 
      enum: ['basic', 'comfort', 'luxury', 'safety', 'other'], 
      default: 'basic' 
    },
    description: { type: String, default: '' },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    createdBy: { type: String, default: 'superadmin' },
    lastModifiedBy: { type: String, default: 'superadmin' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Amenity || mongoose.model('Amenity', AmenitySchema);
