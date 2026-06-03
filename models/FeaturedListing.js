const mongoose = require('mongoose');

const FeaturedListingSchema = new mongoose.Schema(
  {
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    propertyTitle: { type: String, required: true },
    propertyImage: { type: String, default: '' },
    city: { type: String, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    position: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    paymentAmount: { type: Number, default: 0 },
    paymentStatus: { 
      type: String, 
      enum: ['pending', 'paid', 'expired', 'cancelled'], 
      default: 'pending' 
    },
    notes: { type: String, default: '' },
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    createdBy: { type: String, default: 'superadmin' },
    lastModifiedBy: { type: String, default: 'superadmin' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.FeaturedListing || mongoose.model('FeaturedListing', FeaturedListingSchema);
