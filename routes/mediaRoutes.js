const express = require('express');
const router = express.Router();
const Media = require('../models/Media');
const { protect, authorize } = require('../middleware/authMiddleware');
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// ─── HELPERS ────────────────────────────────────────────────────────────────────

async function uploadToCloudinary(file, folder = 'roomhy/media') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'auto', use_filename: true, unique_filename: false },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    stream.end(file.buffer);
  });
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────────

// GET /api/media - list all media (admin)
router.get('/', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { folder, resourceType, q, limit = 50, page = 1, tags } = req.query;
    const filter = {};
    if (folder) filter.folder = new RegExp(folder, 'i');
    if (resourceType) filter.resourceType = resourceType;
    if (tags) filter.tags = tags;
    if (q) filter.$or = [
      { filename: new RegExp(q, 'i') },
      { originalName: new RegExp(q, 'i') },
      { altText: new RegExp(q, 'i') },
      { caption: new RegExp(q, 'i') },
    ];

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Media.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Media.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/media/upload - Upload single or multiple files
router.post('/upload', protect, authorize('superadmin', 'admin'), upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ success: false, message: 'No files uploaded' });

    const folder = req.body.folder || 'roomhy/media';
    const tags = req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : [];
    const uploadedBy = req.user?.loginId || req.user?.email || 'superadmin';

    const results = await Promise.all(files.map(async (file) => {
      const result = await uploadToCloudinary(file, folder);
      const media = new Media({
        filename: result.public_id.split('/').pop() || file.originalname,
        originalName: file.originalname,
        url: result.secure_url,
        publicId: result.public_id,
        resourceType: result.resource_type || 'image',
        format: result.format || '',
        size: file.size,
        width: result.width || 0,
        height: result.height || 0,
        folder,
        tags,
        uploadedBy,
      });
      await media.save();
      return media;
    }));

    res.status(201).json({ success: true, data: results, urls: results.map(r => r.url) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/media/upload-single - quick single upload, returns just url
router.post('/upload-single', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const folder = req.body.folder || 'roomhy/media';
    const result = await uploadToCloudinary(req.file, folder);
    res.json({ success: true, url: result.secure_url, publicId: result.public_id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/media/:id - update metadata (altText, caption, tags)
router.patch('/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { altText, caption, tags, usedIn } = req.body;
    const update = {};
    if (altText !== undefined) update.altText = altText;
    if (caption !== undefined) update.caption = caption;
    if (tags !== undefined) update.tags = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
    if (usedIn !== undefined) update.usedIn = Array.isArray(usedIn) ? usedIn : [usedIn];

    const item = await Media.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Media not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/media/:id - delete from DB (and optionally Cloudinary)
router.delete('/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const item = await Media.findById(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Media not found' });

    // Optionally delete from Cloudinary too
    if (item.publicId && req.query.deleteFromCloud !== 'false') {
      try {
        await cloudinary.uploader.destroy(item.publicId, { resource_type: item.resourceType || 'image' });
      } catch (e) {
        console.warn('Cloudinary delete failed:', e.message);
      }
    }

    await Media.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Media deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/media/bulk - delete multiple
router.delete('/bulk', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, message: 'ids array required' });
    await Media.deleteMany({ _id: { $in: ids } });
    res.json({ success: true, message: `${ids.length} items deleted` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
