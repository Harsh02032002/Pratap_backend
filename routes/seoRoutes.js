const express = require('express');
const router = express.Router();
const seoController = require('../controllers/seoController');
const SeoRedirect = require('../models/SeoRedirect');
const { protect, authorize } = require('../middleware/authMiddleware');

// Resolved metadata endpoint (used by client-side hooks, SSR, sitemaps, etc.)
router.get('/metadata', seoController.getSeoMetadata);

// ─── SEO Pages CRUD ────────────────────────────────────────────────────────────
router.get('/pages', seoController.getPages);
router.post('/pages/register', protect, authorize('superadmin', 'admin'), seoController.registerPage);
router.put('/pages/:pageKey', protect, authorize('superadmin', 'admin'), seoController.updatePageByKey);
router.delete('/pages/:pageKey', protect, authorize('superadmin', 'admin'), seoController.deletePageByKey);

// ─── Redirects CRUD ────────────────────────────────────────────────────────────
// GET all redirects (admin panel)
router.get('/redirects', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { q, limit = 100, page = 1 } = req.query;
    const filter = {};
    if (q) filter.$or = [{ oldUrl: new RegExp(q, 'i') }, { newUrl: new RegExp(q, 'i') }];
    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      SeoRedirect.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      SeoRedirect.countDocuments(filter),
    ]);
    res.json({ success: true, data: items, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST redirect
router.post('/redirects', protect, authorize('superadmin', 'admin'), seoController.createRedirect);

// PUT update redirect
router.put('/redirects/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const { oldUrl, newUrl, statusCode } = req.body;
    const item = await SeoRedirect.findByIdAndUpdate(req.params.id, { oldUrl, newUrl, statusCode }, { new: true });
    if (!item) return res.status(404).json({ success: false, message: 'Redirect not found' });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE redirect
router.delete('/redirects/:id', protect, authorize('superadmin', 'admin'), async (req, res) => {
  try {
    const item = await SeoRedirect.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Redirect not found' });
    res.json({ success: true, message: 'Redirect deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
