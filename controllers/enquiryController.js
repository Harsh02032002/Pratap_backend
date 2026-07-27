const Enquiry = require('../models/Enquiry');
const { notifySuperadmin } = require('../utils/superadminNotifier');

// Create a new enquiry
exports.createEnquiry = async (req, res) => {
  try {
    // Force status to 'request to connect' if not provided
    const payload = { ...req.body };
    if (!payload.status || payload.status === 'pending') {
      payload.status = 'request to connect';
    }
    const enquiry = await Enquiry.create(payload);

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
      const superadminEmail = 'roomhy01@gmail.com';
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
    const normalizedOwnerId = String(ownerLoginId || '').toUpperCase();

    // 1. Fetch enquiries from Enquiry collection
    const enquiries = await Enquiry.find({ ownerLoginId }).sort({ ts: -1 }).lean();

    // 2. Fetch booking requests from BookingRequest collection (matching owner_id OR owner's properties)
    const BookingRequest = require('../models/BookingRequest');
    const ApprovedProperty = require('../models/ApprovedProperty');

    let propIds = [];
    let propVisitIds = [];
    let propNames = [];

    try {
      const ownerProps = await ApprovedProperty.find({
        $or: [
          { ownerLoginId: normalizedOwnerId },
          { 'generatedCredentials.loginId': normalizedOwnerId },
          { owner_id: normalizedOwnerId },
          { owner: normalizedOwnerId },
          { ownerLoginId: ownerLoginId },
          { owner_id: ownerLoginId }
        ]
      }).select('_id visitId propertyName title').lean();

      propIds = ownerProps.map(p => String(p._id));
      propVisitIds = ownerProps.map(p => p.visitId).filter(Boolean);
      propNames = ownerProps.map(p => p.propertyName || p.title).filter(Boolean);
    } catch (_) {}

    const bookingQuery = {
      $or: [
        { owner_id: normalizedOwnerId },
        { owner_id: ownerLoginId },
        { owner_ids: { $in: [normalizedOwnerId, ownerLoginId] } }
      ]
    };

    if (propIds.length > 0) bookingQuery.$or.push({ property_id: { $in: propIds } });
    if (propVisitIds.length > 0) bookingQuery.$or.push({ property_id: { $in: propVisitIds } });
    if (propNames.length > 0) bookingQuery.$or.push({ property_name: { $in: propNames } });

    const bookingRequests = await BookingRequest.find(bookingQuery).sort({ created_at: -1 }).lean();

    // 3. Fetch tenants to see who has moved in (onboarded)
    const Tenant = require('../models/Tenant');
    const tenants = await Tenant.find({
      $or: [
        { ownerLoginId: normalizedOwnerId },
        { ownerLoginId: ownerLoginId }
      ],
      isDeleted: { $ne: true }
    }).lean();

    const activeTenantPhones = new Set(tenants.map(t => String(t.phone || '').replace(/\D/g, '')));
    const activeTenantEmails = new Set(tenants.map(t => String(t.email || '').toLowerCase().trim()).filter(Boolean));

    // 4. Map booking requests to Enquiry structure
    const mappedBookings = bookingRequests.map(b => {
      const cleanPhone = String(b.phone || '').replace(/\D/g, '');
      const cleanEmail = String(b.email || '').toLowerCase().trim();
      const isMovedIn = (cleanPhone && activeTenantPhones.has(cleanPhone)) || (cleanEmail && activeTenantEmails.has(cleanEmail));

      return {
        _id: b._id,
        ownerLoginId: b.owner_id,
        propertyId: b.property_id,
        propertyName: b.property_name,
        studentId: b.user_id,
        studentName: b.name,
        studentEmail: b.email,
        studentPhone: b.phone,
        city: b.city || b.filter_criteria?.city || '',
        area: b.area || b.filter_criteria?.area || b.filter_criteria?.location || '',
        notes: b.message || (b.request_type === 'direct' ? 'Direct booking request from website' : `Tenant Max Budget: ₹${((b.bid_amount && b.bid_amount > 0 ? b.bid_amount : b.bid_max) || 7000).toLocaleString("en-IN")}. If you can offer this property for ₹${((b.bid_amount && b.bid_amount > 0 ? b.bid_amount : b.bid_max) || 7000).toLocaleString("en-IN")}/month, please accept the bid.`),
        preferredCity: b.city || b.filter_criteria?.city || '',
        preferredArea: b.area || b.filter_criteria?.area || b.filter_criteria?.location || '',
        location: b.area ? (b.city ? `${b.area}, ${b.city}` : b.area) : (b.city || ''),
        status: isMovedIn ? 'confirmed' : (b.booking_status || b.status || 'pending'),
        paidAmount: b.payment_amount || b.rent_amount || b.total_amount || 0,
        ts: b.created_at || b.createdAt || new Date(),
        source: b.request_type ? (b.request_type.charAt(0).toUpperCase() + b.request_type.slice(1)) : 'Website',
        budget: (() => {
          if (b.request_type === 'bid') {
            if (b.message) {
              const match = String(b.message).match(/₹([\d,]+)/);
              if (match && match[1]) {
                const val = parseInt(match[1].replace(/,/g, ''), 10);
                if (val > 0) return `₹${val.toLocaleString("en-IN")}`;
              }
            }
            if (b.bid_amount && b.bid_amount > 0) return `₹${b.bid_amount.toLocaleString("en-IN")}`;
            if (b.bid_max && b.bid_max > 0) return `₹${b.bid_max.toLocaleString("en-IN")}`;
            if (b.filter_criteria?.max_price) return `₹${Number(b.filter_criteria.max_price).toLocaleString("en-IN")}`;
          }
          return `₹${(b.rent_amount || b.total_amount || 0).toLocaleString("en-IN")}`;
        })(),
        isBookingRequest: true
      };
    });

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
    const allLeads = [...mappedEnquiries, ...mappedBookings]
      .filter(item => {
        const st = String(item.status || '').toLowerCase();
        return st !== 'rejected' && st !== 'deleted' && st !== 'cancelled' && !item.isDeleted;
      });
    allLeads.sort((a, b) => new Date(b.ts) - new Date(a.ts));

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
