const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const ChatRoom = require('../models/ChatRoom');
const ChatMessage = require('../models/ChatMessage');

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

router.get('/inbox/:login_id', chatController.getInbox);
router.get('/all-chats', chatController.getAllChats);
router.get('/messages/:room_id', chatController.getMessages);
router.get('/conversation', chatController.getConversation);
router.post('/mark-read/:room_id', chatController.markAsRead);
router.post('/send', chatController.sendMessage);
router.get('/unread/:room_id', chatController.getUnreadCount);
router.delete('/message/:message_id', chatController.deleteMessage);
router.delete('/delete-conversation', chatController.deleteConversation);

module.exports = router;
