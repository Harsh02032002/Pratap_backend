const express = require('express');
const multer = require('multer');
const cloudinary = require('../utils/cloudinary');
const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage });

// POST /api/upload-profile-photo
router.post('/upload-profile-photo', upload.single('profilePhoto'), async (req, res) => {
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
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const stream = cloudinary.uploader.upload_stream({
      folder: 'roomhy/rooms',
      resource_type: 'auto',
    }, (error, result) => {
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ url: result.secure_url });
    });
    stream.end(req.file.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload-file - Support PDF, Word, etc.
router.post('/upload-file', upload.single('file'), async (req, res) => {
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
