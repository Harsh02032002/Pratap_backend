const express = require('express');
const router = express.Router();
const announcementController = require('../controllers/announcementController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/owner/:ownerLoginId', protect, authorize('tenant', 'owner', 'superadmin', 'areamanager', 'employee', 'manager'), announcementController.getAnnouncementsByOwner);
router.post('/', protect, authorize('superadmin', 'areamanager', 'owner'), announcementController.createAnnouncement);
router.delete('/:id', protect, authorize('superadmin', 'areamanager', 'owner'), announcementController.deleteAnnouncement);

// Broadcast announcements to all tenants of an owner
router.post('/broadcast', protect, authorize('superadmin', 'areamanager', 'owner'), announcementController.broadcastAnnouncement);

module.exports = router;
