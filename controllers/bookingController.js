const BookingRequest = require('../models/BookingRequest');
const RefundRequest = require('../models/RefundRequest');
const Notification = require('../models/Notification');
const User = require('../models/user');
const Owner = require('../models/Owner');
const CheckinRecord = require('../models/CheckinRecord');
const ChatRoom = require('../models/ChatRoom');
const ChatMessage = require('../models/ChatMessage');
const mailer = require('../utils/mailer');
const { notifySuperadmin } = require('../utils/superadminNotifier');
const { sendBookingConfirmationButtons, sendTemplateToResolvedUser } = require('../utils/whatsappBot');
const { generateAgreementPdfBuffer } = require('../utils/generateAgreementPdf');

function resolveOwnerAgreementContact(ownerDoc = {}, request = {}) {
    const loginId = String(ownerDoc.loginId || request.owner_id || '').trim().toUpperCase();
    const name = ownerDoc.name || ownerDoc.profile?.name || request.owner_name || 'Property Owner';
    const email = ownerDoc.email || ownerDoc.profile?.email || '';
    const phone = ownerDoc.checkinPhone || ownerDoc.phone || ownerDoc.profile?.phone || '';
    const area = ownerDoc.checkinArea || ownerDoc.area || ownerDoc.locationCode || ownerDoc.profile?.locationCode || '';
    const aadhaarNumber =
        ownerDoc.checkinAadhaarNumber ||
        ownerDoc.kyc?.aadharNumber ||
        ownerDoc.kyc?.aadhaarNumber ||
        '';

    return { loginId, name, email, phone, area, aadhaarNumber };
}

function pickFirstText(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return '';
}

function buildAgreementContext(request = {}, approvalDetails = {}, ownerContact = {}) {
    const fullAddress = pickFirstText(
        approvalDetails.tenantAddress,
        request.full_address,
        request.address,
        [request.address_street, request.address_city, request.address_state, request.address_postal_code]
            .filter(Boolean)
            .join(', '),
        ''
    );
    return {
        tenantName: pickFirstText(approvalDetails.tenantName, request.name, request.tenantName),
        tenantAddress: fullAddress,
        tenantEmail: pickFirstText(approvalDetails.tenantEmail, request.email),
        tenantPhone: pickFirstText(approvalDetails.tenantPhone, request.phone),
        backupEmail: pickFirstText(approvalDetails.backupEmail, request.backupEmail),
        backupPhone: pickFirstText(approvalDetails.backupPhone, request.backupPhone),
        propertyName: pickFirstText(approvalDetails.propertyName, request.property_name, request.propertyName),
        propertyAddress: pickFirstText(approvalDetails.propertyAddress, request.propertyAddress, request.address, fullAddress),
        accommodationType: pickFirstText(approvalDetails.accommodationType, request.property_type, request.propertyType, request.type),
        roomNumber: pickFirstText(approvalDetails.roomNumber, request.roomNo, request.room_number, request.roomNumber),
        ownerName: pickFirstText(approvalDetails.ownerName, ownerContact.name, request.owner_name),
        rentAmount: pickFirstText(approvalDetails.rentAmount, request.rent_amount, request.rentAmount, request.total_amount, request.totalAmount, request.price),
        duration: pickFirstText(approvalDetails.duration, request.duration, request.booking_duration, request.term),
        licenseStartDate: pickFirstText(approvalDetails.licenseStartDate, request.check_in_date, request.checkInDate, request.start_date),
        licenseEndDate: pickFirstText(approvalDetails.licenseEndDate, request.check_out_date, request.checkOutDate, request.end_date),
        licenseFeeDueDate: pickFirstText(approvalDetails.licenseFeeDueDate, request.licenseFeeDueDate, '5'),
        moveOutCharges: pickFirstText(approvalDetails.moveOutCharges, request.moveOutCharges),
        noticePeriodCharges: pickFirstText(approvalDetails.noticePeriodCharges, request.noticePeriodCharges),
        securityDeposit: pickFirstText(approvalDetails.securityDeposit, request.securityDeposit, request.deposit),
        inclusions: pickFirstText(approvalDetails.inclusions, request.inclusions),
        minimumStayDuration: pickFirstText(approvalDetails.minimumStayDuration, request.minimumStayDuration, '3 Months'),
        gstCharges: pickFirstText(approvalDetails.gstCharges, request.gstCharges, '0')
    };
}

function buildOwnerAgreementEmail({ ownerName, tenantName, propertyName, approvalLabel, rentAmount, duration }) {
    const safeOwner = ownerName || 'Owner';
    const safeTenant = tenantName || 'Tenant';
    const safeProperty = propertyName || 'Property';
    const title = approvalLabel || 'Booking Approved';
    const safeRent = rentAmount || 'N/A';
    const safeDuration = duration || 'N/A';

    return {
        subject: `${title} - ${safeProperty} | Booking Agreement`,
        text: [
            `Hi ${safeOwner},`,
            '',
            `Your booking for ${safeProperty} has been approved.`,
            `Tenant: ${safeTenant}`,
            `Rent: ${safeRent}`,
            `Duration: ${safeDuration}`,
            '',
            'Please find your Booking Agreement PDF attached to this email.',
            '',
            'Thanks,',
            'RoomHy'
        ].join('\n'),
        html: `
            <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
                <div style="background:#0f172a;color:#fff;padding:18px 22px;">
                    <h2 style="margin:0;font-size:20px;">${title}</h2>
                </div>
                <div style="padding:22px;color:#111827;line-height:1.6;">
                    <p style="margin-top:0;">Hi ${safeOwner},</p>
                    <p>Your booking for <strong>${safeProperty}</strong> has been approved.</p>
                    <p><strong>Tenant:</strong> ${safeTenant}</p>
                    <p><strong>Rent:</strong> ${safeRent}</p>
                    <p><strong>Duration:</strong> ${safeDuration}</p>
                    <p>Please find your <strong>Booking Agreement PDF</strong> attached to this email. You may download and keep it for your records.</p>
                    <div style="margin:22px 0;padding:14px 18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;color:#166534;">
                        <strong>Agreement PDF is attached to this email.</strong>
                    </div>
                    <p style="font-size:12px;color:#6b7280;">This is an automated email from RoomHy.</p>
                </div>
            </div>
        `
    };
}

function generateBookingAgreementPdfBuffer(ctx, ownerContact) {
    return generateAgreementPdfBuffer({
        tenantName:          ctx.tenantName,
        tenantAddress:       ctx.tenantAddress,
        tenantEmail:         ctx.tenantEmail,
        tenantPhone:         ctx.tenantPhone,
        backupEmail:         ctx.backupEmail,
        backupPhone:         ctx.backupPhone,
        propertyName:        ctx.propertyName,
        propertyAddress:     ctx.propertyAddress,
        accommodationType:   ctx.accommodationType,
        roomNumber:          ctx.roomNumber,
        ownerName:           ownerContact.name || ctx.ownerName,
        rentAmount:          ctx.rentAmount,
        duration:            ctx.duration,
        licenseStartDate:    ctx.licenseStartDate,
        licenseEndDate:      ctx.licenseEndDate,
        licenseFeeDueDate:   ctx.licenseFeeDueDate,
        moveOutCharges:      ctx.moveOutCharges,
        noticePeriodCharges: ctx.noticePeriodCharges,
        securityDeposit:     ctx.securityDeposit,
        inclusions:          ctx.inclusions,
        minimumStayDuration: ctx.minimumStayDuration,
        gstCharges:          ctx.gstCharges,
        signatureDataUrl:    '',
        eSignName:           '',
        signedDate:          new Date().toISOString().slice(0, 10)
    });
}

async function createAndEmailOwnerAgreementForBooking(request, ownerDoc, approvalDetails = {}) {
    const ownerContact = resolveOwnerAgreementContact(ownerDoc || {}, request || {});
    if (!ownerContact.loginId) {
        return { sent: false, reason: 'missing_owner_loginId' };
    }

    if (!ownerContact.email) {
        return { sent: false, reason: 'missing_owner_email', ownerContact };
    }

    const agreementContext = buildAgreementContext(request, approvalDetails, ownerContact);
    const pdfBuffer = await generateBookingAgreementPdfBuffer(agreementContext, ownerContact);

    const agreementPayload = {
        provider: 'roomhy-pdf',
        requestId: '',
        signUrl: '',
        status: 'agreement_sent',
        initiatedAt: new Date(),
        callbackPayload: {
            source: 'booking-approval',
            bookingId: String(request._id || ''),
            propertyId: String(request.property_id || ''),
            propertyName: String(request.property_name || ''),
            tenantName: String(request.name || ''),
            tenantEmail: String(request.email || ''),
            requestType: String(request.request_type || '')
        }
    };

    const record = await CheckinRecord.findOneAndUpdate(
        { loginId: ownerContact.loginId, role: 'owner' },
        {
            $setOnInsert: {
                loginId: ownerContact.loginId,
                role: 'owner'
            },
            $set: {
                ownerProfile: {
                    name: ownerContact.name,
                    email: ownerContact.email,
                    phone: ownerContact.phone,
                    address: ownerDoc?.address || ownerDoc?.profile?.address || '',
                    area: ownerContact.area
                },
                ownerKyc: {
                    ...(ownerDoc?.kyc || {}),
                    aadhaarNumber: ownerContact.aadhaarNumber
                },
                ownerAgreement: agreementPayload
            }
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (ownerDoc && typeof ownerDoc.save === 'function') {
        ownerDoc.agreementRequestId = ownerDoc.agreementRequestId || '';
        ownerDoc.agreementStatus = 'agreement_sent';
        ownerDoc.isActive = Boolean(ownerDoc.isActive);
        await ownerDoc.save();
    }

    const emailContent = buildOwnerAgreementEmail({
        ownerName: ownerContact.name,
        tenantName: agreementContext.tenantName || request.name || 'Tenant',
        propertyName: agreementContext.propertyName || request.property_name || 'Property',
        approvalLabel: 'Booking Approved',
        rentAmount: agreementContext.rentAmount,
        duration: agreementContext.duration
    });

    await mailer.sendMail(ownerContact.email, emailContent.subject, emailContent.text, emailContent.html, {
        attachments: [
            {
                filename: `RoomHy-Booking-Agreement-${ownerContact.loginId}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }
        ]
    });

    return {
        sent: true,
        ownerContact,
        agreement: { provider: 'roomhy-pdf', requestId: '', status: 'agreement_sent' },
        record,
        agreementContext
    };
}

function formatErrorDetails(err) {
    if (!err) return { message: 'Unknown error' };
    if (typeof err === 'string') return { message: err };
    return {
        message: err.message || String(err),
        status: err.status || err.statusCode || null,
        data: err.data || null,
        responseStatus: err.response?.status || null,
        responseData: err.response?.data || null
    };
}

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

async function ensureChatRoomsForBooking({ bookingId, ownerId, ownerName, userId, userName, userEmail, propertyName }) {
    const normalizedOwnerId = String(ownerId || '').trim().toUpperCase();
    const normalizedUserId = generateWebsiteUserIdFromEmail(userEmail) || normalizeWebsiteUserId(userId);
    if (!normalizedOwnerId || !normalizedUserId) return null;

    const participants = [
        { loginId: normalizedOwnerId, role: 'property_owner' },
        { loginId: normalizedUserId, role: 'website_user' }
    ];

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

    const intro = `Chat opened for ${propertyName || 'property'} between ${ownerName || normalizedOwnerId} and ${userName || userEmail || normalizedUserId} (booking ${bookingId})`;
    const existingIntro = await ChatMessage.findOne({
        room_id: normalizedOwnerId,
        sender_login_id: 'system',
        message: intro
    }).lean();

    if (!existingIntro) {
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

    return { ownerRoomId: normalizedOwnerId, userRoomId: normalizedUserId };
}

// ==================== BOOKING REQUEST OPERATIONS ====================

/**
 * CREATE BOOKING REQUEST OR BID
 * Auto-generates chat_room_id, routes to property owner, creates property hold if bid
 */
exports.createBookingRequest = async (req, res) => {
    try {
        console.log('📨 Booking Request Received:', JSON.stringify(req.body, null, 2));
        
        const { 
            property_id, property_name, area, property_type, rent_amount,
            user_id, owner_id, name, phone, email, request_type, bid_amount, message,
            bid_min, bid_max, filter_criteria, whatsapp_enabled, chat_enabled
        } = req.body;

        // Validation
        if (!property_id || !user_id || !request_type) {
            console.warn('❌ Missing required fields');
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields: property_id, user_id, request_type' 
            });
        }

        // ✅ NEW: Validate owner_id is present
        if (!owner_id) {
            console.warn('❌ owner_id is missing from request');
            return res.status(400).json({
                success: false,
                message: 'Property owner ID is required'
            });
        }

        console.log(`✅ Creating ${request_type} for property: ${property_name}, owner: ${owner_id}`);

        // Find area manager by area (for notifications)
        const manager = await User.findOne({ role: 'area_manager', area: area });
        
        // Find owner to get owner name/email (supports both User and Owner collections)
        const ownerLoginId = String(owner_id || '').toUpperCase();
        const owner = await User.findOne({ loginId: ownerLoginId });
        const ownerProfile = await Owner.findOne({ loginId: ownerLoginId });
        const ownerName = owner
            ? owner.fullName || owner.name || owner.loginId
            : (ownerProfile?.profile?.name || ownerProfile?.name || ownerLoginId);
        const ownerEmail = owner?.email || ownerProfile?.email || ownerProfile?.profile?.email || '';
        console.log(`📍 Owner found: ${ownerName}`);
        
        // Generate unique chat room ID
        const chatRoomId = `chat_${property_id}_${Date.now()}`;

        // ✅ UPDATED: Create booking with owner_id and owner_name properly set
        const newRequest = new BookingRequest({
            property_id,
            property_name,
            area,
            city: req.body.city || filter_criteria?.city || null,
            property_type,
            rent_amount,
            user_id,
            name,
            phone: phone || null,  // Allow null if phone not provided
            email,
            owner_id,                      // ✅ SET OWNER ID FROM REQUEST
            owner_name: ownerName,          // ✅ SET OWNER NAME FROM USER DB
            request_type,
            bid_amount: request_type === 'bid' ? (bid_amount || 500) : 0,
            bid_min: request_type === 'bid' ? (bid_min || null) : null,
            bid_max: request_type === 'bid' ? (bid_max || null) : null,
            filter_criteria: filter_criteria || {},
            message,
            whatsapp_enabled: whatsapp_enabled || true,
            area_manager_id: manager ? manager._id : null,
            status: 'pending',
            visit_status: 'not_scheduled',
            latitude: req.body.latitude || null,
            longitude: req.body.longitude || null
        });

        await newRequest.save();
        console.log(`✅ Booking saved with ID: ${newRequest._id}`);

        // Create owner in-app notification for real-time panel alerts.
        try {
            let notificationMessage = `You have a new ${request_type} request for ${property_name}.`;
            if (request_type === 'bid' && bid_amount && rent_amount && bid_amount < rent_amount) {
                notificationMessage = `A user (${name}) is interested in ${property_name}. Their budget is ₹${bid_amount}, but your rent is ₹${rent_amount}. Can you offer a lower rate?`;
            }

            await Notification.create({
                toRole: 'owner',
                toLoginId: ownerLoginId,
                from: name || 'Interested User',
                type: 'owner_new_booking_request', // Reverted from match type
                meta: {
                    title: request_type === 'bid' ? 'New Bid Received!' : 'New Booking Request!',
                    bookingId: String(newRequest._id || ''),
                    propertyName: property_name || '',
                    guestName: name || '',
                    message: notificationMessage,
                    amount: bid_amount || rent_amount || 0,
                    chatEnabled: true
                },
                read: false
            });
        } catch (notifyErr) {
            console.warn('Failed to create owner booking notification:', notifyErr.message);
        }
        
        if (request_type === 'bid') {
            const holdExpiry = new Date();
            holdExpiry.setDate(holdExpiry.getDate() + 7); // 7-day hold

            // Store hold info in booking (simplified approach)
            newRequest.hold_expiry_date = holdExpiry;
            newRequest.payment_status = 'pending'; // ✅ Use valid enum value
            await newRequest.save();
        }

        // Send email notification to owner
        try {
            if (ownerEmail) {
                const mailer = require('../utils/mailer');
                const subject = `New ${request_type.charAt(0).toUpperCase() + request_type.slice(1)} Request`;
                const html = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #333;">New Booking Request</h2>
                        <p>You have received a new ${request_type} request for your property.</p>
                        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                            <p><strong>Property:</strong> ${property_name}</p>
                            <p><strong>Tenant:</strong> ${name}</p>
                            <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
                            <p><strong>Email:</strong> ${email || 'N/A'}</p>
                            <p><strong>Type:</strong> ${request_type.charAt(0).toUpperCase() + request_type.slice(1)}</p>
                            ${request_type === 'bid' ? `<p><strong>Bid Amount:</strong> ₹${bid_amount || 0}</p>` : ''}
                            ${message ? `<p><strong>Message:</strong> ${message}</p>` : ''}
                        </div>
                        <p>Please review this request in your booking requests panel.</p>
                    </div>
                `;
                await mailer.sendMail(ownerEmail, subject, '', html);
            }
            try {
                await sendTemplateToResolvedUser({
                    email: ownerEmail || '',
                    userId: owner_id || '',
                    templateName: 'roomhy_booking_received',
                    variables: [
                        ownerName || 'Owner',
                        property_name || 'Property',
                        name || 'Guest',
                        req.body.check_in_date || req.body.move_in_date || 'Not specified'
                    ]
                });
            } catch (whatsAppErr) {
                console.warn('booking received whatsapp failed:', whatsAppErr.message);
            }
        } catch (emailError) {
            console.error('Failed to send booking request notification email/WhatsApp:', emailError);
        }

        // Send superadmin in-app + email notification
        try {
            await notifySuperadmin({
                type: 'new_booking',
                from: 'website',
                subject: `New ${request_type.charAt(0).toUpperCase() + request_type.slice(1)} Submitted`,
                message: 'A new booking request is waiting for review in Superadmin.',
                meta: {
                    bookingId: String(newRequest._id || ''),
                    propertyName: property_name || '',
                    ownerId: owner_id || '',
                    guestName: name || '',
                    guestEmail: email || '',
                    requestType: request_type || 'request',
                    bidAmount: request_type === 'bid' ? (bid_amount || 0) : ''
                }
            });
        } catch (emailError) {
            console.error('Failed to send booking request notification to superadmin:', emailError);
        }
        res.status(201).json({
            success: true,
            message: `${request_type.charAt(0).toUpperCase() + request_type.slice(1)} submitted successfully`,
            data: newRequest
        });
    } catch (error) {
        console.error('❌ Error creating booking:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: error.message,
            details: error.stack
        });
    }
};

/**
 * CREATE BULK BOOKING REQUEST
 * Creates a single booking request that appears for multiple property owners
 */
exports.createBulkBookingRequest = async (req, res) => {
    try {
        const {
            owner_ids, property_filters, user_id, name, phone, email, bid_amount, message,
            whatsapp_enabled, chat_enabled
        } = req.body;

        // Validation
        if (!owner_ids || !Array.isArray(owner_ids) || owner_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'owner_ids array is required and cannot be empty'
            });
        }

        if (!user_id || !name || !phone) {
            return res.status(400).json({
                success: false,
                message: 'user_id, name, and phone are required'
            });
        }

        // Create a single bulk booking request
        const newRequest = new BookingRequest({
            property_id: 'bulk_request', // Special identifier for bulk requests
            property_name: 'Bulk Property Request',
            area: property_filters?.area || 'Multiple Areas',
            property_type: property_filters?.property_type || 'Multiple Types',
            rent_amount: 0, // Not applicable for bulk
            user_id,
            name,
            phone,
            email,
            owner_ids, // Array of owner IDs instead of single owner_id
            request_type: 'bulk_request',
            bid_amount: bid_amount || 0,
            message: message || `Bulk request for ${owner_ids.length} properties matching filters`,
            whatsapp_enabled: whatsapp_enabled || true,
            area_manager_id: null, // Not applicable for bulk
            status: 'pending',
            visit_status: 'not_scheduled',
            property_filters, // Store the filters used for this bulk request
            is_bulk_request: true // Flag to identify bulk requests
        });

        await newRequest.save();

        // Send email notifications to all owners
        const mailer = require('../utils/mailer');
        let successCount = 0;
        let failureCount = 0;

        for (const ownerId of owner_ids) {
            try {
                const owner = await User.findOne({ loginId: ownerId });
                if (owner && owner.email) {
                    const subject = `New Bulk Booking Request`;
                    const html = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2 style="color: #333;">New Bulk Booking Request</h2>
                            <p>You have received a new bulk booking request from a tenant.</p>
                            <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                                <p><strong>Tenant:</strong> ${name}</p>
                                <p><strong>Phone:</strong> ${phone}</p>
                                <p><strong>Email:</strong> ${email}</p>
                                <p><strong>Bid Amount:</strong> ₹${bid_amount || 0}</p>
                                ${message ? `<p><strong>Message:</strong> ${message}</p>` : ''}
                                <p><strong>Filter Applied:</strong> ${property_filters ? JSON.stringify(property_filters, null, 2) : 'All properties'}</p>
                            </div>
                            <p>This request matches your property filters. Please review it in your booking requests panel.</p>
                        </div>
                    `;
                    await mailer.sendMail(owner.email, subject, '', html);
                    successCount++;
                }
            } catch (emailError) {
                console.error(`Failed to send bulk booking notification to owner ${ownerId}:`, emailError);
                failureCount++;
            }
        }

        // Send superadmin in-app + email notification
        try {
            await notifySuperadmin({
                type: 'new_booking',
                from: 'website',
                subject: 'New Bulk Booking Request Submitted',
                message: 'A new bulk booking request is waiting for review in Superadmin.',
                meta: {
                    bookingId: String(newRequest._id || ''),
                    guestName: name || '',
                    guestEmail: email || '',
                    ownerCount: owner_ids.length || 0,
                    bidAmount: bid_amount || 0,
                    filters: property_filters ? JSON.stringify(property_filters) : 'All properties',
                    notifiedOwners: `${successCount} success / ${failureCount} failed`
                }
            });
        } catch (emailError) {
            console.error('Failed to send bulk booking notification to superadmin:', emailError);
        }
        res.status(201).json({
            success: true,
            message: `Bulk booking request created successfully. Notifications sent to ${successCount} property owners.`,
            data: {
                ...newRequest.toObject(),
                email_notifications_sent: successCount,
                email_notifications_failed: failureCount
            }
        });
    } catch (error) {
        console.error('Error creating bulk booking:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET ALL BOOKING REQUESTS
 * Supports filtering by area, request_type, status, owner_id, or manager_id
 * Now also supports bulk requests that appear for multiple owners
 */
exports.getBookingRequests = async (req, res) => {
    try {
        const { area, manager_id, owner_id, user_id, email, type, status } = req.query;
        let query = {};

        // ✅ NEW: Support email query param for website users
        if (email) {
            console.log(`🔍 Fetching bookings for email: ${email}`);
            query.email = email;
        } 
        // ✅ NEW: Support owner_id query param for property owner panel
        else if (owner_id) {
            console.log(`🔍 Fetching bookings for owner_id: ${owner_id}`);
            // For bulk requests, check if owner_id is in the owner_ids array
            query.$or = [
                { owner_id: owner_id }, // Regular requests
                { owner_ids: { $in: [owner_id] }, is_bulk_request: true } // Bulk requests
            ];
        } else if (user_id) {
            query.user_id = user_id;
        } else if (manager_id) {
            // ✅ Keep area_manager_id filtering for area managers
            query.area_manager_id = manager_id;
        }

        if (area) query.area = area;
        if (type) query.request_type = type;
        if (status) query.status = status;

        const requests = await BookingRequest.find(query)
            .sort({ created_at: -1 })
            .lean();

        console.log(`📊 Found ${requests.length} bookings for query:`, JSON.stringify(query));
        
        // Log request_type values for debugging
        if (requests.length > 0) {
            const requestTypes = requests.map(r => r.request_type);
            console.log(`📋 request_type values in response:`, requestTypes);
            console.log(`📋 First booking structure:`, JSON.stringify(requests[0], null, 2));
        }

        res.status(200).json({
            success: true,
            total: requests.length,
            data: requests
        });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET BOOKING REQUEST BY ID
 */
exports.getBookingRequestById = async (req, res) => {
    try {
        const request = await BookingRequest.findById(req.params.id);

        if (!request) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        res.status(200).json({ 
            success: true, 
            data: request 
        });
    } catch (error) {
        console.error('Error fetching booking:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * GET USER BOOKINGS (for tenant's mystays.html)
 * Fetches all confirmed bookings for a specific user with property details
 */
exports.getUserBookings = async (req, res) => {
    try {
        const { userId } = req.params;
        const emailFromQuery = String(req.query.email || '').trim().toLowerCase();

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        const normalizedUserId = String(userId).trim();
        const normalizedUserIdLower = normalizedUserId.toLowerCase();
        const normalizedUserIdUpper = normalizedUserId.toUpperCase();
        const identityCandidates = [normalizedUserId, normalizedUserIdLower, normalizedUserIdUpper];
        const emailCandidates = emailFromQuery
            ? [emailFromQuery]
            : (normalizedUserId.includes('@') ? [normalizedUserIdLower] : []);

        console.log(`Fetching bookings for user: ${normalizedUserId}`, {
            emailFromQuery: emailFromQuery || null
        });

        const bookings = await BookingRequest.find({
            $and: [
                {
                    $or: [
                        { user_id: { $in: identityCandidates } },
                        { email: { $in: emailCandidates } }
                    ]
                },
                {
                    $or: [
                        { booking_status: { $in: ['confirmed', 'active', 'completed'] } },
                        { bookingStatus: { $in: ['confirmed', 'active', 'completed'] } },
                        { status: { $in: ['confirmed', 'booked', 'accepted'] } }
                    ]
                }
            ]
        }).sort({ createdAt: -1, created_at: -1 });

        console.log(`Found ${bookings.length} bookings for user ${normalizedUserId}`);

        res.status(200).json({
            success: true,
            data: bookings
        });
    } catch (error) {
        console.error('Error fetching user bookings:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * UPDATE BOOKING STATUS
 * Handles status change and optional visit information
 */
exports.updateBookingStatus = async (req, res) => {
    try {
        const { status, visit_type, visit_date, visit_time_slot, visit_status, bookingId } = req.body;
        
        // Support both /requests/:id/status (id in params) and /update (id in body as bookingId)
        const id = req.params.id || bookingId;
        
        if (!id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Booking ID is required' 
            });
        }

        const updateData = {
            status,
            updated_at: Date.now()
        };

        // Update visit info if provided
        if (visit_type) updateData.visit_type = visit_type;
        if (visit_date) updateData.visit_date = visit_date;
        if (visit_time_slot) updateData.visit_time_slot = visit_time_slot;
        if (visit_status) updateData.visit_status = visit_status;

        const request = await BookingRequest.findByIdAndUpdate(
            id, 
            updateData, 
            { new: true }
        );

        if (!request) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        res.status(200).json({ 
            success: true, 
            message: 'Booking status updated',
            data: request 
        });
    } catch (error) {
        console.error('Error updating booking status:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * APPROVE BOOKING
 * Changes status to 'confirmed'
 */
exports.approveBooking = async (req, res) => {
    try {
        const request = await BookingRequest.findByIdAndUpdate(
            req.params.id,
            {
                status: 'confirmed',
                booking_status: 'confirmed',
                bookingStatus: 'confirmed',
                updated_at: Date.now()
            },
            { new: true }
        );

        if (!request) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        let chat = null;
        let ownerAgreementResult = null;
        const approvalDetails =
            req.body?.agreementDetails ||
            req.body?.approvalDetails ||
            req.body?.ownerAgreement ||
            {};
        console.log('[BOOKING APPROVE] agreementDetails received', {
            bookingId: String(req.params.id || ''),
            keys: Object.keys(approvalDetails || {}),
            tenantName: approvalDetails?.tenantName || '',
            tenantEmail: approvalDetails?.tenantEmail || '',
            propertyName: approvalDetails?.propertyName || '',
            roomNumber: approvalDetails?.roomNumber || '',
            rentAmount: approvalDetails?.rentAmount ?? '',
            ownerName: approvalDetails?.ownerName || '',
            duration: approvalDetails?.duration || ''
        });

        // Send email notification to tenant
        try {
            const { sendBookingAcceptanceEmail } = require('../utils/emailNotifications');
            const tenantName = request.name || 'Valued Guest';
            const propertyName = request.property_name || 'Property';
            const ownerDoc = await Owner.findOne({ loginId: String(request.owner_id || '').toUpperCase() });
            const ownerName =
                req.body.owner_name ||
                request.owner_name ||
                ownerDoc?.profile?.name ||
                ownerDoc?.name ||
                'Property Owner';
            
            if (String(request.request_type || '').toLowerCase() === 'bid') {
                const subject = `Bid Accepted - ${propertyName}`;
                const html = `
                    <div style="font-family: Arial, sans-serif; font-size: 14px;">
                        <h2>Your Bid Has Been Accepted</h2>
                        <p>Hi ${tenantName},</p>
                        <p>Your bid for <strong>${propertyName}</strong> has been accepted by <strong>${ownerName}</strong>.</p>
                        <p><strong>Minimum Amount:</strong> INR ${request.bid_min || '-'}</p>
                        <p><strong>Maximum Amount:</strong> INR ${request.bid_max || '-'}</p>
                        <p>You can now continue the conversation in Roomhy chat.</p>
                    </div>
                `;
                const text = `Your bid for ${propertyName} has been accepted by ${ownerName}.`;
                if (request.email) {
                    await mailer.sendMail(request.email, subject, text, html);
                }
            } else {
                await sendBookingAcceptanceEmail(
                    request.email,
                    tenantName,
                    propertyName,
                    ownerName
                );
            }
            chat = await ensureChatRoomsForBooking({
                bookingId: String(request._id || ''),
                ownerId: request.owner_id,
                ownerName,
                userId: request.user_id,
                userName: tenantName,
                userEmail: request.email,
                propertyName
            });

            // Create in-app notification
            const notificationEndpoint = `${process.env.API_URL || 'https://api.roomhy.com'}/api/website-enquiry/notifications/create`;
            await fetch(notificationEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: request.user_id,
                    title: 'Booking Accepted! 🎉',
                    message: `Your booking for ${propertyName} has been accepted`,
                    type: 'booking_accept',
                    relatedId: request._id,
                    actionUrl: '/website/mystays'
                })
            }).catch(err => console.log('Notification API call failed:', err.message));

            try {
                await sendTemplateToResolvedUser({
                    email: request.email || '',
                    userId: request.user_id || '',
                    templateName: 'roomhy_booking_approved',
                    variables: [tenantName, propertyName]
                });
            } catch (whatsAppErr) {
                console.warn('booking approved whatsapp failed:', whatsAppErr.message);
            }

            try {
                ownerAgreementResult = await createAndEmailOwnerAgreementForBooking(request, ownerDoc, approvalDetails);
            } catch (agreementErr) {
                console.warn('owner agreement creation failed:', formatErrorDetails(agreementErr));
            }
        } catch (emailErr) {
            console.error('Error sending approval email:', emailErr);
        }

        res.status(200).json({ 
            success: true, 
            message: String(request.request_type || '').toLowerCase() === 'bid'
                ? 'Bid approved, user notified, and chat room created'
                : 'Booking approved and notification sent',
            data: request,
            chat,
            ownerAgreement: ownerAgreementResult ? {
                sent: ownerAgreementResult.sent,
                requestId: ownerAgreementResult.agreement?.requestId || '',
                signUrl: ownerAgreementResult.agreement?.signUrl || '',
                status: ownerAgreementResult.agreement?.status || 'pending_signature',
                reason: ownerAgreementResult.reason || ''
            } : { sent: false }
        });
    } catch (error) {
        console.error('Error approving booking:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * REJECT BOOKING
 * Changes status to 'rejected'
 */
exports.rejectBooking = async (req, res) => {
    try {
        const request = await BookingRequest.findByIdAndUpdate(
            req.params.id,
            {
                status: 'rejected',
                updated_at: Date.now()
            },
            { new: true }
        );

        if (!request) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        try {
            await sendTemplateToResolvedUser({
                email: request.email || '',
                userId: request.user_id || '',
                templateName: 'roomhy_booking_rejected',
                variables: [request.property_name || 'Property', request.name || 'Guest']
            });
        } catch (whatsAppErr) {
            console.warn('booking rejected whatsapp failed:', whatsAppErr.message);
        }

        res.status(200).json({ 
            success: true, 
            message: 'Booking rejected',
            data: request 
        });
    } catch (error) {
        console.error('Error rejecting booking:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * SCHEDULE VISIT
 * Updates visit details and changes visit_status to 'scheduled'
 */
exports.scheduleVisit = async (req, res) => {
    try {
        const { visit_type, visit_date, visit_time_slot, visit_notes, visit_duration, contact_phone, contact_email } = req.body;

        if (!visit_type || !visit_date || !visit_time_slot) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: visit_type, visit_date, visit_time_slot'
            });
        }

        const request = await BookingRequest.findByIdAndUpdate(
            req.params.id,
            {
                visit_type,
                visit_date,
                visit_time_slot,
                visit_notes,
                visit_duration,
                contact_phone,
                contact_email,
                visit_status: 'scheduled',
                status: 'confirmed',
                updated_at: Date.now()
            },
            { new: true }
        );

        if (!request) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        res.status(200).json({ 
            success: true, 
            message: 'Visit scheduled successfully',
            data: request 
        });
    } catch (error) {
        console.error('Error scheduling visit:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * DELETE BOOKING
 */
exports.deleteBooking = async (req, res) => {
    try {
        const request = await BookingRequest.findByIdAndDelete(req.params.id);

        if (!request) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        res.status(200).json({ 
            success: true, 
            message: 'Booking deleted successfully',
            data: request 
        });
    } catch (error) {
        console.error('Error deleting booking:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

// ==================== CHAT MESSAGE OPERATIONS ====================

/**
 * SEND MESSAGE
 * Creates a chat message linked to a booking
 */
exports.sendMessage = async (req, res) => {
    return res.status(410).json({ 
        success: false, 
        message: 'Chat functionality has been removed' 
    });
};

// ==================== PROPERTY HOLD OPERATIONS ====================

/**
 * CHECK PROPERTY HOLD
 * Returns whether a property is currently on hold
 */
exports.checkPropertyHold = async (req, res) => {
    try {
        const { property_id } = req.params;

        // Find active bid/request for this property
        const booking = await BookingRequest.findOne({
            property_id,
            request_type: 'bid',
            status: { $in: ['pending', 'confirmed'] }
        });

        if (!booking) {
            return res.status(200).json({ 
                success: true, 
                is_on_hold: false,
                message: 'Property is not on hold'
            });
        }

        const now = new Date();
        const isOnHold = booking.hold_expiry_date && new Date(booking.hold_expiry_date) > now;

        res.status(200).json({ 
            success: true, 
            is_on_hold: isOnHold,
            booking_id: booking._id,
            hold_expiry_date: booking.hold_expiry_date,
            message: isOnHold ? 'Property is currently on hold' : 'Hold has expired'
        });
    } catch (error) {
        console.error('Error checking property hold:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * RELEASE PROPERTY HOLD
 * Releases the hold on a property
 */
exports.releasePropertyHold = async (req, res) => {
    try {
        const { property_id } = req.params;

        const booking = await BookingRequest.findOneAndUpdate(
            {
                property_id,
                request_type: 'bid'
            },
            {
                hold_expiry_date: null,
                updated_at: Date.now()
            },
            { new: true }
        );

        if (!booking) {
            return res.status(404).json({ 
                success: false, 
                message: 'No active hold found for this property' 
            });
        }

        res.status(200).json({ 
            success: true, 
            message: 'Property hold released successfully',
            data: booking 
        });
    } catch (error) {
        console.error('Error releasing property hold:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

/**
 * UPDATE CHAT DECISION (LIKE/REJECT)
 * Updates owner_liked, user_liked, owner_rejected, or user_rejected
 */
exports.updateChatDecision = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision, userType } = req.body; // decision: 'like' or 'reject', userType: 'owner' or 'user'

        if (!['like', 'reject'].includes(decision) || !['owner', 'user'].includes(userType)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid decision or userType' 
            });
        }

        const updateField = userType === 'owner' ? 
            (decision === 'like' ? 'owner_liked' : 'owner_rejected') : 
            (decision === 'like' ? 'user_liked' : 'user_rejected');

        const booking = await BookingRequest.findByIdAndUpdate(
            id,
            { 
                [updateField]: true,
                updated_at: Date.now()
            },
            { new: true }
        );

        if (!booking) {
            return res.status(404).json({ 
                success: false, 
                message: 'Booking request not found' 
            });
        }

        // Check if both liked
        if (booking.owner_liked && booking.user_liked) {
            // Set status to confirmed and schedule visit
            booking.status = 'confirmed';
            booking.visit_status = 'scheduled';
            booking.visit_date = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
            booking.visit_time_slot = '10:00 AM - 12:00 PM'; // Default slot
            await booking.save();

            // Send email notification to superadmin about confirmed booking
            try {
                const mailer = require('../utils/mailer');
                const superadminEmail = 'roomhy01@gmail.com';
                const subject = 'New Scheduled Booking Confirmed';
                const html = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2 style="color: #333;">New Booking Confirmed</h2>
                        <p>A booking has been confirmed through chat agreement.</p>
                        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                            <p><strong>Property:</strong> ${booking.property_name || 'N/A'}</p>
                            <p><strong>Tenant:</strong> ${booking.name || 'N/A'}</p>
                            <p><strong>Owner:</strong> ${booking.owner_name || 'N/A'}</p>
                            <p><strong>Rent:</strong> ₹${booking.rent_amount || 0}</p>
                            <p><strong>Visit Date:</strong> ${booking.visit_date ? new Date(booking.visit_date).toLocaleDateString() : 'Not scheduled'}</p>
                            <p><strong>Visit Time:</strong> ${booking.visit_time_slot || 'Not specified'}</p>
                        </div>
                        <p>Please review the booking details in the superadmin panel.</p>
                    </div>
                `;
                await mailer.sendMail(superadminEmail, subject, '', html);
            } catch (emailError) {
                console.error('Failed to send booking confirmation notification email:', emailError);
            }
        }

        // Check if anyone rejected
        if (booking.owner_rejected || booking.user_rejected) {
            // Close chat by setting status to rejected
            booking.status = 'rejected';
            await booking.save();
        }

        res.status(200).json({ 
            success: true, 
            message: 'Decision updated successfully',
            data: booking 
        });
    } catch (error) {
        console.error('Error updating chat decision:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
};

// ==================== BOOKING CONFIRMATION (FROM BOOKING FORM) ====================

/**
 * CONFIRM BOOKING FROM BOOKING FORM
 * Saves the complete booking with tenant info, payment details, and property info
 */
exports.confirmBooking = async (req, res) => {
    try {
        const {
            userId,
            user_id,
            paymentId,
            payment_id,
            bookingStatus,
            paymentAmount,
            payment_amount,
            fullName,
            name,
            phone,
            email,
            guardianName,
            guardian_name,
            guardianPhone,
            guardian_phone,
            address,
            address_street,
            address_city,
            address_state,
            address_postal_code,
            address_country,
            propertyId,
            property_id,
            propertyName,
            property_name,
            ownerName,
            owner_name,
            ownerId,
            owner_id,
            rentAmount,
            rent_amount,
            area,
            propertyType,
            property_type,
            request_type,
            paymentMethod,
            payment_method,
            paymentStatus,
            payment_status,
            bidAmount,
            bid_amount,
            message,
            bookedAt,
            status,
            // Booking dates and amounts
            checkInDate,
            check_in_date,
            checkOutDate,
            check_out_date,
            totalAmount,
            total_amount,
            propertyImage,
            property_image,
            propertyPhotos,
            property_photos
        } = req.body;

        // Normalize field names (handle both camelCase and snake_case)
        const normalizedUserId = userId || user_id;
        const normalizedPaymentId = paymentId || payment_id;
        const normalizedName = name || fullName;
        const normalizedPropertyId = property_id || propertyId;
        const normalizedPropertyName = property_name || propertyName || normalizedPropertyId || 'Property';
        const normalizedOwnerId = owner_id || ownerId;
        const normalizedOwnerName = owner_name || ownerName;
        const normalizedArea = area;
        const normalizedRequestType = request_type || 'request';
        const normalizedRent = rent_amount || rentAmount;
        const normalizedPropertyType = property_type || propertyType;
        const normalizedGuardianName = guardian_name || guardianName;
        const normalizedGuardianPhone = guardian_phone || guardianPhone;
        const normalizedPaymentAmount = payment_amount || paymentAmount;
        const normalizedPaymentMethod = payment_method || paymentMethod || 'razorpay';
        const normalizedPaymentStatus = payment_status || paymentStatus || 'completed';
        const normalizedBidAmount = bid_amount || bidAmount;

        // Validation - userId and paymentId are required
        if (!normalizedUserId || !normalizedPaymentId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: userId, paymentId'
            });
        }

        // Check core required fields (area and owner_id can be optional/from booking request)
        if (!normalizedName || !email || !normalizedPropertyId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required booking information. Please provide: name, email, property_id'
            });
        }

        // Use defaults for optional fields if not provided
        const finalArea = normalizedArea || 'N/A';
        const finalOwnerId = normalizedOwnerId || 'owner_unknown';
        const finalOwnerName = normalizedOwnerName || 'Unknown Owner';

        // Build address string
        let fullAddress = 'N/A';
        if (address) {
            fullAddress = typeof address === 'string' ? address : 
                `${address.street || ''}, ${address.city || ''}, ${address.state || ''}, ${address.postalCode || ''}`.trim();
        } else if (address_street || address_city || address_state || address_postal_code) {
            fullAddress = `${address_street || ''}, ${address_city || ''}, ${address_state || ''}, ${address_postal_code || ''}`.replace(/^,\s*|,\s*$/g, '').trim();
        }

        // Create booking confirmation record with all fields
        const booking = new BookingRequest({
            user_id: normalizedUserId,
            payment_id: normalizedPaymentId,
            paymentId: normalizedPaymentId,
            payment_amount: normalizedPaymentAmount,
            payment_method: normalizedPaymentMethod,
            payment_status: normalizedPaymentStatus,
            name: normalizedName,
            phone: phone,
            email: email,
            guardian_name: normalizedGuardianName,
            guardian_phone: normalizedGuardianPhone,
            property_id: normalizedPropertyId,
            property_name: normalizedPropertyName,
            owner_id: finalOwnerId,
            owner_name: finalOwnerName,
            rent_amount: normalizedRent,
            area: finalArea,
            property_type: normalizedPropertyType,
            request_type: normalizedRequestType,
            address_street: address_street,
            address_city: address_city,
            address_state: address_state,
            address_postal_code: address_postal_code,
            address_country: address_country,
            full_address: fullAddress,
            bid_amount: normalizedBidAmount || 0,
            message: message || `Booking confirmed via booking form with payment ${normalizedPaymentId}`,
            status: status || 'confirmed',
            booking_status: bookingStatus || 'confirmed',
            bookingStatus: bookingStatus || 'confirmed',
            // Booking dates
            check_in_date: checkInDate || check_in_date,
            checkInDate: checkInDate || check_in_date,
            check_out_date: checkOutDate || check_out_date,
            checkOutDate: checkOutDate || check_out_date,
            // Booking amounts
            total_amount: totalAmount || total_amount || normalizedPaymentAmount,
            totalAmount: totalAmount || total_amount || normalizedPaymentAmount,
            price: totalAmount || total_amount || normalizedPaymentAmount,
            // Property images
            propertyImage: propertyImage || property_image,
            property_image: propertyImage || property_image,
            propertyPhotos: propertyPhotos || property_photos || [],
            property_photos: propertyPhotos || property_photos || [],
            created_at: new Date(),
            updated_at: new Date()
        });

        await booking.save();

        // Email notifications: tenant + owner + superadmin (booking confirmation / transaction)
        try {
            const paymentRef = normalizedPaymentId || 'N/A';
            const amountValue = normalizedPaymentAmount || 0;
            const propertyLabel = normalizedPropertyName || normalizedPropertyId || 'Property';

            // Tenant confirmation
            if (email) {
                const tenantHtml = `
                    <div style="font-family: Arial, sans-serif; font-size: 14px;">
                        <h2>Booking Confirmed</h2>
                        <p>Hi ${normalizedName || 'Guest'},</p>
                        <p>Your booking is confirmed for <strong>${propertyLabel}</strong>.</p>
                        <p><strong>Transaction ID:</strong> ${paymentRef}</p>
                        <p><strong>Amount:</strong> INR ${amountValue}</p>
                    </div>
                `;
                await mailer.sendMail(email, `Booking Confirmed - ${propertyLabel}`, '', tenantHtml);
            }

            // Owner confirmation
            let ownerEmail = '';
            if (finalOwnerId && finalOwnerId !== 'owner_unknown') {
                const ownerUser = await User.findOne({ loginId: finalOwnerId }).lean();
                const ownerRecord = await Owner.findOne({ loginId: finalOwnerId }).lean();
                ownerEmail =
                    (ownerUser && ownerUser.email) ||
                    (ownerRecord && ownerRecord.email) ||
                    (ownerRecord && ownerRecord.profile && ownerRecord.profile.email) ||
                    '';
            }

            if (ownerEmail) {
                const ownerHtml = `
                    <div style="font-family: Arial, sans-serif; font-size: 14px;">
                        <h2>New Booking Confirmed</h2>
                        <p>Property: <strong>${propertyLabel}</strong></p>
                        <p>Tenant: <strong>${normalizedName || 'N/A'}</strong></p>
                        <p>Transaction ID: <strong>${paymentRef}</strong></p>
                        <p>Amount: <strong>INR ${amountValue}</strong></p>
                    </div>
                `;
                await mailer.sendMail(ownerEmail, `New Booking - ${propertyLabel}`, '', ownerHtml);
            }

            // Superadmin copy
            const superadminEmails = [];
            const superadminUsers = await User.find({ role: 'superadmin' }).select('email').lean();
            for (const u of superadminUsers) {
                if (u && u.email) superadminEmails.push(u.email);
            }
            if (process.env.SUPERADMIN_EMAIL) superadminEmails.push(process.env.SUPERADMIN_EMAIL);
            const uniqueAdminEmails = [...new Set(superadminEmails.filter(Boolean))];
            if (uniqueAdminEmails.length) {
                const adminHtml = `
                    <div style="font-family: Arial, sans-serif; font-size: 14px;">
                        <h2>Booking Transaction Update</h2>
                        <p>Property: <strong>${propertyLabel}</strong></p>
                        <p>Tenant: <strong>${normalizedName || 'N/A'}</strong> (${email || 'N/A'})</p>
                        <p>Owner ID: <strong>${finalOwnerId}</strong></p>
                        <p>Transaction ID: <strong>${paymentRef}</strong></p>
                        <p>Amount: <strong>INR ${amountValue}</strong></p>
                        <p>Status: <strong>${booking.booking_status || booking.status || 'confirmed'}</strong></p>
                    </div>
                `;
                await mailer.sendMail(uniqueAdminEmails, `Booking Transaction - ${propertyLabel}`, '', adminHtml);
            }
        } catch (mailErr) {
            console.warn('Booking confirmation email dispatch failed:', mailErr.message);
        }

        res.status(201).json({
            success: true,
            message: 'Booking confirmed successfully',
            data: booking
        });

    } catch (error) {
        console.error('❌ Error confirming booking:', error);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to confirm booking: ' + error.message,
            error: error.message
        });
    }
};

// ==================== REFUND REQUEST OPERATIONS ====================

/**
 * CREATE REFUND REQUEST
 * Handles user requesting refund with payment details
 */
exports.createRefundRequest = async (req, res) => {
    try {
        const {
            booking_id,
            user_id,
            payment_id,
            user_name,
            user_phone,
            user_email,
            refund_amount,
            request_type, // 'refund' or 'alternative_property'
            refund_method, // 'upi', 'bank', 'other'
            upi_id,
            bank_account_holder,
            bank_account_number,
            bank_ifsc_code,
            bank_name,
            other_details,
            preferred_area,
            property_requirements
        } = req.body;

        // Validation
        if (!booking_id || !user_id || !payment_id || !user_name || !user_phone || !request_type) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: booking_id, user_id, payment_id, user_name, user_phone, request_type'
            });
        }

        // Validate request type
        if (!['refund', 'alternative_property'].includes(request_type)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request type. Must be "refund" or "alternative_property"'
            });
        }

        // For refund requests, validate payment method details
        if (request_type === 'refund') {
            if (!refund_method) {
                return res.status(400).json({
                    success: false,
                    message: 'Refund method is required for refund requests'
                });
            }

            if (refund_method === 'upi' && !upi_id) {
                return res.status(400).json({
                    success: false,
                    message: 'UPI ID is required for UPI refund method'
                });
            }

            if (refund_method === 'bank' && (!bank_account_holder || !bank_account_number || !bank_ifsc_code)) {
                return res.status(400).json({
                    success: false,
                    message: 'Bank account details are required for bank transfer refund method'
                });
            }
        }

        // Create refund request
        const refundRequest = new RefundRequest({
            booking_id,
            user_id,
            payment_id,
            user_name,
            user_phone,
            user_email,
            request_type,
            refund_method,
            upi_id,
            bank_account_holder,
            bank_account_number,
            bank_ifsc_code,
            bank_name,
            other_details,
            preferred_area,
            property_requirements,
            refund_status: 'pending',
            refund_amount: refund_amount || 500, // Use provided amount or default to 500
            created_at: new Date(),
            updated_at: new Date()
        });

        await refundRequest.save();

        try {
            await notifySuperadmin({
                type: 'refund_request',
                from: 'website',
                subject: request_type === 'refund' ? 'New Refund Request' : 'New Alternative Property Request',
                message: `${user_name || 'A user'} submitted a ${request_type} request.`,
                meta: {
                    refundRequestId: String(refundRequest._id || ''),
                    bookingId: booking_id || '',
                    userId: user_id || '',
                    userName: user_name || '',
                    userEmail: user_email || '',
                    amount: refund_amount || 500,
                    requestType: request_type || ''
                }
            });
        } catch (notifyErr) {
            console.warn('Failed to notify superadmin about refund request:', notifyErr.message);
        }

        res.status(201).json({
            success: true,
            message: `${request_type === 'refund' ? 'Refund' : 'Alternative property'} request submitted successfully`,
            data: refundRequest
        });

    } catch (error) {
        console.error('Error creating refund request:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET ALL REFUND REQUESTS
 * Fetch all refund requests for superadmin dashboard
 */
exports.getAllRefundRequests = async (req, res) => {
    try {
        const { status, request_type } = req.query;
        let filter = {};

        if (status) {
            filter.refund_status = status;
        }

        if (request_type) {
            filter.request_type = request_type;
        }

        const refundRequests = await RefundRequest.find(filter)
            .sort({ created_at: -1 });

        res.status(200).json({
            success: true,
            count: refundRequests.length,
            data: refundRequests
        });

    } catch (error) {
        console.error('Error fetching refund requests:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET REFUND REQUEST BY ID
 */
exports.getRefundRequestById = async (req, res) => {
    try {
        const { id } = req.params;

        const refundRequest = await RefundRequest.findById(id);

        if (!refundRequest) {
            return res.status(404).json({
                success: false,
                message: 'Refund request not found'
            });
        }

        res.status(200).json({
            success: true,
            data: refundRequest
        });

    } catch (error) {
        console.error('Error fetching refund request:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * PROCESS REFUND
 * Admin processes refund and sends money to user
 */
exports.processRefund = async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            admin_notes, 
            processed_by,
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature
        } = req.body;

        const refundRequest = await RefundRequest.findById(id);

        if (!refundRequest) {
            return res.status(404).json({
                success: false,
                message: 'Refund request not found'
            });
        }

        // Check if already processed
        if (refundRequest.refund_status === 'processed') {
            return res.status(400).json({
                success: false,
                message: 'Refund has already been processed'
            });
        }

        // Update refund status
        refundRequest.refund_status = 'processed';
        refundRequest.refund_date = new Date();
        
        // If Razorpay payment details provided, use them
        if (razorpay_payment_id) {
            refundRequest.refund_transaction_id = razorpay_payment_id;
            refundRequest.razorpay_order_id = razorpay_order_id;
            refundRequest.razorpay_payment_id = razorpay_payment_id;
        } else {
            refundRequest.refund_transaction_id = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        
        refundRequest.admin_notes = admin_notes || 'Refund processed';
        refundRequest.processed_by = processed_by;
        refundRequest.updated_at = new Date();

        await refundRequest.save();

        res.status(200).json({
            success: true,
            message: 'Refund processed successfully',
            data: refundRequest
        });

    } catch (error) {
        console.error('Error processing refund:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * UPDATE REFUND REQUEST STATUS
 */
exports.updateRefundRequestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { refund_status, admin_notes } = req.body;

        if (!['pending', 'approved', 'rejected', 'processed'].includes(refund_status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid refund status'
            });
        }

        const refundRequest = await RefundRequest.findByIdAndUpdate(
            id,
            {
                refund_status,
                admin_notes,
                updated_at: new Date()
            },
            { new: true }
        );

        if (!refundRequest) {
            return res.status(404).json({
                success: false,
                message: 'Refund request not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Refund request status updated successfully',
            data: refundRequest
        });

    } catch (error) {
        console.error('Error updating refund request:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * CREATE RAZORPAY ORDER FOR REFUND
 */
exports.createRefundOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, currency, user_name, user_email, user_phone } = req.body;

        // Get refund request details
        const refundRequest = await RefundRequest.findById(id);
        if (!refundRequest) {
            return res.status(404).json({
                success: false,
                message: 'Refund request not found'
            });
        }

        // Mock order creation (In production, use actual Razorpay API)
        const mockOrder = {
            id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            entity: 'order',
            amount: amount,
            amount_paid: 0,
            amount_due: amount,
            currency: currency || 'INR',
            receipt: `refund_${refundRequest._id}`,
            status: 'created',
            attempts: 0,
            notes: {
                refund_request_id: refundRequest._id,
                booking_id: refundRequest.booking_id
            },
            created_at: Math.floor(Date.now() / 1000)
        };

        res.status(200).json({
            success: true,
            order_id: mockOrder.id,
            amount: amount,
            currency: currency,
            refund_request_id: id
        });

    } catch (error) {
        console.error('Error creating refund order:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * PROCESS REFUND WITH RAZORPAY PAYMENT (Updated)
 */
exports.processRefundPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            razorpay_payment_id, 
            razorpay_order_id, 
            razorpay_signature, 
            admin_notes 
        } = req.body;

        const refundRequest = await RefundRequest.findById(id);

        if (!refundRequest) {
            return res.status(404).json({
                success: false,
                message: 'Refund request not found'
            });
        }

        // Check if already processed
        if (refundRequest.refund_status === 'processed') {
            return res.status(400).json({
                success: false,
                message: 'Refund has already been processed'
            });
        }

        // Update refund status with Razorpay payment details
        refundRequest.refund_status = 'processed';
        refundRequest.refund_date = new Date();
        refundRequest.refund_transaction_id = razorpay_payment_id || `TXN_${Date.now()}`;
        refundRequest.razorpay_order_id = razorpay_order_id;
        refundRequest.razorpay_payment_id = razorpay_payment_id;
        refundRequest.admin_notes = admin_notes || 'Refund processed via Razorpay';
        refundRequest.updated_at = new Date();

        await refundRequest.save();

        res.status(200).json({
            success: true,
            message: 'Refund processed successfully',
            data: refundRequest,
            transaction_id: razorpay_payment_id
        });

    } catch (error) {
        console.error('Error processing refund payment:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};


