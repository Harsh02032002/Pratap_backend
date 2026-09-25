const SupportTicket = require('../models/SupportTicket');
const User = require('../models/user');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const Notification = require('../models/Notification');
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

        let resolvedPropertyName = property_name || null;
        if (!resolvedPropertyName) {
            try {
                if (property_id) {
                    const ApprovedProperty = require('../models/ApprovedProperty');
                    const prop = await ApprovedProperty.findById(property_id).select('title propertyInfo').lean().catch(() => null);
                    if (prop) resolvedPropertyName = prop.title || prop.propertyInfo?.propertyName || null;
                }
                if (!resolvedPropertyName && owner_id) {
                    const ApprovedProperty = require('../models/ApprovedProperty');
                    const VisitData = require('../models/VisitData');
                    const prop = await ApprovedProperty.findOne({ ownerLoginId: String(owner_id).toUpperCase() }).select('title').lean().catch(() => null);
                    if (prop?.title) {
                        resolvedPropertyName = prop.title;
                    } else {
                        const visit = await VisitData.findOne({ ownerLoginId: String(owner_id).toUpperCase() }).select('propertyName title').lean().catch(() => null);
                        if (visit) resolvedPropertyName = visit.propertyName || visit.title;
                    }
                }
                if (!resolvedPropertyName && raised_by) {
                    const Tenant = require('../models/Tenant');
                    const Rent = require('../models/Rent');
                    const tenantDoc = await Tenant.findOne({ loginId: String(raised_by).toUpperCase() }).select('propertyTitle').lean().catch(() => null);
                    if (tenantDoc?.propertyTitle) {
                        resolvedPropertyName = tenantDoc.propertyTitle;
                    } else {
                        const rentDoc = await Rent.findOne({ tenantLoginId: String(raised_by).toUpperCase() }).select('propertyName').lean().catch(() => null);
                        if (rentDoc?.propertyName) resolvedPropertyName = rentDoc.propertyName;
                    }
                }
            } catch (_) {}
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
            property_name: resolvedPropertyName,
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

        // 🔔 Notify Superadmin about new ticket
        try {
            const { notifySuperadmin } = require('../utils/superadminNotifier');
            await notifySuperadmin({
                type: 'ticket',
                from: ticket.raised_by_role || 'user',
                subject: `🎫 New Ticket Raised: ${ticket.ticket_id} (${ticket.ticket_type})`,
                message: `Ticket "${ticket.subject}" raised by ${ticket.raised_by_name || ticket.raised_by} (${ticket.raised_by_role}). Priority: ${ticket.priority}`,
                meta: {
                    TicketID: ticket.ticket_id,
                    Type: ticket.ticket_type,
                    RaisedBy: ticket.raised_by_name || ticket.raised_by,
                    Role: ticket.raised_by_role,
                    Property: ticket.property_name || 'N/A'
                }
            });
        } catch (notifErr) {
            console.warn('Superadmin ticket notification warning:', notifErr.message);
        }

        // ─── SMART TICKET ROUTING ────────────────────────────────────────────────
        // Rules:
        //  A. Tenant ticket, ticket_type = 'Owner Complaint'
        //       → Route to Owner panel: notify owner directly
        //  B. Tenant ticket, other types (company/admin complaint)
        //       → Assign to the specific Employee who created the visit/property
        //  C. Owner ticket
        //       → Assign to the specific Employee who created the visit/property
        //  D. No employee found → city/area fallback → any active employee
        try {
            const { resolvePropertyEmployee } = require('../utils/propertyEmployeeResolver');

            const isOwnerComplaint = raised_by_role === 'tenant' && String(ticket_type || '').toLowerCase().includes('owner complaint');

            if (isOwnerComplaint) {
                // ── A: Tenant → Owner complaint → notify owner ──────────────────
                ticket.routed_to_panel = 'owner';
                ticket.assigned_to_panel = 'owner';
                ticket.activity_log.push({
                    action: 'Routed to Owner Panel',
                    performed_by: 'system',
                    performed_by_name: 'System Router',
                    from_status: 'Open',
                    to_status: 'Open',
                    note: `Ticket routed to Owner panel (owner_id: ${owner_id || 'N/A'}) as per tenant selection`,
                    at: new Date()
                });
                await ticket.save();
                console.log(`🏠 Ticket ${ticket.ticket_id} routed to Owner panel for owner: ${owner_id || 'N/A'}`);

                if (owner_id) {
                    await Notification.create({
                        toRole: 'property_owner',
                        toLoginId: String(owner_id).toUpperCase(),
                        from: String(raised_by),
                        type: 'support_ticket_created',
                        title: `🎫 Tenant Complaint: ${ticket.ticket_id}`,
                        message: `Your tenant ${ticket.raised_by_name} has raised a complaint: "${subject}"`,
                        meta: { ticket_id: ticket.ticket_id, ticket_type: ticket.ticket_type, subject },
                        read: false
                    }).catch(e => console.warn('Owner ticket notification warning:', e.message));

                    fcmService.sendToUser(String(owner_id).toUpperCase(), {
                        title: `🎫 Tenant Complaint: ${ticket.ticket_id}`,
                        body: `${ticket.raised_by_name} raised: "${subject}"`,
                        icon: '/pwa-192x192.png',
                        clickAction: '/hostelowner/support',
                        data: { ticketId: ticket.ticket_id, type: 'tenant_owner_complaint' }
                    }).catch(() => {});
                }
            } else {
                // ── B / C: Route to the Employee who created this property ──────
                const propEmployee = await resolvePropertyEmployee({
                    propertyId: property_id || null,
                    ownerLoginId: owner_id || null,
                    city,
                    area
                });

                if (propEmployee) {
                    ticket.assigned_admin = propEmployee.loginId;
                    ticket.assigned_admin_name = propEmployee.name;
                    ticket.status = 'Assigned';
                    ticket.assigned_at = new Date();

                    ticket.activity_log.push({
                        action: 'Auto-Assigned to Property Employee',
                        performed_by: 'system',
                        performed_by_name: 'System Auto-Assign Engine',
                        from_status: 'Open',
                        to_status: 'Assigned',
                        note: `Auto-assigned to Employee ${propEmployee.name} (${propEmployee.loginId}) — property visit creator`,
                        at: new Date()
                    });

                    await ticket.save();
                    console.log(`🤖 Ticket ${ticket.ticket_id} auto-assigned to property employee ${propEmployee.name} (${propEmployee.loginId})`);

                    fcmService.sendToUser(propEmployee.loginId, {
                        title: `🚨 Ticket Assigned: ${ticket.ticket_id}`,
                        body: `"${subject}" from ${ticket.raised_by_name} (${ticket.raised_by_role}) assigned to you.`,
                        icon: '/pwa-192x192.png',
                        clickAction: '/employee/tickets',
                        data: { ticketId: ticket.ticket_id, type: 'ticket_assigned' }
                    }).catch(() => {});

                    await Notification.create({
                        toRole: 'employee',
                        toLoginId: propEmployee.loginId,
                        from: String(raised_by),
                        type: 'support_ticket_assigned',
                        title: `🎫 Ticket Assigned to You: ${ticket.ticket_id}`,
                        message: `Ticket "${subject}" from ${ticket.raised_by_name} (${ticket.raised_by_role}) has been assigned to you.`,
                        meta: { ticket_id: ticket.ticket_id, ticket_type: ticket.ticket_type, subject, raised_by: ticket.raised_by_name, raised_by_role },
                        read: false
                    }).catch(e => console.warn('Employee ticket assignment notification warning:', e.message));
                }
            }
        } catch (routeErr) {
            console.warn('Smart ticket routing warning:', routeErr.message);
        }



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

        // 3. FCM Push Notification to Raiser Device & SuperAdmin / Employee Devices (Phone, Laptop, Tablet)
        try {
            // Push to Ticket Raiser
            await fcmService.sendToUser(raised_by, {
                title: `🎫 Ticket Registered: ${ticket.ticket_id}`,
                body: `Your ticket for "${subject}" has been created. Ref ID: ${ticket.ticket_id}`,
                icon: '/pwa-192x192.png',
                clickAction: raised_by_role === 'property_owner' ? '/propertyowner/support' : '/tenant/support',
                data: { ticketId: ticket.ticket_id, type: 'ticket_created' }
            });

            // Push to SuperAdmin Devices (Phone, Laptop, Tablet)
            await fcmService.sendToRole('superadmin', {
                title: `🚨 New Support Ticket: ${ticket.ticket_id}`,
                body: `${ticket.raised_by_name} (${ticket.raised_by_role}) raised: "${subject}"`,
                icon: '/pwa-192x192.png',
                clickAction: '/superadmin/tickets',
                data: { ticketId: ticket.ticket_id, type: 'new_support_ticket' }
            });

            // Push to Employee Devices
            await fcmService.sendToRole('employee', {
                title: `🚨 New Ticket Alert: ${ticket.ticket_id}`,
                body: `${ticket.raised_by_name} raised: "${subject}"`,
                icon: '/pwa-192x192.png',
                clickAction: '/employee/tickets',
                data: { ticketId: ticket.ticket_id, type: 'new_support_ticket' }
            });
        } catch (fcmErr) {
            console.warn('Ticket FCM push warning:', fcmErr.message);
        }

        // 4. In-App Notifications for Admin, Employee, and Raiser
        try {
            const notifMsg = `New Ticket [${ticket.ticket_id}] raised by ${ticket.raised_by_name} (${ticket.raised_by_role}): ${subject}`;
            
            // SuperAdmin Ledger Notification
            await Notification.create({
                toRole: 'superadmin',
                toLoginId: 'superadmin',
                from: String(raised_by),
                type: 'support_ticket_created',
                title: `🎫 New Support Ticket: ${ticket.ticket_id}`,
                message: notifMsg,
                meta: { ticket_id: ticket.ticket_id, ticket_type: ticket.ticket_type, subject, raised_by: ticket.raised_by_name, raised_by_role },
                read: false
            });

            // Employee Ledger Notification
            await Notification.create({
                toRole: 'employee',
                toLoginId: 'employee',
                from: String(raised_by),
                type: 'support_ticket_created',
                title: `🎫 Ticket Alert: ${ticket.ticket_id}`,
                message: notifMsg,
                meta: { ticket_id: ticket.ticket_id, ticket_type: ticket.ticket_type, subject },
                read: false
            });

            // Raiser Notification
            await Notification.create({
                toRole: raised_by_role,
                toLoginId: String(raised_by),
                from: 'system',
                type: 'support_ticket_created',
                title: `🎫 Ticket Registered: ${ticket.ticket_id}`,
                message: `Your ticket for "${subject}" has been created. Ref ID: ${ticket.ticket_id}`,
                meta: { ticket_id: ticket.ticket_id, ticket_type: ticket.ticket_type },
                read: false
            });
        } catch (notifErr) {
            console.warn('In-app notification creation error:', notifErr.message);
        }

        // 5. Real-time Socket.io Alert to Admin & Staff
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

        // 🔒 Employee Data Isolation Filter
        const isSuperAdmin = req.user && ['superadmin', 'admin'].includes(String(req.user.role).toLowerCase());
        const isEmp = req.employeeScope?.isEmployee || (req.user && ['employee', 'manager', 'areamanager', 'staff'].includes(String(req.user.role).toLowerCase()));

        if (isEmp && !isSuperAdmin) {
            const empLoginId = req.employeeScope?.loginId || req.user?.loginId || '';
            const empIdStr = String(req.user?._id || '');
            const empCity = req.employeeScope?.city || req.user?.city || '';

            const scopeConditions = [
                { assigned_admin: empLoginId },
                { assigned_admin: empLoginId.toUpperCase() },
                { assigned_admin: empIdStr }
            ];
            if (empCity) {
                scopeConditions.push({ city: new RegExp(empCity, 'i') });
            }

            if (query.$or) {
                query.$and = [
                    { $or: query.$or },
                    { $or: scopeConditions }
                ];
                delete query.$or;
            } else {
                query.$or = scopeConditions;
            }
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

        // 4. In-App Notifications for Raiser, SuperAdmin and Employee Ledgers
        try {
            const resNotifMessage = `Support Ticket [${ticket.ticket_id}] was marked as ${status} by ${performed_by_name}.`;

            // Raiser Notification
            await Notification.create({
                toRole: ticket.raised_by_role || 'tenant',
                toLoginId: String(recipientLoginId),
                from: 'system',
                type: 'support_ticket_resolved',
                title: `🟢 Ticket ${status}: ${ticket.ticket_id}`,
                message: `Your ticket "${ticket.subject}" has been marked as ${status}. Note: ${resolution_notes || 'Resolved'}`,
                meta: { ticket_id: ticket.ticket_id, status, resolution_notes },
                read: false
            });

            // SuperAdmin Ledger Notification
            await Notification.create({
                toRole: 'superadmin',
                toLoginId: 'superadmin',
                from: String(performed_by),
                type: 'support_ticket_resolved',
                title: `🟢 Ticket ${status}: ${ticket.ticket_id}`,
                message: resNotifMessage,
                meta: { ticket_id: ticket.ticket_id, status },
                read: false
            });

            // Employee Ledger Notification
            await Notification.create({
                toRole: 'employee',
                toLoginId: 'employee',
                from: String(performed_by),
                type: 'support_ticket_resolved',
                title: `🟢 Ticket ${status}: ${ticket.ticket_id}`,
                message: resNotifMessage,
                meta: { ticket_id: ticket.ticket_id, status },
                read: false
            });
        } catch (resNotifErr) {
            console.warn('Resolution in-app notification error:', resNotifErr.message);
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

/**
 * Bulk Resolve Tickets
 * POST /api/tickets/bulk-resolve
 */
exports.bulkResolveTickets = async (req, res) => {
    try {
        const { ticketIds, status = 'Resolved', resolution_notes } = req.body;
        if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
            return res.status(400).json({ success: false, message: 'ticketIds array is required.' });
        }
        await SupportTicket.updateMany(
            { _id: { $in: ticketIds } },
            {
                $set: {
                    status,
                    resolved_at: new Date(),
                    updated_at: new Date()
                },
                $push: {
                    activity_log: {
                        action: `Bulk Ticket ${status}`,
                        performed_by: 'admin',
                        performed_by_name: 'Admin User',
                        note: resolution_notes || `Bulk marked as ${status}`,
                        at: new Date()
                    }
                }
            }
        );
        return res.json({ success: true, message: `${ticketIds.length} tickets marked as ${status}.` });
    } catch (err) {
        console.error('Error in bulkResolveTickets:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * Bulk Delete Tickets
 * POST /api/tickets/bulk-delete
 */
exports.bulkDeleteTickets = async (req, res) => {
    try {
        const { ticketIds } = req.body;
        if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
            return res.status(400).json({ success: false, message: 'ticketIds array is required.' });
        }
        await SupportTicket.deleteMany({ _id: { $in: ticketIds } });
        return res.json({ success: true, message: `${ticketIds.length} tickets deleted successfully.` });
    } catch (err) {
        console.error('Error in bulkDeleteTickets:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * Auto-assign unassigned tickets to employees by city match
 * POST /api/tickets/auto-assign
 */
exports.autoAssignTickets = async (req, res) => {
    try {
        const unassigned = await SupportTicket.find({ status: 'Open', assigned_to: { $in: [null, '', undefined] } });
        if (unassigned.length === 0) {
            return res.json({ success: true, message: 'No unassigned tickets found', assigned: 0 });
        }

        const Employee = require('../models/Employee');
        const employees = await Employee.find({ isActive: true }).select('_id name loginId cities city area');
        if (employees.length === 0) {
            return res.json({ success: true, message: 'No active employees found', assigned: 0 });
        }

        let assigned = 0;
        for (const ticket of unassigned) {
            const ticketCity = (ticket.city || '').toLowerCase().trim();
            const ticketArea = (ticket.area || '').toLowerCase().trim();

            // Try city match first
            let matched = employees.find(e => {
                const empCities = (e.cities || [e.city]).filter(Boolean).map(c => c.toLowerCase().trim());
                return empCities.some(c => ticketCity && c.includes(ticketCity));
            });

            // Fall back: area match
            if (!matched && ticketArea) {
                matched = employees.find(e => {
                    const empArea = (e.area || '').toLowerCase().trim();
                    return empArea && empArea.includes(ticketArea);
                });
            }

            // Fall back: round-robin
            if (!matched) {
                matched = employees[assigned % employees.length];
            }

            if (matched) {
                await SupportTicket.findByIdAndUpdate(ticket._id, {
                    $set: {
                        assigned_to: matched.loginId,
                        assigned_to_name: matched.name,
                        updated_at: new Date()
                    },
                    $push: {
                        activity_log: {
                            action: 'Auto-Assigned',
                            performed_by: 'system',
                            performed_by_name: 'System',
                            note: `Auto-assigned to ${matched.name} (city match: ${ticketCity || 'round-robin'})`,
                            at: new Date()
                        }
                    }
                });
                assigned++;
            }
        }

        return res.json({ success: true, message: `${assigned} ticket(s) auto-assigned`, assigned });
    } catch (err) {
        console.error('Error in autoAssignTickets:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * Bulk delete closed/resolved tickets
 * POST /api/tickets/bulk-delete-closed
 */
exports.bulkDeleteClosedTickets = async (req, res) => {
    try {
        const { ticketIds } = req.body;
        if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
            return res.status(400).json({ success: false, message: 'ticketIds array is required.' });
        }
        // Only delete closed/resolved
        const result = await SupportTicket.deleteMany({ _id: { $in: ticketIds }, status: { $in: ['Resolved', 'Closed'] } });
        return res.json({ success: true, deleted: result.deletedCount, message: `${result.deletedCount} closed ticket(s) deleted.` });
    } catch (err) {
        console.error('Error in bulkDeleteClosedTickets:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
