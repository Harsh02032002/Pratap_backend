const SupportTicket = require('../models/SupportTicket');
const User = require('../models/user');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const mailer = require('../utils/mailer');
const fcmService = require('../services/fcmService');
const { sendTemplateToResolvedUser, resolvePhoneByEmailOrUserId } = require('../utils/whatsappBot');

/**
 * Generate a unique Ref ID like TKT-849201
 */
function generateRefId() {
    const num = Math.floor(100000 + Math.random() * 900000);
    return `TKT-${num}`;
}

/**
 * Create a new Support Ticket (Owner or Tenant)
 * POST /api/tickets/create
 */
exports.createTicket = async (req, res) => {
    try {
        const {
            subject,
            description,
            ticket_type,
            priority = 'Medium',
            raised_by,
            raised_by_name,
            raised_by_role = 'tenant',
            user_email,
            user_phone,
            property_id,
            property_name,
            booking_id,
            owner_id,
            owner_name,
            city,
            area,
            attachments = []
        } = req.body;

        if (!subject || !description || !ticket_type || !raised_by) {
            return res.status(400).json({
                success: false,
                message: 'subject, description, ticket_type, and raised_by are required.'
            });
        }

        // Generate unique Ref ID
        let ticket_id = generateRefId();
        let exists = await SupportTicket.findOne({ ticket_id });
        while (exists) {
            ticket_id = generateRefId();
            exists = await SupportTicket.findOne({ ticket_id });
        }

        // Create Ticket
        const ticket = new SupportTicket({
            ticket_id,
            subject,
            description,
            ticket_type,
            priority,
            raised_by: String(raised_by).trim(),
            raised_by_name: raised_by_name || raised_by,
            raised_by_role,
            user_email: user_email || null,
            user_phone: user_phone || null,
            property_id: property_id || null,
            property_name: property_name || null,
            booking_id: booking_id || null,
            owner_id: owner_id || null,
            owner_name: owner_name || null,
            city: city || null,
            area: area || null,
            attachments,
            status: 'Open',
            activity_log: [{
                action: 'Ticket Created',
                performed_by: raised_by,
                performed_by_name: raised_by_name || raised_by,
                from_status: null,
                to_status: 'Open',
                note: `Ticket ${ticket_id} created under ${ticket_type}`,
                at: new Date()
            }]
        });

        await ticket.save();
        console.log(`🎫 Ticket Created: ${ticket.ticket_id} (${ticket.ticket_type}) by ${ticket.raised_by}`);

        // 1. Email Notification to Ticket Raiser
        if (user_email) {
            try {
                const emailSubject = `🎫 Ticket Created: [${ticket.ticket_id}] ${subject}`;
                const htmlContent = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                        <div style="background: #0FA596; color: #ffffff; padding: 20px; text-align: center;">
                            <h2 style="margin: 0; font-size: 22px;">Support Ticket Created</h2>
                            <p style="margin: 5px 0 0; opacity: 0.9;">Ref ID: <strong>${ticket.ticket_id}</strong></p>
                        </div>
                        <div style="padding: 24px; color: #1e293b; line-height: 1.6;">
                            <p style="font-size: 16px;">Hi <strong>${ticket.raised_by_name}</strong>,</p>
                            <p>Your support ticket has been registered successfully. Our support team &amp; area representative will review it shortly.</p>
                            
                            <div style="background: #f8fafc; padding: 18px; border-radius: 10px; border-left: 4px solid #0FA596; margin: 20px 0;">
                                <p style="margin: 4px 0;"><strong>Reference ID:</strong> <span style="color: #0FA596; font-weight: bold;">${ticket.ticket_id}</span></p>
                                <p style="margin: 4px 0;"><strong>Category:</strong> ${ticket.ticket_type}</p>
                                <p style="margin: 4px 0;"><strong>Subject:</strong> ${subject}</p>
                                <p style="margin: 4px 0;"><strong>Status:</strong> <span style="background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">Open</span></p>
                                <p style="margin: 4px 0;"><strong>Description:</strong> ${description}</p>
                            </div>

                            <p style="font-size: 13px; color: #64748b;">You can use Ref ID <strong>${ticket.ticket_id}</strong> to track the status of your request on Roomhy.</p>
                        </div>
                    </div>
                `;
                await mailer.sendMail(user_email, emailSubject, `Support Ticket ${ticket.ticket_id} created`, htmlContent);
            } catch (mailErr) {
                console.warn('Ticket email alert warning:', mailErr.message);
            }
        }

        // 2. WhatsApp Notification
        if (user_phone || user_email) {
            try {
                await sendTemplateToResolvedUser({
                    phone: user_phone,
                    email: user_email,
                    userId: raised_by,
                    templateName: 'roomhy_ticket_created',
                    options: {
                        namedParams: {
                            user_name: ticket.raised_by_name || 'User',
                            ticket_id: ticket.ticket_id,
                            category: ticket.ticket_type,
                            subject: subject
                        }
                    }
                }).catch(() => {});
            } catch (waErr) {
                console.warn('Ticket WA alert warning:', waErr.message);
            }
        }

        // 3. FCM Push Notification to Raiser Device (Laptop & Mobile)
        try {
            await fcmService.sendToUser(raised_by, {
                title: `🎫 Ticket Registered: ${ticket.ticket_id}`,
                body: `Your ticket for "${subject}" has been created. Ref ID: ${ticket.ticket_id}`,
                icon: '/pwa-192x192.png',
                clickAction: raised_by_role === 'property_owner' ? '/propertyowner/support' : '/tenant/support',
                data: {
                    ticketId: ticket.ticket_id,
                    type: 'ticket_created'
                }
            });
        } catch (fcmErr) {
            console.warn('Ticket FCM push warning:', fcmErr.message);
        }

        // 4. Real-time Socket.io Alert to Admin & Staff
        if (global.io) {
            global.io.to('SUPER_ADMIN').emit('new_support_ticket', {
                ticket_id: ticket.ticket_id,
                subject: ticket.subject,
                raised_by: ticket.raised_by_name,
                raised_by_role: ticket.raised_by_role,
                ticket_type: ticket.ticket_type
            });
        }

        return res.status(201).json({
            success: true,
            message: 'Support ticket created successfully',
            ticket
        });
    } catch (error) {
        console.error('Error creating ticket:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Get tickets raised by logged-in Owner or Tenant
 * GET /api/tickets/my-tickets?loginId=ROOMHY3227
 */
exports.getMyTickets = async (req, res) => {
    try {
        const loginId = req.query.loginId || req.query.userId || (req.user && (req.user.loginId || req.user._id));
        if (!loginId) {
            return res.status(400).json({ success: false, message: 'loginId is required' });
        }

        const tickets = await SupportTicket.find({
            $or: [
                { raised_by: String(loginId).trim() },
                { raised_by: String(loginId).trim().toUpperCase() },
                { owner_id: String(loginId).trim() },
                { user_email: String(loginId).trim().toLowerCase() }
            ]
        }).sort({ created_at: -1 }).lean();

        return res.json({ success: true, count: tickets.length, tickets });
    } catch (error) {
        console.error('Error fetching my tickets:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Search Ticket by Ref ID (e.g. TKT-849201)
 * GET /api/tickets/search?ref=TKT-849201
 */
exports.getTicketByRefId = async (req, res) => {
    try {
        const ref = (req.query.ref || req.query.ticket_id || req.params.ticketId || '').trim();
        if (!ref) {
            return res.status(400).json({ success: false, message: 'Ticket Ref ID is required' });
        }

        const isObjectId = /^[0-9a-fA-F]{24}$/.test(ref);
        const regex = new RegExp(`^${ref}$`, 'i');

        const ticket = await SupportTicket.findOne({
            $or: [
                { ticket_id: regex },
                { ticket_id: ref.toUpperCase() },
                ...(isObjectId ? [{ _id: ref }] : [])
            ]
        }).lean();

        if (!ticket) {
            return res.status(404).json({ success: false, message: `Ticket with Ref ID "${ref}" not found.` });
        }

        return res.json({ success: true, ticket });
    } catch (error) {
        console.error('Error searching ticket:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Get all tickets for SuperAdmin / Staff
 * GET /api/tickets/all
 */
exports.getAllTickets = async (req, res) => {
    try {
        const { status, ticket_type, priority, search, area, city } = req.query;
        const query = {};

        if (status && status !== 'all') query.status = status;
        if (ticket_type && ticket_type !== 'all') query.ticket_type = ticket_type;
        if (priority && priority !== 'all') query.priority = priority;
        if (city) query.city = new RegExp(city, 'i');
        if (area) query.area = new RegExp(area, 'i');

        if (search) {
            const cleanSearch = String(search).trim();
            const regex = new RegExp(cleanSearch, 'i');
            query.$or = [
                { ticket_id: regex },
                { subject: regex },
                { raised_by: regex },
                { raised_by_name: regex },
                { property_name: regex },
                { user_email: regex },
                { user_phone: regex }
            ];
        }

        const tickets = await SupportTicket.find(query).sort({ created_at: -1 }).lean();
        return res.json({ success: true, count: tickets.length, tickets });
    } catch (error) {
        console.error('Error fetching all tickets:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Resolve or Complete Ticket by Employee / SuperAdmin
 * POST /api/tickets/resolve
 */
exports.resolveTicket = async (req, res) => {
    try {
        const { ticket_id, resolution_notes, performed_by = 'SuperAdmin', performed_by_name = 'Support Team', status = 'Resolved' } = req.body;

        if (!ticket_id) {
            return res.status(400).json({ success: false, message: 'ticket_id is required' });
        }

        const isObjectId = /^[0-9a-fA-F]{24}$/.test(ticket_id);
        const ticket = await SupportTicket.findOne({
            $or: [
                { ticket_id: ticket_id },
                { ticket_id: String(ticket_id).toUpperCase() },
                ...(isObjectId ? [{ _id: ticket_id }] : [])
            ]
        });

        if (!ticket) {
            return res.status(404).json({ success: false, message: `Ticket ${ticket_id} not found.` });
        }

        const fromStatus = ticket.status;
        ticket.status = status;
        ticket.resolution_notes = resolution_notes || ticket.resolution_notes || 'Resolved by support team.';
        ticket.resolved_at = new Date();
        ticket.updated_at = new Date();

        ticket.activity_log.push({
            action: `Ticket ${status}`,
            performed_by: String(performed_by),
            performed_by_name: String(performed_by_name),
            from_status: fromStatus,
            to_status: status,
            note: resolution_notes || `Ticket marked as ${status}`,
            at: new Date()
        });

        await ticket.save();
        console.log(`✅ Ticket ${ticket.ticket_id} marked as ${status} by ${performed_by_name}`);

        // Multi-Channel Notifications to Ticket Raiser
        const recipientLoginId = ticket.raised_by;
        const recipientEmail = ticket.user_email;
        const recipientPhone = ticket.user_phone;

        // 1. Email Alert
        if (recipientEmail) {
            try {
                const subject = `🟢 Support Ticket Resolved: [${ticket.ticket_id}] ${ticket.subject}`;
                const html = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                        <div style="background: #10b981; color: #ffffff; padding: 20px; text-align: center;">
                            <h2 style="margin: 0; font-size: 22px;">Ticket ${status} 🟢</h2>
                            <p style="margin: 5px 0 0; opacity: 0.9;">Ref ID: <strong>${ticket.ticket_id}</strong></p>
                        </div>
                        <div style="padding: 24px; color: #1e293b; line-height: 1.6;">
                            <p style="font-size: 16px;">Hi <strong>${ticket.raised_by_name}</strong>,</p>
                            <p>Great news! Your support ticket <strong>${ticket.ticket_id}</strong> has been marked as <strong>${status}</strong>.</p>
                            
                            <div style="background: #f0fdf4; padding: 18px; border-radius: 10px; border-left: 4px solid #10b981; margin: 20px 0;">
                                <p style="margin: 4px 0;"><strong>Ref ID:</strong> ${ticket.ticket_id}</p>
                                <p style="margin: 4px 0;"><strong>Subject:</strong> ${ticket.subject}</p>
                                <p style="margin: 4px 0;"><strong>Resolution Note:</strong> ${resolution_notes || 'Issue has been successfully addressed.'}</p>
                            </div>

                            <p style="font-size: 13px; color: #64748b;">Thank you for using Roomhy Support.</p>
                        </div>
                    </div>
                `;
                await mailer.sendMail(recipientEmail, subject, `Ticket ${ticket.ticket_id} resolved`, html);
            } catch (emailErr) {
                console.warn('Resolution email alert warning:', emailErr.message);
            }
        }

        // 2. WhatsApp Alert
        if (recipientPhone || recipientEmail) {
            try {
                await sendTemplateToResolvedUser({
                    phone: recipientPhone,
                    email: recipientEmail,
                    userId: recipientLoginId,
                    templateName: 'roomhy_ticket_resolved',
                    options: {
                        namedParams: {
                            user_name: ticket.raised_by_name || 'User',
                            ticket_id: ticket.ticket_id,
                            status: status
                        }
                    }
                }).catch(() => {});
            } catch (waErr) {
                console.warn('Resolution WA alert warning:', waErr.message);
            }
        }

        // 3. Push Notification Alert to Device (Laptop & Mobile)
        try {
            await fcmService.sendToUser(recipientLoginId, {
                title: `🟢 Ticket ${status}: ${ticket.ticket_id}`,
                body: `Your ticket "${ticket.subject}" has been marked as ${status}. Click to view details.`,
                icon: '/pwa-192x192.png',
                clickAction: ticket.raised_by_role === 'property_owner' ? '/propertyowner/support' : '/tenant/support',
                data: {
                    ticketId: ticket.ticket_id,
                    type: 'ticket_resolved'
                }
            });
        } catch (fcmErr) {
            console.warn('Resolution FCM push warning:', fcmErr.message);
        }

        return res.json({
            success: true,
            message: `Ticket ${ticket.ticket_id} marked as ${status}`,
            ticket
        });
    } catch (error) {
        console.error('Error resolving ticket:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};
