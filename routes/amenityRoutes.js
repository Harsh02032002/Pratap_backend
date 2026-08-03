const express = require('express');
const router = express.Router();
const Amenity = require('../models/Amenity');
const { protect, authorize } = require('../middleware/authMiddleware');
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Get all amenities
router.get('/', async (req, res) => {
  try {
    const { status, category } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    
    const amenities = await Amenity.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: amenities });
  } catch (error) {
    console.error('Error fetching amenities:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch amenities' });
  }
});

// Create amenity (with optional SVG/image icon upload)
router.post('/', protect, authorize('superadmin', 'admin'), upload.single('iconFile'), async (req, res) => {
  try {
    const { name, icon, iconSvg, category, description, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    
    const existing = await Amenity.findOne({ name: { $regex: new RegExp(name, 'i') } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Amenity already exists' });
    }

    let resolvedIconSvg = iconSvg || '';
    // Upload SVG/image icon to Cloudinary if file provided
    if (req.file) {
      await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'roomhy/amenity-icons', resource_type: 'image', format: 'svg' },
          (err, result) => {
            if (err) { console.warn('Icon upload failed:', err.message); resolve(); }
            else { resolvedIconSvg = result.secure_url; resolve(); }
          }
        );
        stream.end(req.file.buffer);
      });
    }
    
    const amenity = new Amenity({
      name,
      icon: icon || 'check',
      iconSvg: resolvedIconSvg,
      category: category || 'basic',
      description: description || '',
      status: status || 'Active'
    });
    
    await amenity.save();
    res.status(201).json({ success: true, data: amenity });
  } catch (error) {
    console.error('Error creating amenity:', error);
    res.status(500).json({ success: false, message: 'Failed to create amenity' });
  }
});

// Update amenity (with optional SVG/image icon upload)
router.put('/:id', protect, authorize('superadmin', 'admin'), upload.single('iconFile'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, icon, iconSvg, category, description, status } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (icon) updateData.icon = icon;
    if (iconSvg !== undefined) updateData.iconSvg = iconSvg;
    if (category) updateData.category = category;
    if (description !== undefined) updateData.description = description;
    if (status) updateData.status = status;

    // Upload new icon if file provided
    if (req.file) {
      await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'roomhy/amenity-icons', resource_type: 'image' },
          (err, result) => {
            if (err) { console.warn('Icon upload failed:', err.message); resolve(); }
            else { updateData.iconSvg = result.secure_url; resolve(); }
          }
        );
        stream.end(req.file.buffer);
      });
    }
    
    const amenity = await Amenity.findByIdAndUpdate(id, updateData, { new: true });
    
    if (!amenity) {
      return res.status(404).json({ success: false, message: 'Amenity not found' });
    }
    
    res.json({ success: true, data: amenity });
  } catch (error) {
    console.error('Error updating amenity:', error);
    res.status(500).json({ success: false, message: 'Failed to update amenity' });
  }
});

// PATCH /:id/toggle - toggle active/inactive status
router.patch('/:id/toggle', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const amenity = await Amenity.findById(req.params.id);
    if (!amenity) return res.status(404).json({ success: false, message: 'Amenity not found' });
    amenity.status = amenity.status === 'Active' ? 'Inactive' : 'Active';
    await amenity.save();
    res.json({ success: true, data: amenity });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle amenity status' });
  }
});

// Delete amenity
router.delete('/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const amenity = await Amenity.findByIdAndDelete(id);
    
    if (!amenity) {
      return res.status(404).json({ success: false, message: 'Amenity not found' });
    }
    
    res.json({ success: true, message: 'Amenity deleted successfully' });
  } catch (error) {
    console.error('Error deleting amenity:', error);
    res.status(500).json({ success: false, message: 'Failed to delete amenity' });
  }
});

// POST /api/amenities/upload-icon - standalone icon upload
router.post('/upload-icon', protect, authorize('superadmin', 'admin'), upload.single('icon'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'roomhy/amenity-icons', resource_type: 'image' },
        (err, result) => {
          if (err) reject(err);
          else { res.json({ success: true, url: result.secure_url }); resolve(); }
        }
      );
      stream.end(req.file.buffer);
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Icon upload failed' });
  }
});

module.exports = router;

