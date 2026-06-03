const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');

// Existing routes
router.get('/', notificationController.getNotifications);
router.post('/', notificationController.createNotification);
router.put('/:id/read', notificationController.markRead);
router.post('/chat-message', notificationController.sendChatMessageNotification);

// Website user notifications
router.get('/website/user/:userId', notificationController.getWebsiteUserNotifications);
router.post('/website/create', notificationController.createWebsiteNotification);
router.put('/website/:notificationId/read', notificationController.markWebsiteNotificationRead);
router.delete('/website/:notificationId', notificationController.deleteWebsiteNotification);

// For booking accept notifications
router.post('/booking-accept', notificationController.sendBookingAcceptNotification);

// Email notifications for Owner Panel
router.post('/email', notificationController.sendEmailNotification);
router.post('/email/test', notificationController.testEmailNotification);

// ==================== SUPERADMIN NOTIFICATIONS ====================
// New booking notification
router.post('/superadmin/new-booking', notificationController.sendSuperAdminNewBookingNotification);
// New enquiry notification
router.post('/superadmin/new-enquiry', notificationController.sendSuperAdminNewEnquiryNotification);

// ==================== PROPERTY OWNER NOTIFICATIONS ====================
// New booking request notification
router.post('/owner/new-booking-request', notificationController.sendOwnerNewBookingRequestNotification);
// New chat notification
router.post('/owner/new-chat', notificationController.sendOwnerNewChatNotification);
// New bidding notification
router.post('/owner/new-bidding', notificationController.sendOwnerNewBiddingNotification);

// ==================== UTILITY ROUTES ====================
// Get unread count
router.get('/unread-count', notificationController.getUnreadCount);
// Mark all as read
router.put('/mark-all-read', notificationController.markAllRead);
// Delete read notifications
router.delete('/delete-read', notificationController.deleteReadNotifications);


module.exports = router;
