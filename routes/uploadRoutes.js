const express = require('express');
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const router = express.Router();

const storage = multer.memoryStorage();
// 15MB cap — matches the size Cloudinary's plain upload_stream API rejects
// past 10MB; uploads under this limit are sent via upload_chunked_stream
// below, which uploads in parts and isn't subject to that 10MB ceiling.
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

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
      if (err.code === 'LIMIT_FILE_SIZE') {
        const msg = 'File is too large. Maximum allowed size is 15MB.';
        return res.status(400).json({ error: msg, message: msg });
      }
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
    // upload_chunked_stream (not upload_stream) — Cloudinary's plain upload
    // API rejects anything over 10MB regardless of our own limits; chunked
    // upload sends the file in parts and isn't subject to that ceiling.
    // Same (options, callback) argument order and (error, result) callback
    // as upload_stream — the SDK's v2 wrapper normalizes it that way even
    // though the raw internal function takes (callback, options).
    const stream = cloudinary.uploader.upload_chunked_stream({
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

