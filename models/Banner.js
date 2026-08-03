const mongoose = require('mongoose');

const BannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: '', trim: true },
    image: { type: String, default: '' }, // Cloudinary URL - desktop
    imageMobile: { type: String, default: '' }, // Cloudinary URL - mobile
    linkUrl: { type: String, default: '', trim: true }, // Click destination
    linkText: { type: String, default: 'Learn More', trim: true },
    placement: { 
      type: String, 
      enum: ['home-hero', 'home-middle', 'listing-top', 'listing-sidebar', 'city-page', 'popup', 'custom'], 
      default: 'home-hero' 
    },
    targetPages: [{ type: String }], // Array of page slugs/paths where banner shows
    bgColor: { type: String, default: '' }, // Fallback color if no image
    textColor: { type: String, default: '#ffffff' },
    status: { type: String, enum: ['active', 'inactive', 'scheduled'], default: 'active' },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    order: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    createdBy: { type: String, default: 'superadmin' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
