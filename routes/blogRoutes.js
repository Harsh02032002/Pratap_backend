const express = require('express');
const router = express.Router();
const Blog = require('../models/Blog');
const { protect, authorize } = require('../middleware/authMiddleware');
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function uploadToCloudinary(buffer, folder = 'roomhy/blogs') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    stream.end(buffer);
  });
}

// ─── PUBLIC ROUTES ─────────────────────────────────────────────────────────────

// GET /api/blogs - list published blogs (public, for website)
router.get('/', async (req, res) => {
  try {
    const { status = 'published', category, featured, limit = 20, page = 1, q } = req.query;
    const filter = {};
    if (status !== 'all') filter.status = status;
    if (category) filter.category = category;
    if (featured === 'true') filter.featured = true;
    if (q) filter.$or = [{ title: new RegExp(q, 'i') }, { excerpt: new RegExp(q, 'i') }, { tags: q }];

    const skip = (Number(page) - 1) * Number(limit);
    const [blogs, total] = await Promise.all([
      Blog.find(filter).sort({ publishedAt: -1, createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Blog.countDocuments(filter),
    ]);
    res.json({ success: true, data: blogs, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/blogs/:slug - single blog by slug (public)
router.get('/:slug', async (req, res) => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug }).lean();
    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found' });
    // Increment view count
    Blog.findByIdAndUpdate(blog._id, { $inc: { views: 1 } }).exec();
    res.json({ success: true, data: blog });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN ROUTES ──────────────────────────────────────────────────────────────

// GET /api/blogs/admin/all - all blogs (admin panel)
router.get('/admin/all', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { status, category, q, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (category) filter.category = category;
    if (q) filter.$or = [{ title: new RegExp(q, 'i') }, { author: new RegExp(q, 'i') }];

    const skip = (Number(page) - 1) * Number(limit);
    const [blogs, total] = await Promise.all([
      Blog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Blog.countDocuments(filter),
    ]);
    res.json({ success: true, data: blogs, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/blogs - create blog with optional image upload
router.post('/', protect, authorize('superadmin', 'admin'), upload.single('coverImage'), async (req, res) => {
  try {
    const { title, excerpt, content, author, category, tags, status, featured, metaTitle, metaDescription, readTime } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });

    let slug = slugify(title);
    // Ensure unique slug
    const existing = await Blog.findOne({ slug });
    if (existing) slug = `${slug}-${Date.now()}`;

    let coverImage = req.body.coverImageUrl || '';
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      coverImage = result.secure_url;
    }

    const blog = new Blog({
      title, slug, excerpt: excerpt || '', content: content || '',
      coverImage, author: author || 'Roomhy Team',
      category: category || 'General',
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
      status: status || 'draft',
      featured: featured === 'true' || featured === true,
      metaTitle: metaTitle || title,
      metaDescription: metaDescription || excerpt || '',
      readTime: Number(readTime) || 5,
      publishedAt: (status === 'published') ? new Date() : null,
      createdBy: req.user?.loginId || req.user?.email || 'superadmin',
    });

    await blog.save();
    res.status(201).json({ success: true, data: blog });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/blogs/:id - update blog
router.put('/:id', protect, authorize('superadmin', 'admin'), upload.single('coverImage'), async (req, res) => {
  try {
    const { id } = req.params;
    const update = { ...req.body };

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      update.coverImage = result.secure_url;
    }
    if (update.tags && typeof update.tags === 'string') {
      update.tags = update.tags.split(',').map(t => t.trim());
    }
    if (update.featured !== undefined) update.featured = update.featured === 'true' || update.featured === true;
    if (update.status === 'published' && !update.publishedAt) {
      update.publishedAt = new Date();
    }

    const blog = await Blog.findByIdAndUpdate(id, update, { new: true });
    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found' });
    res.json({ success: true, data: blog });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/blogs/:id
router.delete('/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found' });
    res.json({ success: true, message: 'Blog deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/blogs/upload-image - standalone image upload for blog editor
router.post('/upload-image', protect, authorize('superadmin', 'admin'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const result = await uploadToCloudinary(req.file.buffer);
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
