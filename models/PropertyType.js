const mongoose = require('mongoose');

const PropertyTypeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, unique: true, trim: true },
    category: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    images: [{ type: String, required: true }],
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    createdBy: { type: String, default: 'superadmin' },
    lastModifiedBy: { type: String, default: 'superadmin' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('PropertyType', PropertyTypeSchema);
