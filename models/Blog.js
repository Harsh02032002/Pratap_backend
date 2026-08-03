const mongoose = require('mongoose');

const BlogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    excerpt: { type: String, default: '', trim: true },
    content: { type: String, default: '' }, // HTML/Markdown body
    coverImage: { type: String, default: '' }, // Cloudinary URL
    author: { type: String, default: 'Roomhy Team', trim: true },
    authorAvatar: { type: String, default: '' },
    category: { type: String, default: 'General', trim: true },
    tags: [{ type: String, trim: true }],
    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
    featured: { type: Boolean, default: false },
    readTime: { type: Number, default: 5 }, // minutes
    views: { type: Number, default: 0 },
    // SEO fields
    metaTitle: { type: String, default: '' },
    metaDescription: { type: String, default: '' },
    publishedAt: { type: Date, default: null },
    createdBy: { type: String, default: 'superadmin' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Blog || mongoose.model('Blog', BlogSchema);
