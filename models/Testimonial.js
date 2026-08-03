const mongoose = require('mongoose');

const TestimonialSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    role: { type: String, default: 'Student', trim: true }, // e.g. "IIT Delhi Student"
    text: { type: String, required: true },
    avatar: { type: String, default: '' }, // Cloudinary URL
    rating: { type: Number, default: 5, min: 1, max: 5 },
    city: { type: String, default: '', trim: true },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    order: { type: Number, default: 0 },
    createdBy: { type: String, default: 'superadmin' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Testimonial || mongoose.model('Testimonial', TestimonialSchema);
