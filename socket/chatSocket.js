const ChatMessage = require('../models/ChatMessage');
const { canonicalChatId } = require('../utils/chatIdentity');

/**
 * SOCKET.IO CHAT HANDLERS
 * 
 * Room structure: room_id = receiver's loginId
 * 
 * User connections:
 * - When user opens chat page, they join their own room (loginId)
 * - To send message to user B, sender joins user B's room
 * - Message is stored with room_id = receiver's loginId
 * - Receiver gets real-time notification via Socket.IO
 */

module.exports = (io) => {
  const userSockets = new Map(); // loginId -> socketId
  const normalizeAliases = (aliases, primaryLoginId) => {
    if (!Array.isArray(aliases)) return [];

    const seen = new Set([String(primaryLoginId || '').trim()]);

    return aliases
      .map((alias) => String(alias || '').trim())
      .filter((alias) => {
        if (!alias || seen.has(alias)) return false;
        seen.add(alias);
        return true;
      });
  };

  io.on('connection', (socket) => {
    console.log(`✓ Socket connected: ${socket.id}`);

    /**
     * EVENT: join_room
     * User joins their own room to receive messages
     */
    socket.on('join_room', () => {
      // THE PAYLOAD IS IGNORED. It used to supply login_id, role and name, which
      // meant any client could join any user's room and then send messages as
      // them with any role. Identity now comes from socket.data.auth, which
      // socket/socketAuth.js derived from the account record during the
      // authenticated handshake.
      const auth = socket.data?.auth;
      if (!auth || !auth.loginId) {
        socket.emit('error', { message: 'Not authorized' });
        socket.disconnect(true);
        return;
      }

      const login_id = auth.loginId;

      socket.join(login_id);
      // Always also join the canonical form of this id, plus every other form
      // this account is addressed by. A website user whose stored loginId is
      // their email joins "harsh@example.com" while every backend creation path
      // addresses them as "roomhyweb541955" — joining both means neither side
      // has to know which form the other used. These are computed server-side
      // from the account (socketAuth.identityFor), not accepted from the client.
      const aliasRooms = normalizeAliases(
        [...(auth.rooms || []), auth.chatId, canonicalChatId(login_id)],
        login_id
      );
      aliasRooms.forEach((alias) => socket.join(alias));
      socket.userLogin = login_id;
      socket.userRole = auth.role;
      socket.userName = auth.name;
      socket.userAliases = aliasRooms;

      // Track user connection
      userSockets.set(login_id, socket.id);

      console.log(
        `✓ User joined: ${auth.name} (${auth.role}) - Room: ${login_id}` +
        (aliasRooms.length ? ` | Aliases: ${aliasRooms.length} alias room(s)` : '')
      );
      // Echo the authorized identity back so the client can reconcile whatever
      // it thought it was.
      socket.emit('joined', {
        message: 'Successfully joined chat',
        login_id,
        role: auth.role,
        name: auth.name
      });
    });

    /**
     * EVENT: send_message
     * User sends message to another user's room
     */
    socket.on('send_message', async (data) => {
      try {
        const { to_login_id, message_type, file_url } = data;
        let message = data.message;
        const from_login_id = socket.userLogin;

        if (!from_login_id) {
          socket.emit('error', { message: 'Not joined to any room' });
          return;
        }

        if (!to_login_id || (!message && !file_url)) {
          socket.emit('error', { message: 'Invalid message data' });
          return;
        }

        if (!message) {
          message = message_type === 'image' ? 'Sent an image' : 'Shared a file';
        }

        const { checkUserBlockStatus, isOwnerTenantChat, detectViolation, logViolation } = require('../utils/moderationHelper');
        const ChatSettings = require('../models/ChatSettings');

        // 1. Check user restriction
        const blockCheck = await checkUserBlockStatus(from_login_id);
        if (blockCheck.blocked) {
          socket.emit('error', { message: blockCheck.reason });
          return;
        }

        const originalText = String(message).trim();

        // 🔒 Phone Number & Contact Masking: detect & mask phone numbers, emails, spaced numbers & chunks
        const { maskPhoneNumbers, maskPreviousConsecutiveMessage } = require('../utils/maskPhoneNumbers');
        const maskedText = maskPhoneNumbers(originalText);
        await maskPreviousConsecutiveMessage(ChatMessage, to_login_id, from_login_id, originalText);

        // Save message to database immediately
        const msg = new ChatMessage({
          room_id: to_login_id,
          sender_login_id: from_login_id,
          sender_name: socket.userName,
          sender_role: socket.userRole,
          message: maskedText,
          message_type: message_type || 'text',
          file_url: file_url || undefined,
          is_blocked: false,
          created_at: new Date(),
          updated_at: new Date()
        });

        await msg.save();

        console.log(`✓ Message saved: ${from_login_id} -> ${to_login_id}`);

        const basePayload = {
          _id: msg._id,
          sender_login_id: from_login_id,
          sender_name: socket.userName,
          message: msg.message,
          message_type: msg.message_type,
          file_url: msg.file_url,
          created_at: msg.created_at
        };

        // Emit to receiver's room. Rooms are exact strings and one website user
        // can be joined under either their email or their email hash, so the
        // equivalent room is included — otherwise the push silently went
        // nowhere and the recipient had to reload to see the message.
        const receiverRooms = new Set(
          [to_login_id, canonicalChatId(to_login_id)]
            .map((id) => String(id || '').trim())
            .filter(Boolean)
        );
        for (const room of receiverRooms) {
          io.to(room).emit('receive_message', { ...basePayload, room_id: room });
        }

        // Emit to sender's own room so the sender's UI updates in real-time
        const senderRooms = new Set(
          [from_login_id, canonicalChatId(from_login_id)]
            .map((id) => String(id || '').trim())
            .filter((id) => id && !receiverRooms.has(id))
        );
        for (const room of senderRooms) {
          io.to(room).emit('receive_message', { ...basePayload, room_id: room });
        }

        // Confirm to sender
        socket.emit('message_sent', { success: true, id: msg._id });

        // 📱 Send instant FCM Push Notification to recipient device (laptop/phone)
        if (from_login_id !== 'system') {
          try {
            const fcmService = require('../services/fcmService');
            fcmService.sendToUser(to_login_id, {
              title: `💬 New message from ${senderName || 'Roomhy User'}`,
              body: String(maskedText || '').substring(0, 150),
              icon: '/pwa-192x192.png',
              clickAction: '/website/chat',
              data: {
                type: 'chat_message',
                senderId: from_login_id
              }
            }).catch(() => {});
          } catch (_) {}
        }

        // Run AI & Regex moderation on all non-system 1:1 messages
        if (from_login_id !== 'system') {
          const { moderateChatMessageAsync } = require('../utils/moderationHelper');
          moderateChatMessageAsync(msg, to_login_id).catch(err => {
            console.error('Error running async moderation (Socket):', err.message);
          });
        }

      } catch (error) {
        console.error('❌ Error sending message:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    /**
     * EVENT: typing
     * User is typing indicator
     */
    socket.on('typing', (data) => {
      const { to_login_id, typing } = data;
      if (typing) {
        io.to(to_login_id).emit('user_typing', {
          from: socket.userLogin,
          name: socket.userName
        });
      }
    });

    /**
     * EVENT: disconnect
     */
    socket.on('disconnect', () => {
      if (socket.userLogin) {
        userSockets.delete(socket.userLogin);
        console.log(`✗ User disconnected: ${socket.userLogin}`);
      }
    });
  });
};
