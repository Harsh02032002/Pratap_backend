const ChatTemplate = require('../models/ChatTemplate');
const ChatSettings = require('../models/ChatSettings');
const ChatMessage = require('../models/ChatMessage');
const ChatRoom = require('../models/ChatRoom');
const ChatEvent = require('../models/ChatEvent');
const Dispute = require('../models/Dispute');
const BookingRequest = require('../models/BookingRequest');
const Enquiry = require('../models/Enquiry');
const ChatViolation = require('../models/ChatViolation');
const AuditLog = require('../models/AuditLog');

// ─── MODERATION ─────────────────────────────────────────────────────────────
exports.getFlaggedMessages = async (req, res) => {
  try {
    const { type, status, from, to, page = 1, limit = 30 } = req.query;
    const filter = { violation_type: { $ne: null } };
    if (type) filter.violation_type = type;
    if (status) filter.moderation_status = status;
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = new Date(from);
      if (to) filter.created_at.$lte = new Date(to);
    }

    const messages = await ChatMessage.find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await ChatMessage.countDocuments(filter);
    res.json({ success: true, messages, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.resolveFlaggedMessage = async (req, res) => {
  try {
    const { action } = req.body; // 'false_positive' | 'action_taken'
    const adminId = req.user?.loginId || 'SUPER_ADMIN';
    const msg = await ChatMessage.findByIdAndUpdate(
      req.params.id,
      { moderation_status: action, moderation_resolved_by: adminId },
      { new: true }
    );
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Decrypt original message for authorized admin only
exports.decryptMessage = async (req, res) => {
  try {
    const msg = await ChatMessage.findById(req.params.id).lean();
    if (!msg || !msg.original_message_encrypted) {
      return res.status(404).json({ success: false, message: 'No encrypted message found' });
    }
    const decrypted = ChatMessage.decryptText(msg.original_message_encrypted);
    res.json({ success: true, original: decrypted });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── TEMPLATES ───────────────────────────────────────────────────────────────
exports.getTemplates = async (req, res) => {
  try {
    const templates = await ChatTemplate.find().sort({ createdAt: -1 });
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const { title, message, type, isActive } = req.body;
    const tmpl = await ChatTemplate.create({ title, message, type, isActive, ownerLoginId: 'SUPER_ADMIN' });
    res.json({ success: true, template: tmpl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const tmpl = await ChatTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, template: tmpl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    await ChatTemplate.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
exports.getSettings = async (req, res) => {
  try {
    let settings = await ChatSettings.findOne({ ownerLoginId: 'SUPER_ADMIN' });
    if (!settings) settings = await ChatSettings.create({ ownerLoginId: 'SUPER_ADMIN' });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const settings = await ChatSettings.findOneAndUpdate(
      { ownerLoginId: 'SUPER_ADMIN' },
      { ...req.body, updatedAt: Date.now() },
      { new: true, upsert: true }
    );
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── FUNNEL / LEAD → CHAT MAPPING ───────────────────────────────────────────
exports.getFunnel = async (req, res) => {
  try {
    const [
      totalLeads,
      ownerApproved,
      chatStarted,
      paymentPending,
      paymentCompleted,
      bookingConfirmed
    ] = await Promise.all([
      Enquiry.countDocuments(),
      Enquiry.countDocuments({ status: { $in: ['approved', 'confirmed'] } }),
      ChatRoom.countDocuments({ status: 'Active' }),
      ChatRoom.countDocuments({ stage: 'Payment Pending' }),
      ChatRoom.countDocuments({ stage: 'Payment Completed' }),
      ChatRoom.countDocuments({ stage: 'Booking Confirmed' }),
    ]);

    res.json({
      success: true,
      funnel: [
        { stage: 'Lead Created', count: totalLeads },
        { stage: 'Owner Approved', count: ownerApproved },
        { stage: 'Chat Started', count: chatStarted },
        { stage: 'Payment Pending', count: paymentPending },
        { stage: 'Payment Completed', count: paymentCompleted },
        { stage: 'Booking Confirmed', count: bookingConfirmed },
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getLeadMappings = async (req, res) => {
  try {
    const enquiries = await Enquiry.find().sort({ ts: -1 }).lean();
    const chatRooms = await ChatRoom.find({ enquiry_id: { $ne: null } }).lean();
    
    const mappingMap = {};
    chatRooms.forEach(room => {
      if (room.enquiry_id) {
        mappingMap[room.enquiry_id.toString()] = room.room_id;
      }
    });

    const leads = enquiries.map(e => ({
      _id: e._id,
      name: e.studentName || 'Unknown',
      email: e.studentEmail || '',
      phone: e.studentPhone || '',
      property: e.propertyName || '',
      chatLoginId: mappingMap[e._id.toString()] || null,
      status: e.status
    }));

    res.json({ success: true, leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.mapLead = async (req, res) => {
  try {
    const { enquiryId, chatLoginId } = req.body;
    if (!enquiryId || !chatLoginId) {
      return res.status(400).json({ success: false, message: 'Missing enquiryId or chatLoginId' });
    }

    const chatRoom = await ChatRoom.findOne({ room_id: chatLoginId });
    if (!chatRoom) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    chatRoom.enquiry_id = enquiryId;
    await chatRoom.save();

    await Enquiry.findByIdAndUpdate(enquiryId, { chatOpen: true });

    // Audit log mapping
    await AuditLog.create({
      actorId: 'SUPER_ADMIN',
      actorRole: 'superadmin',
      module: 'Chat',
      action: 'Map Lead',
      method: 'POST',
      path: req.originalUrl || '/api/chat/admin/leads/map',
      statusCode: 200,
      payload: {
        enquiryId,
        chatLoginId,
        oldValue: null,
        newValue: chatLoginId
      }
    });

    res.json({ success: true, message: 'Lead mapped to chat successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── BOOKING CONVERSION TRACKER ──────────────────────────────────────────────
exports.getBookingTracker = async (req, res) => {
  try {
    const { status, page = 1, limit = 25 } = req.query;
    const filter = { chat_room_id: { $ne: null } };
    if (status) filter.booking_status = status;

    const bookings = await BookingRequest.find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await BookingRequest.countDocuments(filter);
    res.json({ success: true, bookings, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── ANALYTICS ───────────────────────────────────────────────────────────────
exports.getAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const Owner = require('../models/Owner');
    const [
      totalActiveChats,
      totalClosedChats,
      stagnantChats,
      convertedToBooking,
      paymentEvents,
      revenueResult,
      contactSharingAttempts,
      commissionBypassAttempts,
      externalSettlementAttempts,
      repeatedViolatorsResult,
      blockedOwnersCount
    ] = await Promise.all([
      ChatRoom.countDocuments({ status: 'Active' }),
      ChatRoom.countDocuments({ status: 'Closed' }),
      ChatRoom.countDocuments({
        status: 'Active',
        last_activity: { $lt: new Date(now - 48 * 60 * 60 * 1000) }
      }),
      ChatRoom.countDocuments({ stage: 'Booking Confirmed' }),
      ChatEvent.countDocuments({ event_type: 'PAYMENT_COMPLETED', created_at: { $gte: thirtyDaysAgo } }),
      ChatEvent.aggregate([
        { $match: { event_type: 'PAYMENT_COMPLETED', created_at: { $gte: thirtyDaysAgo } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      ChatViolation.countDocuments({ violationType: 'contact_sharing' }),
      ChatViolation.countDocuments({ violationType: 'commission_bypass' }),
      ChatViolation.countDocuments({ violationType: 'external_settlement' }),
      ChatViolation.aggregate([
        { $group: { _id: '$participantLoginId', count: { $sum: 1 } } },
        { $match: { count: { $gte: 2 } } },
        { $count: 'total' }
      ]),
      Owner.countDocuments({ isActive: false })
    ]);

    const revenue = revenueResult[0]?.total || 0;
    const bookingConversionRate = totalActiveChats > 0
      ? ((convertedToBooking / (totalActiveChats + totalClosedChats)) * 100).toFixed(1)
      : 0;
    
    const repeatedViolators = repeatedViolatorsResult[0]?.total || 0;

    // 7-day daily trend
    const dailyTrend = await ChatEvent.aggregate([
      { $match: { event_type: 'CHAT_ENABLED', created_at: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      cards: {
        totalActiveChats,
        totalClosedChats,
        stagnantChats,
        convertedToBooking,
        paymentEvents,
        revenue,
        bookingConversionRate: `${bookingConversionRate}%`,
        contactSharingAttempts,
        commissionBypassAttempts,
        externalSettlementAttempts,
        repeatedViolators,
        blockedOwnersCount
      },
      dailyTrend
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getStagnantChats = async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const chats = await ChatRoom.find({
      status: 'Active',
      last_activity: { $lt: cutoff }
    }).sort({ last_activity: 1 }).limit(50).lean();
    res.json({ success: true, chats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DISPUTES ────────────────────────────────────────────────────────────────
exports.getDisputes = async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.dispute_type = type;

    const disputes = await Dispute.find(filter)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await Dispute.countDocuments(filter);
    res.json({ success: true, disputes, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createDispute = async (req, res) => {
  try {
    const { room_id, booking_id, dispute_type, description, raised_by_login_id, raised_by_name, raised_by_role, against_login_id, against_name, property_name } = req.body;
    const dispute = await Dispute.create({
      room_id, booking_id, dispute_type, description,
      raised_by_login_id, raised_by_name, raised_by_role,
      against_login_id, against_name, property_name
    });

    // Log chat event
    await ChatEvent.create({ event_type: 'DISPUTE_RAISED', room_id, booking_id, user_login_id: raised_by_login_id, metadata: { dispute_type } });

    // Update booking dispute count
    if (booking_id) {
      await BookingRequest.findOneAndUpdate(
        { $or: [{ _id: booking_id }, { chat_room_id: room_id }] },
        { $inc: { dispute_count: 1 }, has_active_dispute: true }
      );
    }

    res.json({ success: true, dispute });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateDispute = async (req, res) => {
  try {
    const { status, resolution_notes, assigned_admin } = req.body;
    const update = { status, resolution_notes, assigned_admin, updated_at: Date.now() };
    if (status === 'Resolved' || status === 'Closed') update.resolved_at = Date.now();

    const dispute = await Dispute.findByIdAndUpdate(req.params.id, update, { new: true });

    // If resolved, clear booking flag
    if ((status === 'Resolved' || status === 'Closed') && dispute.booking_id) {
      const openDisputes = await Dispute.countDocuments({ booking_id: dispute.booking_id, status: 'Open' });
      if (openDisputes === 0) {
        await BookingRequest.findOneAndUpdate(
          { $or: [{ _id: dispute.booking_id }, { chat_room_id: dispute.room_id }] },
          { has_active_dispute: false }
        );
      }
    }

    res.json({ success: true, dispute });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Helper to determine why the owner and tenant are talking
async function getConversationContext(ownerId, tenantId) {
  try {
    const BookingRequest = require('../models/BookingRequest');
    const ChatRoom = require('../models/ChatRoom');

    // Find the latest booking request between this owner and tenant/user
    const booking = await BookingRequest.findOne({
      owner_id: ownerId,
      $or: [
        { user_id: tenantId },
        { email: tenantId }
      ]
    }).sort({ created_at: -1 }).lean();

    if (booking) {
      return `Booking Request for property "${booking.property_name}" (Rent: ₹${booking.rent_amount}, Status: ${booking.booking_status})`;
    }

    // Try finding a chat room involving both
    const chatRoom = await ChatRoom.findOne({
      $or: [
        { room_id: ownerId },
        { room_id: tenantId }
      ]
    }).lean();

    if (chatRoom && chatRoom.property_name) {
      return `Inquiry for property "${chatRoom.property_name}"`;
    }
  } catch (err) {
    console.error('Error getting conversation context:', err);
  }
  return 'General inquiry / No active booking request found';
}

// ─── VIOLATIONS ──────────────────────────────────────────────────────────────
exports.getViolations = async (req, res) => {
  try {
    const violations = await ChatViolation.find().sort({ createdAt: -1 }).lean();
    
    // Populate conversation context for each violation dynamically
    const populatedViolations = await Promise.all(
      violations.map(async (v) => {
        const context = await getConversationContext(v.ownerId, v.tenantId);
        return {
          ...v,
          conversationContext: context
        };
      })
    );

    res.json({ success: true, violations: populatedViolations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


exports.resolveViolation = async (req, res) => {
  try {
    const { actionTaken } = req.body;
    const adminId = 'SUPER_ADMIN';
    
    const violation = await ChatViolation.findByIdAndUpdate(
      req.params.id,
      { actionTaken, resolvedBy: adminId, resolvedAt: new Date() },
      { new: true }
    );

    if (violation) {
      await ChatMessage.findOneAndUpdate(
        { message: violation.messageSnippet },
        { moderation_status: actionTaken !== 'none' ? 'action_taken' : 'false_positive', moderation_resolved_by: adminId }
      );
    }

    // Audit log resolving
    await AuditLog.create({
      actorId: adminId,
      actorRole: 'superadmin',
      module: 'Chat',
      action: 'Resolve Violation',
      method: 'POST',
      path: req.originalUrl || `/api/chat/admin/violations/${req.params.id}/resolve`,
      statusCode: 200,
      payload: { violationId: req.params.id, actionTaken }
    });

    res.json({ success: true, violation });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.adminActionOnViolation = async (req, res) => {
  try {
    const { action, reason } = req.body;
    const violationId = req.params.id;
    const adminId = req.user?.loginId || 'SUPER_ADMIN';

    const violation = await ChatViolation.findById(violationId);
    if (!violation) {
      return res.status(404).json({ success: false, message: 'Violation not found' });
    }

    const targetLoginId = violation.participantLoginId;
    const User = require('../models/user');
    const Owner = require('../models/Owner');

    let historyAction = action;

    if (action === 'send_warning') {
      violation.status = 'Warning Sent';
      historyAction = 'Warning Sent';
      // Create warning system message in the room
      const ChatMessage = require('../models/ChatMessage');
      const pairKey = [violation.ownerId, violation.tenantId].sort().join(':').toUpperCase();
      const warningMsg = await ChatMessage.create({
        room_id: violation.conversationId || targetLoginId,
        conversation_id: pairKey,
        sender_login_id: 'system',
        sender_name: 'System',
        sender_role: 'superadmin',
        message: `⚠️ System Warning: Sharing phone numbers, emails, links, or negotiating/paying offline is not allowed. Please keep all chat and payments on Roomhy.`,
        message_type: 'text',
        created_at: new Date(),
        updated_at: new Date()
      });

      // Broadcast real-time message via socket to both rooms (owner and tenant)
      if (global.io) {
        const payload = {
          _id: warningMsg._id,
          sender_login_id: 'system',
          sender_name: 'System',
          sender_role: 'superadmin',
          message: warningMsg.message,
          created_at: warningMsg.created_at
        };
        global.io.to(violation.ownerId).emit('receive_message', { ...payload, room_id: violation.ownerId });
        global.io.to(violation.tenantId).emit('receive_message', { ...payload, room_id: violation.tenantId });
      }
    } else if (action === 'restrict_chat') {
      violation.status = 'Warning Sent';
      historyAction = 'Chat Restricted (24h)';
      const durationHours = 24;
      const restrictUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000);
      
      // Update User and Owner restriction
      await Promise.all([
        User.updateOne({ loginId: targetLoginId }, { chatRestrictedUntil: restrictUntil }),
        Owner.updateOne({ loginId: targetLoginId.toUpperCase() }, { chatRestrictedUntil: restrictUntil })
      ]);
    } else if (action === 'suspend_user') {
      violation.status = 'Resolved';
      violation.resolvedAt = new Date();
      violation.resolvedBy = adminId;
      historyAction = 'Account Suspended';

      // Suspend User/Owner
      await Promise.all([
        User.updateOne({ loginId: targetLoginId }, { isActive: false, status: 'blocked' }),
        Owner.updateOne({ loginId: targetLoginId.toUpperCase() }, { isActive: false })
      ]);
    } else if (action === 'mark_reviewed') {
      violation.status = 'Reviewed';
      historyAction = 'Marked Reviewed';
    } else if (action === 'mark_resolved') {
      violation.status = 'Resolved';
      violation.resolvedAt = new Date();
      violation.resolvedBy = adminId;
      historyAction = 'Marked Resolved';
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action specified' });
    }

    // Add to action history
    violation.actionHistory.push({
      action: historyAction,
      adminId,
      reason: reason || 'No reason provided',
      timestamp: new Date()
    });

    await violation.save();

    // Create Audit Log
    const AuditLog = require('../models/AuditLog');
    await AuditLog.create({
      actorId: adminId,
      actorRole: 'superadmin',
      module: 'Chat',
      action: `Moderation Action: ${action}`,
      method: 'POST',
      path: req.originalUrl,
      statusCode: 200,
      payload: { violationId, action, reason }
    });

    res.json({ success: true, violation });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── BLOCKED OWNERS ──────────────────────────────────────────────────────────
exports.getBlockedOwners = async (req, res) => {
  try {
    const Owner = require('../models/Owner');
    const ChatViolation = require('../models/ChatViolation');

    const blockedOwners = await Owner.find({ isActive: false }).sort({ updatedAt: -1 }).lean();

    const populated = await Promise.all(blockedOwners.map(async (owner) => {
      const loginId = owner.loginId;
      const violations = await ChatViolation.find({
        $or: [
          { ownerId: loginId },
          { participantLoginId: loginId }
        ]
      }).sort({ createdAt: -1 }).lean();

      return {
        _id: owner._id,
        loginId: owner.loginId,
        name: owner.name || 'Owner',
        email: owner.email || owner.profile?.email || 'N/A',
        phone: owner.phone || owner.profile?.phone || 'N/A',
        blockedAt: owner.updatedAt || owner.createdAt,
        violationsCount: violations.length,
        violationsSnippet: violations[0]?.messageSnippet || 'Auto-blocked due to 2 commission bypass / contact sharing violations',
        status: 'blocked'
      };
    }));

    res.json({ success: true, blockedOwners: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.unblockOwner = async (req, res) => {
  try {
    const { loginId } = req.params;
    const Owner = require('../models/Owner');
    const User = require('../models/user');
    const AuditLog = require('../models/AuditLog');

    const normalizedId = String(loginId).toUpperCase();
    await Promise.all([
      Owner.updateOne({ loginId: normalizedId }, { isActive: true }),
      User.updateOne({ loginId: normalizedId }, { isActive: true, status: 'active' })
    ]);

    await AuditLog.create({
      actorId: req.user?.loginId || 'SUPER_ADMIN',
      actorRole: 'superadmin',
      module: 'Chat',
      action: 'Unblock Owner',
      method: 'POST',
      path: req.originalUrl,
      statusCode: 200,
      payload: { ownerLoginId: normalizedId }
    });

    res.json({ success: true, message: `Owner ${normalizedId} unblocked successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

