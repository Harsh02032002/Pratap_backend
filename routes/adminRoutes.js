const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const agoraController = require('../controllers/agoraController');
const recordingController = require('../controllers/recordingController');
const notificationController = require('../controllers/notificationController');
const VisitReport = require('../models/VisitReport'); // Ensure model is imported
const AuditLog = require('../models/AuditLog');
const { protect, authorize } = require('../middleware/authMiddleware');
const { auditTrail } = require('../middleware/auditTrail');

// Route to fetch visits (used by Enquiry page)
router.get('/visits', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { status } = req.query;
        const filter = status ? { status } : {};
        const visits = await VisitReport.find(filter).populate('areaManager', 'name');
        res.json(visits);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route to approve visit
router.post('/approve-visit/:id', protect, authorize('superadmin', 'areamanager'), auditTrail('admin'), adminController.approveVisit);

// Route to reject visit
router.post('/reject-visit/:id', protect, authorize('superadmin', 'areamanager'), auditTrail('admin'), adminController.rejectVisit);

// Dashboard stats
router.get('/stats', protect, authorize('superadmin', 'areamanager'), adminController.getStats);

// Import localStorage JSON -> MongoDB (protected). Accepts x-import-secret header OR superadmin auth
router.post('/import-local', protect, authorize('superadmin'), auditTrail('admin'), adminController.importLocalData);

// Admin: Create a user (employee) - Super Admin only
router.post('/users', protect, authorize('superadmin'), auditTrail('admin'), adminController.createUser);

// Admin: Update a user by loginId - Super Admin only
router.patch('/users/:loginId', protect, authorize('superadmin'), auditTrail('admin'), adminController.updateUser);

// Upload recordings (meeting blobs). Protected route.
router.post('/recordings', protect, authorize('superadmin','areamanager'), auditTrail('admin'), recordingController.uploadRecording);

// Agora token endpoint (authenticated)
router.post('/agora/token', protect, agoraController.getToken);

// Notifications: create (managers) and list (superadmin)
router.post('/notifications', protect, authorize('superadmin', 'areamanager'), auditTrail('notifications'), notificationController.createNotification);
router.get('/notifications', protect, authorize('superadmin'), notificationController.getNotifications);
router.post('/notifications/:id/read', protect, authorize('superadmin'), auditTrail('notifications'), notificationController.markRead);
router.get('/audit-logs', protect, authorize('superadmin'), async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit || 200), 1000);
        const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit).lean();
        res.json({ success: true, count: logs.length, logs });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to load audit logs', error: error.message });
    }
});

module.exports = router;
