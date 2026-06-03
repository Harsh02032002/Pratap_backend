const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const ChatRoom = require('../models/ChatRoom');
const ChatMessage = require('../models/ChatMessage');
const chatRoutes = require('../routes/chatRoutes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// MongoDB Atlas Connection
const MONGODB_URI = process.env.MONGODB_URI || 'your_mongodb_atlas_uri_here';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Routes
app.use('/api/chat', chatRoutes);

// Socket.io Logic
io.on('connection', (socket) => {
    console.log('🔌 User Connected:', socket.id);

    // Join Room
    socket.on('join_room', async (data) => {
        const { room_id, login_id, role } = data;
        socket.join(room_id);
        console.log(`👤 ${login_id} (${role}) joined room: ${room_id}`);
        
        // Super Admins automatically join all rooms (logic handled on frontend via API load)
    });

    // Handle Sending Message
    socket.on('send_message', async (data) => {
        const { room_id, sender_id, sender_role, sender_name, message } = data;

        try {
            // Save to Database
            const newMessage = await ChatMessage.create({
                room_id,
                sender_login_id: sender_id,
                sender_role,
                sender_name,
                message,
                created_at: new Date()
            });

            // Update Room Last Message
            await ChatRoom.findOneAndUpdate(
                { room_id },
                { 
                    last_message: message, 
                    updated_at: new Date(),
                    $set: { is_active: true }
                }
            );

            // Emit to Room
            io.to(room_id).emit('message_received', newMessage);
        } catch (error) {
            console.error('❌ Socket Message Error:', error);
        }
    });

    // Handle Escalation
    socket.on('escalate_room', async (data) => {
        const { room_id, level, reason } = data;
        
        try {
            const room = await ChatRoom.findOneAndUpdate(
                { room_id },
                { escalation_level: level },
                { new: true }
            );

            io.to(room_id).emit('room_escalated', {
                room_id,
                escalation_level: level,
                message: `Chat escalated to level ${level}: ${reason}`
            });
        } catch (error) {
            console.error('❌ Escalation Error:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 User Disconnected');
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));