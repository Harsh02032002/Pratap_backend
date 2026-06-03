const express = require('express');
const router = express.Router();
const visitController = require('../controllers/visitController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Submit Report (Area Manager)
router.post('/submit', protect, visitController.submitVisit);

// Get My Reports (Area Manager)
router.get('/', protect, visitController.getMyVisits);

// Get All Pending Reports (Super Admin - Enquiry Page)
// Note: We use 'protect' and 'authorize' to ensure only Super Admin can see this
router.get('/pending', protect, authorize('superadmin'), visitController.getPendingVisits);

// Get Approved Properties for Website (Public - No Auth Required)
// Used by ourproperty.html to display live properties
router.get('/public/approved', visitController.getApprovedPropertiesForWebsite);

module.exports = router;