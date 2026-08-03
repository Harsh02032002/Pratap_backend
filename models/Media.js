const mongoose = require('mongoose');

const MediaSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    originalName: { type: String, default: '', trim: true },
    url: { type: String, required: true }, // Cloudinary secure_url
    publicId: { type: String, default: '' }, // Cloudinary public_id for deletion
    resourceType: { type: String, enum: ['image', 'video', 'raw', 'auto'], default: 'image' },
    format: { type: String, default: '' }, // jpg, png, mp4, pdf, etc.
    size: { type: Number, default: 0 }, // bytes
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    folder: { type: String, default: 'roomhy/media', trim: true }, // Cloudinary folder
    altText: { type: String, default: '', trim: true },
    caption: { type: String, default: '', trim: true },
    tags: [{ type: String, trim: true }],
    usedIn: [{ type: String }], // Which pages/sections use this media
    uploadedBy: { type: String, default: 'superadmin' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Media || mongoose.model('Media', MediaSchema);
