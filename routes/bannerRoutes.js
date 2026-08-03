const express = require('express');
const router = express.Router();
const Banner = require('../models/Banner');
const { protect, authorize } = require('../middleware/authMiddleware');
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function uploadToCloudinary(buffer, folder = 'roomhy/banners') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    stream.end(buffer);
  });
}

// GET /api/banners - public (for website)
router.get('/', async (req, res) => {
  try {
    const { placement, page: pagePath } = req.query;
    const now = new Date();
    const filter = {
      status: 'active',
      $or: [{ startDate: null }, { startDate: { $lte: now } }],
      $and: [{ $or: [{ endDate: null }, { endDate: { $gte: now } }] }]
    };
    if (placement) filter.placement = placement;
    if (pagePath) filter.$or = [{ targetPages: { $size: 0 } }, { targetPages: pagePath }];

    const banners = await Banner.find(filter).sort({ order: 1 }).lean();
    res.json({ success: true, data: banners });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/banners/admin/all - all banners (admin panel)
router.get('/admin/all', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { status, placement, q } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (placement && placement !== 'all') filter.placement = placement;
    if (q) filter.title = new RegExp(q, 'i');
    const items = await Banner.find(filter).sort({ order: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/banners - create with optional image upload
router.post('/', protect, authorize('superadmin', 'admin'), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'imageMobile', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, subtitle, linkUrl, linkText, placement, targetPages, bgColor, textColor, status, startDate, endDate, order } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });

    let image = req.body.imageUrl || '';
    let imageMobile = req.body.imageMobileUrl || '';

    if (req.files?.image?.[0]) {
      const result = await uploadToCloudinary(req.files.image[0].buffer);
      image = result.secure_url;
    }
    if (req.files?.imageMobile?.[0]) {
      const result = await uploadToCloudinary(req.files.imageMobile[0].buffer, 'roomhy/banners/mobile');
      imageMobile = result.secure_url;
    }

    const banner = new Banner({
      title, subtitle: subtitle || '', image, imageMobile,
      linkUrl: linkUrl || '', linkText: linkText || 'Learn More',
      placement: placement || 'home-hero',
      targetPages: targetPages ? (Array.isArray(targetPages) ? targetPages : [targetPages]) : [],
      bgColor: bgColor || '', textColor: textColor || '#ffffff',
      status: status || 'active',
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      order: Number(order) || 0,
      createdBy: req.user?.loginId || req.user?.email || 'superadmin',
    });

    await banner.save();
    res.status(201).json({ success: true, data: banner });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/banners/:id
router.put('/:id', protect, authorize('superadmin', 'admin'), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'imageMobile', maxCount: 1 }]), async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.files?.image?.[0]) {
      const result = await uploadToCloudinary(req.files.image[0].buffer);
      update.image = result.secure_url;
    }
    if (req.files?.imageMobile?.[0]) {
      const result = await uploadToCloudinary(req.files.imageMobile[0].buffer, 'roomhy/banners/mobile');
      update.imageMobile = result.secure_url;
    }
    if (update.targetPages && typeof update.targetPages === 'string') {
      update.targetPages = [update.targetPages];
    }
    if (update.order) update.order = Number(update.order);
    if (update.startDate) update.startDate = new Date(update.startDate);
    if (update.endDate) update.endDate = new Date(update.endDate);

    const item = await Banner.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Banner not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/banners/:id
router.delete('/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const item = await Banner.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Banner not found' });
    res.json({ success: true, message: 'Banner deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/banners/:id/track-click - increment click count
router.patch('/:id/track-click', async (req, res) => {
  try {
    await Banner.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
