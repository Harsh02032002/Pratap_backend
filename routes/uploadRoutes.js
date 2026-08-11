const express = require('express');
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

const storage = multer.memoryStorage();
// 15MB cap — matches the size Cloudinary's plain upload_stream API rejects
// past 10MB; uploads under this limit are sent via upload_chunked_stream
// below, which uploads in parts and isn't subject to that 10MB ceiling.
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

// POST /api/upload-profile-photo
router.post('/upload-profile-photo', protect, upload.single('profilePhoto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload_stream({
      folder: 'profile_photos',
      resource_type: 'image',
    }, (error, result) => {
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ url: result.secure_url });
    });
    // Pipe the buffer to Cloudinary
    result.end(req.file.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload - Generic image/video upload
router.post('/upload', protect, (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error('Upload multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File is too large. Maximum allowed size is 15MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const file = (req.files && req.files.length > 0) ? req.files[0] : req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
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
      if (error) return res.status(500).json({ error: error.message || String(error) });
      return res.json({ url: result.secure_url, filePath: result.secure_url, location: result.secure_url });
    });
    stream.end(file.buffer);
  } catch (err) {
    console.error('Upload handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload-file - Support PDF, Word, etc.
// Requires a valid JWT so anonymous callers cannot push files to Cloudinary.
router.post('/upload-file', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const result = await cloudinary.uploader.upload_stream({
      folder: 'roomhy/chat_files',
      resource_type: 'auto', 
    }, (error, result) => {
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ 
        url: result.secure_url,
        format: result.format,
        original_name: req.file.originalname
      });
    });
    result.end(req.file.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
