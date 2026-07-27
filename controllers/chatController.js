const ChatMessage = require('../models/ChatMessage');
const ChatRoom = require('../models/ChatRoom');
const WebsiteEnquiry = require('../models/WebsiteEnquiry');
const Owner = require('../models/Owner');
const User = require('../models/user');
const BookingRequest = require('../models/BookingRequest');
const jwt = require('jsonwebtoken');

const normalizeLoginId = (value) => String(value || '').trim();

function generateWebsiteUserIdFromEmail(email) {
    const safeEmail = String(email || '').trim().toLowerCase();
    if (!safeEmail) return '';
    let hash = 0;
    for (let i = 0; i < safeEmail.length; i += 1) {
        hash = (hash * 31 + safeEmail.charCodeAt(i)) % 1000000;
    }
    return `roomhyweb${String(hash).padStart(6, '0')}`;
}

async function isCallerSuperadmin(req) {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return false;
    if (token === 'superadmin_token') return true;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const user = await User.findById(decoded.id).select('role').lean();
        return user?.role === 'superadmin' || user?.role === 'admin';
    } catch (err) {
        return false;
    }
}

// Get inbox summary for a specific login id
exports.getInbox = async (req, res) => {
  try {
    const loginId = normalizeLoginId(req.params.login_id);
    // IDOR protection: only allow callers to get their own inbox unless they are superadmin
    if (req.user.role !== 'superadmin' && String(req.user.loginId || '').toUpperCase() !== String(loginId).toUpperCase()) {
        return res.status(403).json({ error: 'Forbidden: You cannot access other users\' inbox' });
    }
    const searchQuery = String(req.query.search || '').trim().toLowerCase();

    if (!loginId) {
      return res.status(400).json({ error: 'login_id is required' });
    }

    const loginVariants = [...new Set([loginId, loginId.toLowerCase(), loginId.toUpperCase()])];

    const messages = await ChatMessage.find({
      $or: [
        { room_id: { $in: loginVariants } },
        { sender_login_id: { $in: loginVariants } }
      ],
      is_blocked: { $ne: true }
    })
      .sort({ created_at: -1 })
      .limit(1000)
      .lean();

    const summaryMap = new Map();

    for (const msg of messages) {
      const sender = normalizeLoginId(msg.sender_login_id);
      const receiver = normalizeLoginId(msg.room_id);
      const isOutgoing = loginVariants.includes(sender);
      const partnerId = isOutgoing ? receiver : sender;

      if (!partnerId || partnerId.toLowerCase() === 'system') continue;

      const existing = summaryMap.get(partnerId) || {
        participant_login_id: partnerId,
        participant_name: '',
        last_message: '',
        last_message_at: null,
        last_sender_login_id: '',
        unread_count: 0
      };

      if (!existing.last_message_at) {
        existing.last_message = msg.message || '';
        existing.last_message_at = msg.created_at;
        existing.last_sender_login_id = sender;
      }

      // Keep searching for a name if we only have the ID so far
      if (!isOutgoing && msg.sender_name && (!existing.participant_name || existing.participant_name === partnerId)) {
        existing.participant_name = msg.sender_name;
      }

      // Default name to partnerId if still empty
      if (!existing.participant_name) {
        existing.participant_name = partnerId;
      }

      if (!isOutgoing && !msg.is_read && loginVariants.includes(receiver)) {
        existing.unread_count += 1;
      }

      summaryMap.set(partnerId, existing);
    }

    // Enhance participants with real details from multiple sources
    const websiteEnquiries = await WebsiteEnquiry.find({}).lean();
    const owners = await Owner.find({}).lean();
    const bookings = await BookingRequest.find({}).lean();
    const users = await User.find({}).lean();

    for (const item of summaryMap.values()) {
        const pid = item.participant_login_id;
        const currentName = item.participant_name || "";
        
        // 1. Try matching by Email Hash (Strongest)
        let match = websiteEnquiries.find(enq => 
            enq.owner_email && generateWebsiteUserIdFromEmail(enq.owner_email) === pid
        );

        // 2. Try matching by Login ID directly
        if (!match) {
            match = owners.find(o => o.loginId === pid);
        }

        // Try to match with BookingRequest (Website tenant)
        let bookingMatch = null;
        if (!match) {
            bookingMatch = bookings.find(b => {
                const genId = generateWebsiteUserIdFromEmail(b.email);
                return (genId && genId === pid) || b.user_id === pid || b.email === pid;
            });
        }

        // Try to match with User directly
        let userMatch = null;
        if (!match && !bookingMatch) {
            userMatch = users.find(u => {
                const genId = generateWebsiteUserIdFromEmail(u.email);
                return (genId && genId === pid) || u.loginId === pid || u.email === pid;
            });
        }

        // 3. Try matching by NAME (Fuzzy match for website users)
        if (!match && !bookingMatch && !userMatch && currentName && currentName !== pid) {
            const searchName = currentName.toLowerCase().trim();
            match = websiteEnquiries.find(enq => (enq.owner_name || "").toLowerCase().trim() === searchName) ||
                    owners.find(o => (o.name || "").toLowerCase().trim() === searchName);
        }

        if (match) {
            // Update name only if it's currently a loginId
            if (!item.participant_name || item.participant_name === pid) {
                item.participant_name = match.owner_name || match.name || item.participant_name;
            }
            item.participant_email = match.owner_email || match.email || item.participant_email;
            item.participant_phone = match.owner_phone || match.phone || item.participant_phone;
            item.participant_property = match.property_name || item.participant_property;
            item.participant_city = match.city || item.participant_city;
        } else if (bookingMatch) {
            if (!item.participant_name || item.participant_name === pid) {
                item.participant_name = bookingMatch.name || item.participant_name;
            }
            item.participant_email = bookingMatch.email || item.participant_email;
            item.participant_phone = bookingMatch.phone || item.participant_phone;
            item.participant_property = bookingMatch.property_name || item.participant_property;
            item.participant_city = bookingMatch.city || item.participant_city;
        } else if (userMatch) {
            if (!item.participant_name || item.participant_name === pid) {
                item.participant_name = userMatch.fullName || userMatch.name || `${userMatch.firstName || ''} ${userMatch.lastName || ''}`.trim() || item.participant_name;
            }
            item.participant_email = userMatch.email || item.participant_email;
            item.participant_phone = userMatch.phone || item.participant_phone;
        }
    }

    let inbox = Array.from(summaryMap.values()).sort((a, b) => {
      const aTime = new Date(a.last_message_at || 0).getTime();
      const bTime = new Date(b.last_message_at || 0).getTime();
      return bTime - aTime;
    });

    if (searchQuery) {
      inbox = inbox.filter((item) =>
        `${item.participant_login_id} ${item.participant_name} ${item.last_message}`.toLowerCase().includes(searchQuery)
      );
    }

    return res.json({
      success: true,
      login_id: loginId,
      count: inbox.length,
      conversations: inbox
    });
  } catch (error) {
    console.error('Error fetching inbox:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Get messages for a specific room (receiver's loginId)
exports.getMessages = async (req, res) => {
  try {
    const { room_id } = req.params;
    
    // IDOR protection: only allow superadmin or participant of the room
    const callerId = String(req.user.loginId || '').toUpperCase();
    const isRoomParticipant = String(room_id).toUpperCase() === callerId;
    
    const chatRoom = await ChatRoom.findOne({ room_id }).lean();
    const isParticipant = chatRoom?.participants?.some(p => String(p.loginId).toUpperCase() === callerId);

    if (req.user.role !== 'superadmin' && !isRoomParticipant && !isParticipant) {
        return res.status(403).json({ error: 'Forbidden: You are not a participant in this room' });
    }
    
    if (!room_id) {
      return res.status(400).json({ error: 'room_id is required' });
    }

    const messages = await ChatMessage.find({ room_id })
      .sort({ created_at: 1 })
      .limit(100);

    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get 1:1 conversation by two login ids (both directions)
exports.getConversation = async (req, res) => {
  try {
    const user1 = String(req.query.user1 || '').trim();
    const user2 = String(req.query.user2 || '').trim();

    // IDOR protection: only allow user1 or user2 to fetch the conversation unless superadmin
    const callerId = String(req.user.loginId || '').toUpperCase();
    if (req.user.role !== 'superadmin' && 
        callerId !== String(user1).toUpperCase() && 
        callerId !== String(user2).toUpperCase()) {
        return res.status(403).json({ error: 'Forbidden: You cannot access this conversation' });
    }

    if (!user1 || !user2) {
      return res.status(400).json({ error: 'user1 and user2 are required' });
    }

    const user1Variants = [...new Set([user1, user1.toLowerCase(), user1.toUpperCase()])];
    const user2Variants = [...new Set([user2, user2.toLowerCase(), user2.toUpperCase()])];

    const isSuperadmin = await isCallerSuperadmin(req);

    const pairKey = [user1, user2].sort().join(':').toUpperCase();
    const query = {
      $or: [
        { room_id: { $in: user1Variants }, sender_login_id: { $in: user2Variants } },
        { room_id: { $in: user2Variants }, sender_login_id: { $in: user1Variants } },
        { room_id: 'Verified Owner', sender_login_id: { $in: [...user1Variants, ...user2Variants] } },
        { room_id: { $in: [...user1Variants, ...user2Variants] }, sender_login_id: 'Verified Owner' },
        { conversation_id: pairKey, sender_login_id: { $in: ['system', 'System'] } }
      ]
    };

    if (!isSuperadmin) {
      query.is_blocked = { $ne: true };
    }

    const messages = await ChatMessage.find(query)
      .sort({ created_at: 1 })
      .limit(200)
      .lean();

    if (isSuperadmin) {
      messages.forEach(msg => {
        if (msg.is_blocked && msg.original_message_encrypted) {
          msg.message = ChatMessage.decryptText(msg.original_message_encrypted);
        }
      });
    }

    res.json(messages);
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: error.message });
  }
};

// Mark messages as read
exports.markAsRead = async (req, res) => {
  try {
    const { room_id } = req.params;
    const { sender } = req.query;
    
    // IDOR protection: only allow caller to mark their own received messages as read
    if (req.user.role !== 'superadmin' && String(req.user.loginId || '').toUpperCase() !== String(room_id).toUpperCase()) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const query = { room_id, is_read: false };
    if (sender) {
      const senderVariants = [...new Set([sender, sender.toLowerCase(), sender.toUpperCase()])];
      query.sender_login_id = { $in: senderVariants };
    }
    
    await ChatMessage.updateMany(
      query,
      { is_read: true }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking as read:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get unread count for a room
exports.getUnreadCount = async (req, res) => {
  try {
    const { room_id } = req.params;
    
    const count = await ChatMessage.countDocuments({
      room_id,
      is_read: false
    });

    res.json({ unread_count: count });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete a message (optional)
exports.deleteMessage = async (req, res) => {
  try {
    const { message_id } = req.params;
    
    // IDOR protection: only allow sender of message to delete it (or superadmin)
    const msgObj = await ChatMessage.findById(message_id).lean();
    if (!msgObj) return res.status(404).json({ error: 'Message not found' });
    if (req.user.role !== 'superadmin' && String(msgObj.sender_login_id).toUpperCase() !== String(req.user.loginId || '').toUpperCase()) {
        return res.status(403).json({ error: 'Forbidden: You cannot delete this message' });
    }
    
    await ChatMessage.findByIdAndDelete(message_id);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: error.message });
  }
};

// Send a message via REST API (useful for automated messages)
exports.sendMessage = async (req, res) => {
  try {
    const { to_login_id, from_login_id, message_type, file_url } = req.body;
    let targetRoomId = to_login_id;
    const cleanTo = String(to_login_id || '').toLowerCase().trim();
    if (cleanTo === 'verified owner' || cleanTo === 'own001' || cleanTo === 'null' || cleanTo === 'undefined') {
      try {
        const BookingRequest = require('../models/BookingRequest');
        const ApprovedProperty = require('../models/ApprovedProperty');

        const userBooking = await BookingRequest.findOne({
          $or: [
            { user_id: from_login_id },
            { email: from_login_id },
            { phone: from_login_id }
          ]
        }).sort({ created_at: -1 }).lean();

        if (userBooking) {
          if (userBooking.owner_id && !['verified owner', 'own001', 'null', 'undefined'].includes(String(userBooking.owner_id).toLowerCase().trim())) {
            targetRoomId = userBooking.owner_id;
          } else if (userBooking.property_id || userBooking.property_name) {
            const prop = await ApprovedProperty.findOne({
              $or: [
                { _id: (userBooking.property_id && mongoose.Types.ObjectId.isValid(userBooking.property_id)) ? userBooking.property_id : null },
                { propertyName: userBooking.property_name },
                { title: userBooking.property_name }
              ]
            }).select('generatedCredentials ownerLoginId owner_id owner').lean();

            const foundOwner = prop?.generatedCredentials?.loginId || prop?.ownerLoginId || prop?.owner_id || prop?.owner;
            if (foundOwner) targetRoomId = foundOwner;
          }
        }
      } catch (err) {
        console.warn('Error resolving targetRoomId:', err.message);
      }
    }
    if (!message && !file_url) {
      return res.status(400).json({ error: 'message or file_url is required' });
    }
    if (!message) {
      message = message_type === 'image' ? 'Sent an image' : 'Shared a file';
    }

    const { checkUserBlockStatus, isOwnerTenantChat, detectViolation, logViolation } = require('../utils/moderationHelper');
    const ChatSettings = require('../models/ChatSettings');

    // 1. Check restriction
    const blockCheck = await checkUserBlockStatus(from_login_id);
    if (blockCheck.blocked) {
      return res.status(403).json({ error: blockCheck.reason, blocked: true });
    }

    // Try to find sender details
    let senderName = from_login_id;
    let senderRole = 'system';

    const [owner, user] = await Promise.all([
      Owner.findOne({ loginId: from_login_id }).lean(),
      User.findOne({ loginId: from_login_id }).lean()
    ]);

    if (owner) {
      senderName = owner.name || owner.owner_name || from_login_id;
      senderRole = 'property_owner';
    } else if (user) {
      senderName = user.name || `${user.firstName || ""} ${user.lastName || ""}`.trim() || from_login_id;
      senderRole = 'website_user';
    }

    const originalText = String(message).trim();

    const msg = new ChatMessage({
      room_id: targetRoomId,
      sender_login_id: from_login_id,
      sender_name: senderName,
      sender_role: senderRole,
      message: originalText,
      message_type: message_type || 'text',
      file_url: file_url || undefined,
      is_blocked: false,
      created_at: new Date(),
      updated_at: new Date()
    });

    await msg.save();

    // Check if this message is a payment link and update booking funnel
    if (originalText.includes('/website/pay?bookingId=')) {
      try {
        const bookingIdMatch = originalText.match(/bookingId=([a-f0-9]{24})/i);
        if (bookingIdMatch && bookingIdMatch[1]) {
          await BookingRequest.findByIdAndUpdate(bookingIdMatch[1], {
            payment_link_sent_at: new Date()
          });
          console.log('✅ Updated booking payment_link_sent_at for', bookingIdMatch[1]);
        }
      } catch (bErr) {
        console.error('⚠️ Failed to update booking payment_link_sent_at:', bErr.message);
      }
    }

    // Run Groq AI moderation asynchronously in the background
    const isModeratedChat = await isOwnerTenantChat(from_login_id, to_login_id);
    if (isModeratedChat) {
      const { moderateChatMessageAsync } = require('../utils/moderationHelper');
      moderateChatMessageAsync(msg, to_login_id).catch(err => {
        console.error('Error running async moderation (REST):', err.message);
      });
    }

    // Emit real-time update via Socket.io if global.io is available
    if (global.io) {
      global.io.to(to_login_id).emit('receive_message', {
        _id: msg._id,
        room_id: to_login_id,
        sender_login_id: from_login_id,
        sender_name: senderName,
        message: msg.message,
        message_type: msg.message_type,
        file_url: msg.file_url,
        created_at: msg.created_at
      });
      global.io.to(to_login_id).emit('new_message', msg);
    }
    
    res.json({ success: true, message: msg });
  } catch (error) {
    console.error('Error sending REST message:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get ALL conversations for Superadmin monitoring
exports.getAllChats = async (req, res) => {
  try {
    const searchQuery = String(req.query.search || '').trim().toLowerCase();

    // 1. Find all unique pairs from ChatMessage
    // This is more reliable if ChatRoom entries are missing
    const messages = await ChatMessage.find({ 
        sender_login_id: { $ne: 'system' } 
    }).sort({ created_at: -1 }).limit(5000).lean();

    const summaryMap = new Map();

    for (const msg of messages) {
        const u1 = normalizeLoginId(msg.sender_login_id);
        const u2 = normalizeLoginId(msg.room_id);
        if (!u1 || !u2 || u1 === u2) continue;

        const pairKey = [u1, u2].sort().join(':');
        if (!summaryMap.has(pairKey)) {
            summaryMap.set(pairKey, {
                pair_key: pairKey,
                user1: u1,
                user2: u2,
                last_message: msg.message || 'Media/File',
                last_message_at: msg.created_at,
                participant_login_id: u1,
                target_login_id: u2
            });
        }
    }

    // 2. Also check ChatRooms for any pairs that might only have system messages
    const rooms = await ChatRoom.find({ 'participants.1': { $exists: true } }).lean();
    for (const room of rooms) {
        const u1 = room.participants[0].loginId;
        const u2 = room.participants[1].loginId;
        const pairKey = [u1, u2].sort().join(':');

        if (!summaryMap.has(pairKey)) {
            // Find last system message if no real messages
            const lastSys = await ChatMessage.findOne({ room_id: { $in: [u1, u2] }, sender_login_id: 'system' })
                                           .sort({ created_at: -1 }).lean();
            
            summaryMap.set(pairKey, {
                pair_key: pairKey,
                user1: u1,
                user2: u2,
                last_message: lastSys?.message || 'Chat started',
                last_message_at: lastSys?.created_at || room.created_at,
                participant_login_id: u1,
                target_login_id: u2
            });
        }
    }

    // 3. Enhance names with all possible sources
    const [websiteEnquiries, owners, users, bookingRequests] = await Promise.all([
        WebsiteEnquiry.find({}).lean(),
        Owner.find({}).lean(),
        User.find({}).lean(),
        BookingRequest.find({}).lean()
    ]);

    const getName = (id) => {
        if (!id) return "Unknown";
        const cleanId = String(id).trim().toUpperCase();
        if (cleanId === 'SUPER_ADMIN') return "Super Admin";

        // Try Owners (KO01, etc)
        const ownerMatch = owners.find(o => String(o.loginId || "").toUpperCase() === cleanId);
        if (ownerMatch) return ownerMatch.name || ownerMatch.owner_name;

        // Try Users (LoginId)
        const userMatch = users.find(u => String(u.loginId || "").toUpperCase() === cleanId);
        if (userMatch) return userMatch.name || `${userMatch.firstName || ""} ${userMatch.lastName || ""}`.trim();

        // Try matching by Email Hash for website users (roomhywebXXXXXX)
        const websiteMatch = websiteEnquiries.find(enq => enq.owner_email && generateWebsiteUserIdFromEmail(enq.owner_email).toUpperCase() === cleanId) ||
                             bookingRequests.find(br => br.email && generateWebsiteUserIdFromEmail(br.email).toUpperCase() === cleanId);
        if (websiteMatch) return websiteMatch.owner_name || websiteMatch.userName || websiteMatch.name;

        // Try matching by ID directly in Enquiries/Bookings (if the ID itself was used as email/phone)
        const directMatch = websiteEnquiries.find(enq => String(enq.owner_phone || "").toUpperCase() === cleanId) ||
                            bookingRequests.find(br => String(br.phone || "").toUpperCase() === cleanId);
        if (directMatch) return directMatch.owner_name || directMatch.userName || directMatch.name;

        return id; // Fallback to ID
    };

    const result = Array.from(summaryMap.values()).map(item => {
        const name1 = getName(item.user1);
        const name2 = getName(item.user2);
        return {
            ...item,
            participant_name: `${name1 || item.user1 || 'User'} ↔ ${name2 || item.user2 || 'User'}`,
            search_blob: `${name1} ${name2} ${item.user1} ${item.user2} ${item.last_message}`.toLowerCase()
        };
    }).sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));

    const filtered = searchQuery 
        ? result.filter(r => r.search_blob.includes(searchQuery))
        : result;

    res.json({
      success: true,
      conversations: filtered
    });
  } catch (error) {
    console.error('Error fetching all chats:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete a whole conversation between two users
exports.deleteConversation = async (req, res) => {
  try {
    const user1 = String(req.query.user1 || '').trim();
    const user2 = String(req.query.user2 || '').trim();

    // IDOR protection
    const callerId = String(req.user.loginId || '').toUpperCase();
    if (req.user.role !== 'superadmin' && 
        callerId !== String(user1).toUpperCase() && 
        callerId !== String(user2).toUpperCase()) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (!user1 || !user2) {
      return res.status(400).json({ error: 'user1 and user2 are required' });
    }

    const user1Variants = [...new Set([user1, user1.toLowerCase(), user1.toUpperCase()])];
    const user2Variants = [...new Set([user2, user2.toLowerCase(), user2.toUpperCase()])];

    // Delete all messages between these two users
    await ChatMessage.deleteMany({
      $or: [
        { room_id: { $in: user1Variants }, sender_login_id: { $in: user2Variants } },
        { room_id: { $in: user2Variants }, sender_login_id: { $in: user1Variants } }
      ]
    });

    // Also delete any room document if it exists
    await ChatRoom.deleteMany({
      participants: { 
        $all: [
          { $elemMatch: { loginId: { $in: user1Variants } } },
          { $elemMatch: { loginId: { $in: user2Variants } } }
        ] 
      }
    });

    res.json({ success: true, message: 'Conversation deleted successfully' });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: error.message });
  }
};
