const ChatRoom = require('./models/ChatRoom');
const ChatMessage = require('./models/ChatMessage');

module.exports = (io) => {
    io.on('connection', (socket) => {
        console.log('🔌 User connected:', socket.id);

        // Join a room based on loginId
        socket.on('join_room', (data) => {
            const { room_id } = data;
            socket.join(room_id);
            console.log(`👤 User joined room: ${room_id}`);
        });

        // Send and store message
        socket.on('send_message', async (data) => {
            const { room_id, sender_id, sender_role, message } = data;

            try {
                // 1. Save to MongoDB
                const newMessage = await ChatMessage.create({
                    room_id,
                    sender_id,
                    sender_role,
                    message,
                    created_at: new Date()
                });

                // 2. Update the Room's last activity
                await ChatRoom.findOneAndUpdate(
                    { room_id },
                    {
                        last_message: message,
                        last_message_sender_id: sender_id,
                        last_message_time: new Date(),
                        updated_at: new Date()
                    },
                    { upsert: true }
                );

                // 3. Emit real-time to the specific room
                // Both sender and receiver are in this room
                io.to(room_id).emit('message_received', newMessage);
                
                // 4. Special: Notify Superadmin room if needed
                io.to('superadmin_monitor').emit('new_global_message', newMessage);

            } catch (error) {
                console.error('❌ Socket Error:', error);
            }
        });

        socket.on('disconnect', () => {
            console.log('🔌 User disconnected');
        });
    });
};