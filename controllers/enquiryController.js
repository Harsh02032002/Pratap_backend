const Enquiry = require('../models/Enquiry');
const { notifySuperadmin } = require('../utils/superadminNotifier');
const { normalizeLoginId } = require('../utils/normalizeId');
const {
  resolveOwnerPropertyIdentity,
  buildOwnerBookingQuery,
  loadMovedInIndex,
  mapBookingToLead,
  dedupeBookingLeads
} = require('../services/ownerLeads');
const BookingRequest = require('../models/BookingRequest');

// Create a new enquiry
exports.createEnquiry = async (req, res) => {
  try {
    // Force status to 'request to connect' if not provided
    const payload = { ...req.body };
    if (!payload.status || payload.status === 'pending') {
      payload.status = 'request to connect';
    }
    const enquiry = await Enquiry.create(payload);

    const User = require('../models/user');
    const locationStr = payload.location || payload.city || payload.area || '';
    if (locationStr) {
      const areaEmp = await User.findOne({
        role: { $in: ['employee', 'areamanager'] },
        $or: [
          { city: new RegExp(locationStr, 'i') },
          { assignedArea: new RegExp(locationStr, 'i') },
          { locationCode: new RegExp(locationStr, 'i') }
        ]
      }).lean();
      if (areaEmp) {
        enquiry.assignedStaff = areaEmp.name || areaEmp.loginId;
        enquiry.assignedStaffId = areaEmp.loginId;
        await enquiry.save();
        console.log(`📍 Auto-assigned enquiry ${enquiry._id} to Area Employee: ${areaEmp.name} (${areaEmp.loginId})`);
      }
    }

    try {
      await notifySuperadmin({
        type: 'new_enquiry',
        from: 'owner',
        subject: `New Property Enquiry - ${payload.propertyName || 'Property'}`,
        message: 'A new property enquiry was submitted and is pending review.',
        meta: {
          enquiryId: enquiry._id?.toString?.() || '',
          userName: payload.ownerName || payload.studentName || '',
          userEmail: payload.email || payload.studentEmail || '',
          propertyName: payload.propertyName || '',
          location: payload.location || ''
        }
      });
    } catch (notifyErr) {
      console.warn('enquiry notification failed:', notifyErr.message);
    }

    // Send email notification to superadmin
    try {
      const mailer = require('../utils/mailer');
      const superadminEmail = process.env.SUPERADMIN_EMAIL || 'team@roomhy.com';
      const subject = 'New Property Enquiry Submitted';
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">New Property Enquiry</h2>
          <p>A property owner has submitted a new enquiry.</p>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <p><strong>Owner:</strong> ${payload.ownerName || 'N/A'}</p>
            <p><strong>Property:</strong> ${payload.propertyName || 'N/A'}</p>
            <p><strong>Location:</strong> ${payload.location || 'N/A'}</p>
            <p><strong>Phone:</strong> ${payload.phone || 'N/A'}</p>
            <p><strong>Email:</strong> ${payload.email || 'Not provided'}</p>
            <p><strong>Message:</strong> ${payload.message || 'No message'}</p>
          </div>
          <p>Please review this enquiry in the superadmin panel.</p>
        </div>
      `;
      await mailer.sendMail(superadminEmail, subject, '', html);
    } catch (emailError) {
      console.error('Failed to send enquiry notification email:', emailError);
    }

    res.status(201).json(enquiry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// List all enquiries for an owner
exports.listEnquiries = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const normalizedOwnerId = normalizeLoginId(String(ownerLoginId || ''));
    // Both the canonical (uppercase) form and the caller's literal input, deduped.
    // An $in of plain strings uses the ownerLoginId/owner_id indexes; the
    // case-insensitive regex branch this replaces could not, and because an $or
    // is only index-eligible when every branch is, it forced a full scan.
    const ownerIdCandidates = [...new Set([normalizedOwnerId, ownerLoginId].filter(Boolean))];

    // 1. Fetch enquiries from Enquiry collection (indexed exact-match on ownerLoginId)
    const enquiries = await Enquiry.find({
      ownerLoginId: { $in: ownerIdCandidates }
    }).sort({ ts: -1 }).lean();

    // 2-4. Website leads (direct bookings + bids) with their property identity
    // resolution and Enquiry-shaped mapping. Shared with the owner dashboard via
    // services/ownerLeads so the two surfaces cannot drift apart — the dashboard
    // previously had none of this and showed no website leads at all.
    const identity = await resolveOwnerPropertyIdentity(ownerIdCandidates, normalizedOwnerId);
    const bookingRequests = await BookingRequest
      .find(buildOwnerBookingQuery({ ownerIdCandidates, normalizedOwnerId, identity }))
      .sort({ created_at: -1 })
      .lean();

    const movedIn = await loadMovedInIndex(ownerIdCandidates);
    const activeTenantPhones = movedIn.phones;
    const activeTenantEmails = movedIn.emails;

    const mappedBookings = dedupeBookingLeads(bookingRequests).map(b => mapBookingToLead(b, movedIn));

    // 5. Also check Enquiries for moved in status
    const mappedEnquiries = enquiries.map(e => {
      const cleanPhone = String(e.studentPhone || '').replace(/\D/g, '');
      const cleanEmail = String(e.studentEmail || '').toLowerCase().trim();
      const isMovedIn = (cleanPhone && activeTenantPhones.has(cleanPhone)) || (cleanEmail && activeTenantEmails.has(cleanEmail));

      return {
        ...e,
        status: isMovedIn ? 'confirmed' : e.status
      };
    });

    // 6. Merge, filter out rejected/deleted leads, and sort by timestamp
    const rawLeads = [...mappedEnquiries, ...mappedBookings]
      .filter(item => {
        const st = String(item.status || '').toLowerCase();
        return st !== 'rejected' && st !== 'deleted' && st !== 'cancelled' && !item.isDeleted;
      });
    rawLeads.sort((a, b) => new Date(b.ts || b.created_at || b.createdAt || 0) - new Date(a.ts || a.created_at || a.createdAt || 0));

    // Deduplicate leads by phone+property, email+property, or ID so no duplicate entries appear in All Leads
    const seenKeys = new Set();
    const allLeads = [];

    for (const lead of rawLeads) {
      const idKey = String(lead._id || lead.id || '');
      const phone = String(lead.studentPhone || lead.student_phone || lead.phone || '').replace(/\D/g, '');
      const email = String(lead.studentEmail || lead.student_email || lead.email || '').toLowerCase().trim();
      const propKey = String(lead.propertyId || lead.property_id || lead.propertyName || lead.property_name || 'all').toLowerCase().trim();

      const phoneKey = phone ? `phone_${phone}_${propKey}` : null;
      const emailKey = email ? `email_${email}_${propKey}` : null;

      if (idKey && seenKeys.has(`id_${idKey}`)) continue;
      if (phoneKey && seenKeys.has(phoneKey)) continue;
      if (emailKey && seenKeys.has(emailKey)) continue;

      if (idKey) seenKeys.add(`id_${idKey}`);
      if (phoneKey) seenKeys.add(phoneKey);
      if (emailKey) seenKeys.add(emailKey);

      allLeads.push(lead);
    }

    res.json(allLeads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update enquiry status (accept/reject)
exports.updateEnquiry = async (req, res) => {
  try {
    const { id } = req.params;
    const update = req.body;

    // 1. Try to find and update in Enquiry collection
    let enquiry = await Enquiry.findById(id);
    if (enquiry) {
      if (update.status === 'accepted') {
        update.chatOpen = true;
        update.visitAllowed = true;
      }
      if (update.status === 'rejected') {
        update.chatOpen = false;
        update.visitAllowed = false;
      }
      enquiry = await Enquiry.findByIdAndUpdate(id, update, { new: true });
      return res.json(enquiry);
    }

    // 2. Try to find and update in BookingRequest collection
    const BookingRequest = require('../models/BookingRequest');
    const Owner = require('../models/Owner');
    const ChatMessage = require('../models/ChatMessage');
    const ChatRoom = require('../models/ChatRoom');
    const { generateWebsiteUserIdFromEmail, buildChatLookupVariants } = require('../utils/chatIdentity');

    let bookingReq = await BookingRequest.findById(id);
    if (bookingReq) {
      const bStatus = update.status;
      const bUpdate = {
        status: bStatus,
        booking_status: bStatus,
        bookingStatus: bStatus,
        updated_at: Date.now()
      };
      bookingReq = await BookingRequest.findByIdAndUpdate(id, bUpdate, { new: true });

      // If accepting the bid, send welcome message
      if (bStatus === 'accepted' && bookingReq) {
        try {
          const tenantName = bookingReq.name || 'Valued Guest';
          const propertyName = bookingReq.property_name || 'Property';
          const ownerDoc = await Owner.findOne({ loginId: String(bookingReq.owner_id || '').toUpperCase() });
          const ownerName = ownerDoc?.profile?.name || ownerDoc?.name || bookingReq.owner_name || bookingReq.owner_id;

          // Ensure chat rooms exist
          const normalizedOwnerId = String(bookingReq.owner_id || '').trim().toUpperCase();
          const normalizedUserId = generateWebsiteUserIdFromEmail(bookingReq.email) || bookingReq.user_id;

          if (normalizedOwnerId && normalizedUserId) {
            const participants = [
              { loginId: normalizedOwnerId, role: 'property_owner' },
              { loginId: normalizedUserId, role: 'website_user' }
            ];

            // Create chat rooms for both owner and user
            await Promise.all([
              ChatRoom.findOneAndUpdate(
                { room_id: normalizedOwnerId },
                {
                  $set: { participants, updated_at: new Date() },
                  $setOnInsert: { room_id: normalizedOwnerId, created_at: new Date() }
                },
                { new: true, upsert: true, setDefaultsOnInsert: true }
              ),
              ChatRoom.findOneAndUpdate(
                { room_id: normalizedUserId },
                {
                  $set: { participants, updated_at: new Date() },
                  $setOnInsert: { room_id: normalizedUserId, created_at: new Date() }
                },
                { new: true, upsert: true, setDefaultsOnInsert: true }
              )
            ]);

            // Send welcome message to both tenant's and owner's chat rooms
            const welcomeMsg = `Hello ${tenantName}! 👋 I have reviewed and accepted your request for "${propertyName}". 🏠 I have enabled chat for our conversation so we can discuss the next steps and move-in details. Looking forward to hosting you!`;
            const pairKey = [String(normalizedOwnerId).toUpperCase(), String(normalizedUserId)].sort().join(':').toUpperCase();

            await Promise.all([
              ChatMessage.create({
                room_id: normalizedUserId,
                conversation_id: pairKey,
                sender_login_id: String(normalizedOwnerId || '').toUpperCase(),
                sender_name: ownerName,
                sender_role: 'property_owner',
                message: welcomeMsg,
                message_type: 'text',
                created_at: new Date(),
                updated_at: new Date()
              }),
              ChatMessage.create({
                room_id: normalizedOwnerId,
                conversation_id: pairKey,
                sender_login_id: String(normalizedUserId || '').toLowerCase(),
                sender_name: tenantName,
                sender_role: 'website_user',
                message: welcomeMsg,
                message_type: 'text',
                created_at: new Date(),
                updated_at: new Date()
              })
            ]);

            // Dispatch WhatsApp notification to tenant
            const { sendTextMessage } = require('../utils/whatsappBot');
            const tenantPhone = bookingReq.phone || bookingReq.user_phone || bookingReq.studentPhone || '';
            if (tenantPhone) {
              sendTextMessage(tenantPhone, welcomeMsg).catch(waErr => {
                console.warn('⚠️ WhatsApp notification error:', waErr.message);
              });
            }

            console.log('✅ Welcome message sent to tenant and owner in rooms:', normalizedUserId, normalizedOwnerId);
          }
        } catch (chatErr) {
          console.error('⚠️ Failed to send welcome message:', chatErr.message);
        }
      }

      return res.json({
        _id: bookingReq._id,
        ownerLoginId: bookingReq.owner_id,
        status: bookingReq.booking_status || bookingReq.status,
        isBookingRequest: true
      });
    }

    return res.status(404).json({ error: 'Enquiry/Booking Request not found' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
