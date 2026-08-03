const express = require('express');
const router = express.Router();
const pageLayoutController = require('../controllers/pageLayoutController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Get layout (Public - so website can load sections)
router.get('/:pageKey', pageLayoutController.getPageLayout);

// Update layout (Superadmin / Admin)
router.put('/:pageKey', protect, authorize('superadmin', 'admin'), pageLayoutController.updatePageLayout);

module.exports = router;
