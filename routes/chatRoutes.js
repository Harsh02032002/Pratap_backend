const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const chatManagementController = require('../controllers/chatManagementController');
const ChatRoom = require('../models/ChatRoom');
const ChatMessage = require('../models/ChatMessage');
const { chatLimiter } = require('../middleware/security');
const { protect, authorize } = require('../middleware/authMiddleware');

function normalizeWebsiteUserId(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (/^roomhyweb\d{6}$/i.test(value)) return value;
    const digits = value.replace(/\D/g, '').slice(-6);
    if (digits.length === 6) return `roomhyweb${digits}`;
    return '';
}

function generateWebsiteUserIdFromEmail(email) {
    const safeEmail = String(email || '').trim().toLowerCase();
    if (!safeEmail) return '';
    let hash = 0;
    for (let i = 0; i < safeEmail.length; i += 1) {
        hash = (hash * 31 + safeEmail.charCodeAt(i)) % 1000000;
    }
    return `roomhyweb${String(hash).padStart(6, '0')}`;
}

async function ensureParticipantRoom(roomId, participants) {
    if (!roomId) return null;
    const normalizedParticipants = (participants || []).filter((participant) => participant && participant.loginId);
    return ChatRoom.findOneAndUpdate(
        { room_id: roomId },
        {
            $set: {
                updated_at: new Date(),
                participants: normalizedParticipants
            },
            $setOnInsert: {
                room_id: roomId,
                created_at: new Date()
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
}

router.post('/create', async (req, res) => {
    try {
        const {
            bookingId,
            userName,
            userEmail,
            userLoginId,
            ownerId,
            ownerName,
            propertyName
        } = req.body;

        const normalizedOwnerId = String(ownerId || '').trim().toUpperCase();
        const normalizedUserId = generateWebsiteUserIdFromEmail(userEmail) || normalizeWebsiteUserId(userLoginId);

        if (!bookingId || !normalizedOwnerId || !normalizedUserId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: bookingId, ownerId, userLoginId'
            });
        }

        const participants = [
            { loginId: normalizedOwnerId, role: 'property_owner' },
            { loginId: normalizedUserId, role: 'website_user' }
        ];

        const [ownerRoom, userRoom] = await Promise.all([
            ensureParticipantRoom(normalizedOwnerId, participants),
            ensureParticipantRoom(normalizedUserId, participants)
        ]);

        const existingWelcome = await ChatMessage.findOne({
            room_id: normalizedOwnerId,
            sender_login_id: 'system',
            message: { $regex: String(bookingId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
        }).lean();

        if (!existingWelcome) {
            const intro = `Chat opened for ${propertyName || 'property'} between ${ownerName || normalizedOwnerId} and ${userName || userEmail || normalizedUserId} (booking ${bookingId})`;
            await Promise.all([
                ChatMessage.create({
                    room_id: normalizedOwnerId,
                    sender_login_id: 'system',
                    sender_name: 'System',
                    sender_role: 'superadmin',
                    message: intro,
                    created_at: new Date(),
                    updated_at: new Date()
                }),
                ChatMessage.create({
                    room_id: normalizedUserId,
                    sender_login_id: 'system',
                    sender_name: 'System',
                    sender_role: 'superadmin',
                    message: intro,
                    created_at: new Date(),
                    updated_at: new Date()
                })
            ]);
        }

        return res.status(201).json({
            success: true,
            message: 'Chat room created successfully',
            data: {
                bookingId,
                ownerRoomId: ownerRoom?.room_id || normalizedOwnerId,
                userRoomId: userRoom?.room_id || normalizedUserId,
                ownerId: normalizedOwnerId,
                userLoginId: normalizedUserId,
                userName,
                ownerName,
                propertyName
            }
        });
    } catch (error) {
        console.error('Error creating chat room:', error);
        return res.status(500).json({
            success: false,
            message: 'Error creating chat room',
            error: error.message
        });
    }
});

const { applyEmployeeScope } = require('../middleware/employeeScope');

router.get('/inbox/:login_id', protect, chatController.getInbox);
router.get('/all-chats', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, chatController.getAllChats);
router.get('/messages/:room_id', protect, chatController.getMessages);
router.get('/conversation', protect, chatController.getConversation);
router.post('/mark-read/:room_id', protect, chatLimiter, chatController.markAsRead);
router.post('/send', protect, chatLimiter, chatController.sendMessage);
router.get('/unread/:room_id', protect, chatController.getUnreadCount);
router.delete('/message/:message_id', protect, chatController.deleteMessage);
router.delete('/delete-conversation', protect, chatController.deleteConversation);

// ─── ADMIN CHAT MANAGEMENT ───────────────────────────────────────────────

// Moderation
router.get('/admin/moderation', protect, authorize('superadmin'), chatManagementController.getFlaggedMessages);
router.put('/admin/moderation/:id/resolve', protect, authorize('superadmin'), chatManagementController.resolveFlaggedMessage);
router.get('/admin/moderation/:id/decrypt', protect, authorize('superadmin'), chatManagementController.decryptMessage);

// Templates
router.get('/admin/templates', protect, authorize('superadmin'), chatManagementController.getTemplates);
router.post('/admin/templates', protect, authorize('superadmin'), chatManagementController.createTemplate);
router.put('/admin/templates/:id', protect, authorize('superadmin'), chatManagementController.updateTemplate);
router.delete('/admin/templates/:id', protect, authorize('superadmin'), chatManagementController.deleteTemplate);

// Settings
router.get('/admin/settings', protect, authorize('superadmin'), chatManagementController.getSettings);
router.post('/admin/settings', protect, authorize('superadmin'), chatManagementController.updateSettings);

// Lead → Chat Funnel
router.get('/admin/funnel', protect, authorize('superadmin'), chatManagementController.getFunnel);
router.get('/admin/leads', protect, authorize('superadmin'), chatManagementController.getLeadMappings);
router.post('/admin/leads/map', protect, authorize('superadmin'), chatManagementController.mapLead);

// Violations
router.get('/admin/violations', protect, authorize('superadmin'), chatManagementController.getViolations);
router.post('/admin/violations/:id/resolve', protect, authorize('superadmin'), chatManagementController.resolveViolation);
router.post('/admin/violations/:id/action', protect, authorize('superadmin'), chatManagementController.adminActionOnViolation);

// Blocked Owners
router.get('/admin/blocked-owners', protect, authorize('superadmin'), chatManagementController.getBlockedOwners);
router.post('/admin/blocked-owners/:loginId/unblock', protect, authorize('superadmin'), chatManagementController.unblockOwner);
router.get('/admin/booking-tracker', protect, authorize('superadmin'), chatManagementController.getBookingTracker);

// Analytics
router.get('/admin/analytics', protect, authorize('superadmin'), chatManagementController.getAnalytics);
router.get('/admin/stagnant', protect, authorize('superadmin'), chatManagementController.getStagnantChats);

// Dispute Resolution
router.get('/admin/disputes', protect, authorize('superadmin'), chatManagementController.getDisputes);
router.post('/admin/disputes', protect, authorize('superadmin'), chatManagementController.createDispute);
router.put('/admin/disputes/:id', protect, authorize('superadmin'), chatManagementController.updateDispute);

module.exports = router;

