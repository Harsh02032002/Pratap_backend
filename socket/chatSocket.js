const ChatMessage = require('../models/ChatMessage');

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
    socket.on('join_room', (data) => {
      const { login_id, role, name, aliases } = data;

      if (!login_id) {
        socket.emit('error', { message: 'login_id required' });
        return;
      }

      // Join room with loginId
      socket.join(login_id);
      const aliasRooms = normalizeAliases(aliases, login_id);
      aliasRooms.forEach((alias) => socket.join(alias));
      socket.userLogin = login_id;
      socket.userRole = role;
      socket.userName = name;
      socket.userAliases = aliasRooms;

      // Track user connection
      userSockets.set(login_id, socket.id);

      console.log(
        `✓ User joined: ${name} (${role}) - Room: ${login_id}` +
        (aliasRooms.length ? ` | Aliases: ${aliasRooms.join(', ')}` : '')
      );
      socket.emit('joined', { message: 'Successfully joined chat' });
    });

    /**
     * EVENT: send_message
     * User sends message to another user's room
     */
    socket.on('send_message', async (data) => {
      try {
        const { to_login_id, message } = data;
        const from_login_id = socket.userLogin;

        if (!from_login_id) {
          socket.emit('error', { message: 'Not joined to any room' });
          return;
        }

        if (!to_login_id || !message || message.trim().length === 0) {
          socket.emit('error', { message: 'Invalid message data' });
          return;
        }

        // Save message to database
        // room_id = receiver's loginId (to_login_id)
        const msg = new ChatMessage({
          room_id: to_login_id,
          sender_login_id: from_login_id,
          sender_name: socket.userName,
          sender_role: socket.userRole,
          message: message.trim(),
          message_type: 'text',
          created_at: new Date(),
          updated_at: new Date()
        });

        await msg.save();

        console.log(`✓ Message saved: ${from_login_id} -> ${to_login_id}`);

        // Emit to receiver's room
        io.to(to_login_id).emit('receive_message', {
          _id: msg._id,
          sender_login_id: from_login_id,
          sender_name: socket.userName,
          message: message.trim(),
          created_at: msg.created_at
        });

        // Confirm to sender
        socket.emit('message_sent', { success: true, id: msg._id });

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
