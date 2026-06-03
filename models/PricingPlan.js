const mongoose = require('mongoose');

const PricingPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true },
    billingCycle: { 
      type: String, 
      enum: ['monthly', 'quarterly', 'yearly'], 
      default: 'monthly' 
    },
    features: [{ type: String }],
    maxProperties: { type: Number, default: 1 },
    maxPhotos: { type: Number, default: 10 },
    prioritySupport: { type: Boolean, default: false },
    analytics: { type: Boolean, default: false },
    customBranding: { type: Boolean, default: false },
    isPopular: { type: Boolean, default: false },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    createdBy: { type: String, default: 'superadmin' },
    lastModifiedBy: { type: String, default: 'superadmin' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.PricingPlan || mongoose.model('PricingPlan', PricingPlanSchema);
