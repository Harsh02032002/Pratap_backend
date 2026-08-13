const express = require('express');
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit per file
});

// POST /api/upload-profile-photo
router.post('/upload-profile-photo', optionalProtect, upload.single('profilePhoto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', message: 'No file uploaded' });
    }
    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload_stream({
      folder: 'profile_photos',
      resource_type: 'image',
    }, (error, result) => {
      if (error) return res.status(500).json({ error: error.message, message: error.message });
      return res.json({ url: result.secure_url, secure_url: result.secure_url });
    });
    // Pipe the buffer to Cloudinary
    result.end(req.file.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message, message: err.message });
  }
});

// POST /api/upload - Generic image/video upload
router.post('/upload', optionalProtect, (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error('Upload multer error:', err);
      return res.status(400).json({ error: err.message || 'File upload failed', message: err.message || 'File upload failed' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const file = (req.files && req.files.length > 0) ? req.files[0] : req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded', message: 'No file uploaded' });
    }
    const stream = cloudinary.uploader.upload_stream({
      folder: 'roomhy/rooms',
      resource_type: 'auto',
    }, (error, result) => {
      if (error) {
        console.error('Cloudinary upload error:', error);
        return res.status(500).json({ error: error.message || 'Cloudinary upload error', message: error.message || 'Cloudinary upload error' });
      }
      return res.json({ url: result.secure_url, secure_url: result.secure_url, filePath: result.secure_url, location: result.secure_url });
    });
    stream.end(file.buffer);
  } catch (err) {
    console.error('Upload handler error:', err);
    res.status(500).json({ error: err.message, message: err.message });
  }
});

// POST /api/upload-file - Support PDF, Word, etc.
router.post('/upload-file', optionalProtect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded', message: 'No file uploaded' });
    }
    const result = await cloudinary.uploader.upload_stream({
      folder: 'roomhy/chat_files',
      resource_type: 'auto', 
    }, (error, result) => {
      if (error) return res.status(500).json({ error: error.message, message: error.message });
      return res.json({ 
        url: result.secure_url,
        secure_url: result.secure_url,
        format: result.format,
        original_name: req.file.originalname
      });
    });
    result.end(req.file.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message, message: err.message });
  }
});

module.exports = router;

