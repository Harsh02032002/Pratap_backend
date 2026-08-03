const express = require('express');
const router = express.Router();
const Testimonial = require('../models/Testimonial');
const { protect, authorize } = require('../middleware/authMiddleware');
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

async function uploadToCloudinary(buffer, folder = 'roomhy/testimonials') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    stream.end(buffer);
  });
}

// GET /api/testimonials - public list (for website)
router.get('/', async (req, res) => {
  try {
    const { featured, limit = 20 } = req.query;
    const filter = { status: 'active' };
    if (featured === 'true') filter.featured = true;
    const items = await Testimonial.find(filter).sort({ order: 1, createdAt: -1 }).limit(Number(limit)).lean();
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/testimonials/admin/all - all testimonials (admin panel)
router.get('/admin/all', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { status, q } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (q) filter.$or = [{ name: new RegExp(q, 'i') }, { role: new RegExp(q, 'i') }, { city: new RegExp(q, 'i') }];
    const items = await Testimonial.find(filter).sort({ order: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/testimonials
router.post('/', protect, authorize('superadmin', 'admin'), upload.single('avatar'), async (req, res) => {
  try {
    const { name, role, text, rating, city, featured, status, order } = req.body;
    if (!name || !text) return res.status(400).json({ success: false, message: 'Name and text are required' });

    let avatar = req.body.avatarUrl || '';
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      avatar = result.secure_url;
    }

    const item = new Testimonial({
      name, role: role || 'Student', text, avatar,
      rating: Number(rating) || 5,
      city: city || '', featured: featured === 'true' || featured === true,
      status: status || 'active', order: Number(order) || 0,
      createdBy: req.user?.loginId || req.user?.email || 'superadmin',
    });
    await item.save();
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/testimonials/:id
router.put('/:id', protect, authorize('superadmin', 'admin'), upload.single('avatar'), async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      update.avatar = result.secure_url;
    }
    if (update.featured !== undefined) update.featured = update.featured === 'true' || update.featured === true;
    if (update.rating) update.rating = Number(update.rating);
    if (update.order) update.order = Number(update.order);

    const item = await Testimonial.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Testimonial not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/testimonials/:id
router.delete('/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const item = await Testimonial.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Testimonial not found' });
    res.json({ success: true, message: 'Testimonial deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
