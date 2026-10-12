const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

// Most of this router was unauthenticated. The consequences were:
//   GET  /                     read any user's notifications via ?toLoginId=
//   POST /                     write a notification into anyone's feed
//   POST /register-fcm-token   bind a push device to any loginId
//   POST /send-fcm-push        send a push notification to anyone
//   POST /email, /email/test   send mail through the platform's mailer
//   /website/*                 read and delete any website user's feed
// Every frontend caller is a panel page (owner, superadmin, employee) that
// already sends a token; the /website/* and /superadmin/* and /owner/* notify
// endpoints have no frontend caller at all. Per-recipient scoping is handled
// in the controllers (and by '/me' for the self-scoped read).
router.use(protect);

// Authenticated, self-scoped, paginated notifications for the logged-in user.
// Recipient is derived from the JWT (never trusted from the query string).
// Defined before the legacy '/' handler; kept separate for backward compatibility.
router.get('/me', protect, notificationController.getMyNotifications);

// Existing routes
router.get('/', notificationController.getNotifications);
router.post('/', notificationController.createNotification);
router.put('/:id/read', protect, notificationController.markRead);
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
// Get unread count — protected so callers can only check their own scope
router.get('/unread-count', protect, notificationController.getUnreadCount);
// Mark all as read — protected + requires toLoginId in body (see N-6 fix)
router.put('/mark-all-read', protect, notificationController.markAllRead);
// ==================== FCM PUSH NOTIFICATIONS ====================
router.post('/register-fcm-token', notificationController.registerFcmToken);
router.post('/send-fcm-push', notificationController.sendFcmPush);

module.exports = router;
