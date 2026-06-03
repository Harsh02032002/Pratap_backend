const Notification = require('../models/Notification');
const User = require('../models/user');
const Owner = require('../models/Owner');
const Employee = require('../models/Employee');
const AreaManager = require('../models/AreaManager');
const Tenant = require('../models/Tenant');
const mailer = require('../utils/mailer');

async function resolveEmailByLoginId(loginId) {
  const id = (loginId || '').toString().trim().toUpperCase();
  if (!id) return '';

  const [user, owner, emp, mgr, tenant] = await Promise.all([
    User.findOne({ loginId: id }).select('email').lean(),
    Owner.findOne({ loginId: id }).select('email profile.email').lean(),
    Employee.findOne({ loginId: id }).select('email').lean(),
    AreaManager.findOne({ loginId: id }).select('email').lean(),
    Tenant.findOne({ loginId: id }).select('email').lean()
  ]);

  return (
    (user && user.email) ||
    (owner && owner.email) ||
    (owner && owner.profile && owner.profile.email) ||
    (emp && emp.email) ||
    (mgr && mgr.email) ||
    (tenant && tenant.email) ||
    ''
  );
}

async function resolveEmailsByRole(role) {
  const r = (role || '').toString().trim().toLowerCase();
  if (!r) return [];

  if (r === 'superadmin') {
    const users = await User.find({ role: 'superadmin' }).select('email').lean();
    const emails = users.map((u) => u.email).filter(Boolean);
    if (process.env.SUPERADMIN_EMAIL) emails.push(process.env.SUPERADMIN_EMAIL);
    return [...new Set(emails)];
  }
  return [];
}

exports.createNotification = async (req, res) => {
  try {
    const { toRole, toLoginId, from, type, meta } = req.body || {};
    if (!from || !type) return res.status(400).json({ message: 'from and type required' });

    const n = await Notification.create({ toRole: toRole || '', toLoginId: toLoginId || '', from, type, meta: meta || {}, read: false });

    // Mirror panel notification to email when recipient email can be resolved
    try {
      let recipients = [];
      if (toLoginId) {
        const email = await resolveEmailByLoginId(toLoginId);
        if (email) recipients.push(email);
      } else if (toRole) {
        recipients = await resolveEmailsByRole(toRole);
      }

      if (recipients.length) {
        const subject = `RoomHy Notification - ${type}`;
        const message = (meta && (meta.message || meta.title)) || 'You have a new panel notification in RoomHy.';
        const html = `
          <div style="font-family: Arial, sans-serif; font-size: 14px;">
            <h2>RoomHy Notification</h2>
            <p><strong>Type:</strong> ${type}</p>
            <p><strong>From:</strong> ${from}</p>
            <p>${message}</p>
          </div>
        `;
        await mailer.sendMail(recipients, subject, message, html);
      }
    } catch (emailErr) {
      console.warn('createNotification email mirror failed:', emailErr.message);
    }

    return res.status(201).json({ success: true, notification: n });
  } catch (err) {
    console.error('createNotification error', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    // Only allow Super Admin to fetch all notifications, optionally filter by unread
    const onlyUnread = req.query.unread === '1' || req.query.unread === 'true';
    const filter = {};
    if (onlyUnread) filter.read = false;
    // If user provided toLoginId query, filter for that
    if (req.query.toLoginId) filter.toLoginId = req.query.toLoginId;
    const notifs = await Notification.find(filter).sort({ createdAt: -1 }).limit(50);
    res.json(notifs);
  } catch (err) {
    console.error('getNotifications error', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.markRead = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ message: 'id required' });
    await Notification.findByIdAndUpdate(id, { read: true });
    res.json({ success: true });
  } catch (err) {
    console.error('markRead error', err);
    res.status(500).json({ success: false, message: err.message });
  }
};


exports.listNotifications = async (req, res) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ message: 'Auth required' });
        const notes = await Notification.find({ recipient: user._id }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, notifications: notes });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.sendChatMessageNotification = async (req, res) => {
    try {
        const { ownerId, tenantName, message, chatId } = req.body;
        const ownerLoginId = (ownerId || '').toString().trim().toUpperCase();

        if (!ownerLoginId) {
            return res.status(400).json({ success: false, message: 'Owner ID is required' });
        }

        // Create in-app owner notification for panel sound alerts.
        await Notification.create({
            toRole: 'owner',
            toLoginId: ownerLoginId,
            from: tenantName || 'Tenant',
            type: 'owner_new_chat',
            meta: {
                senderName: tenantName || 'Tenant',
                senderRole: 'tenant',
                message: message || '',
                chatId: chatId || ''
            },
            read: false
        });

        const ownerEmail = await resolveEmailByLoginId(ownerLoginId);
        if (ownerEmail) {
            const subject = `New Message from ${tenantName}`;
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">New Chat Message</h2>
                    <p>You have received a new message from a tenant.</p>
                    <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                        <p><strong>From:</strong> ${tenantName}</p>
                        <p><strong>Message:</strong> ${message}</p>
                    </div>
                    <p>Please check your chat in the owner panel to respond.</p>
                </div>
            `;
            await mailer.sendMail(ownerEmail, subject, '', html);
        }

        res.status(200).json({ success: true, message: 'Notification sent' });
    } catch (error) {
        console.error('Error sending chat message notification:', error);
        res.status(500).json({ success: false, message: 'Error sending notification' });
    }
};

// Website user notifications
exports.getWebsiteUserNotifications = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) return res.status(400).json({ success: false, message: 'User ID required' });

        const WebsiteNotification = require('../models/WebsiteNotification');
        const notifications = await WebsiteNotification.find({ userId }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, notifications });
    } catch (error) {
        console.error('Error getting website notifications:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createWebsiteNotification = async (req, res) => {
    try {
        const { userId, title, message, type } = req.body;
        if (!userId || !title) {
            return res.status(400).json({ success: false, message: 'userId and title required' });
        }

        const WebsiteNotification = require('../models/WebsiteNotification');
        const notification = await WebsiteNotification.create({
            userId,
            title,
            message: message || '',
            type: type || 'info',
            read: false,
            createdAt: new Date()
        });

        res.status(201).json({ success: true, notification });
    } catch (error) {
        console.error('Error creating website notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.markWebsiteNotificationRead = async (req, res) => {
    try {
        const { notificationId } = req.params;
        if (!notificationId) return res.status(400).json({ success: false, message: 'Notification ID required' });

        const WebsiteNotification = require('../models/WebsiteNotification');
        await WebsiteNotification.findByIdAndUpdate(notificationId, { read: true });
        res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteWebsiteNotification = async (req, res) => {
    try {
        const { notificationId } = req.params;
        if (!notificationId) return res.status(400).json({ success: false, message: 'Notification ID required' });

        const WebsiteNotification = require('../models/WebsiteNotification');
        await WebsiteNotification.findByIdAndDelete(notificationId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Booking accept notifications
exports.sendBookingAcceptNotification = async (req, res) => {
    try {
        const { userId, propertyName, ownerName } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID required' });
        }

        // Create in-app notification
        const WebsiteNotification = require('../models/WebsiteNotification');
        await WebsiteNotification.create({
            userId,
            title: 'Booking Accepted! 🎉',
            message: `Your booking request for ${propertyName} has been accepted by ${ownerName}`,
            type: 'booking_accept',
            read: false
        });

        // Send email notification
        const User = require('../models/user');
        const user = await User.findOne({ _id: userId });
        
        if (user && user.email) {
            const { sendBookingAcceptanceEmail } = require('../utils/emailNotifications');
            await sendBookingAcceptanceEmail(user.email, user.name, propertyName, ownerName);
        }

        res.json({ success: true, message: 'Booking acceptance notification sent' });
    } catch (error) {
        console.error('Error sending booking accept notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Send Email Notification to Owner (NEW)
 * Supports: Booking Requests, Chat Messages, Complaints
 */
exports.sendEmailNotification = async (req, res) => {
    try {
        const { ownerEmail, ownerLoginId, subject, message, data, type } = req.body;
        const normalizedOwnerLoginId = (ownerLoginId || '').toString().trim().toUpperCase();
        const resolvedOwnerEmail = (normalizedOwnerLoginId ? await resolveEmailByLoginId(normalizedOwnerLoginId) : '') || ownerEmail;

        if (!resolvedOwnerEmail) {
            return res.status(400).json({ error: 'Owner email/loginId is required' });
        }

        // Build email HTML based on type
        // Build email HTML based on type and send via shared SMTP mailer
        const emailHTML = buildNotificationEmail(type, message, data);
        const mailer = require('../utils/mailer');
        const sent = await mailer.sendMail(resolvedOwnerEmail, subject || 'RoomHy Notification', message || '', emailHTML);
        if (!sent) {
            return res.status(500).json({ error: 'Email transporter is not configured or delivery failed' });
        }
        console.log(`✅ Email notification sent to ${resolvedOwnerEmail} for ${type}`);
        
        res.status(200).json({ success: true, message: 'Email sent successfully' });

    } catch (error) {
        console.error('❌ Error sending email notification:', error);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Test Email Notification (NEW)
 */
exports.testEmailNotification = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const testHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Arial', sans-serif; background-color: #f5f5f5; }
                    .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
                    .header { border-bottom: 3px solid #7c3aed; padding-bottom: 15px; margin-bottom: 20px; }
                    .logo { color: #7c3aed; font-weight: bold; font-size: 18px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="logo">✅ RoomHy Email Notification Test</div>
                    </div>
                    <p>Hello,</p>
                    <p>This is a test email to confirm your notification system is working correctly!</p>
                    <p>You will receive notifications for:</p>
                    <ul>
                        <li>📅 New Booking Requests</li>
                        <li>💬 New Chat Messages</li>
                        <li>⚠️ New Complaints</li>
                    </ul>
                    <p>If you received this email, your notifications are properly configured.</p>
                </div>
            </body>
            </html>
        `;

        const mailer = require('../utils/mailer');
        const sent = await mailer.sendMail(
            email,
            'RoomHy Notification System - Test Email',
            'RoomHy notification test email',
            testHTML
        );
        if (!sent) {
            return res.status(500).json({ error: 'Email transporter is not configured or delivery failed' });
        }
        res.status(200).json({ success: true, message: 'Test email sent successfully' });

    } catch (error) {
        console.error('❌ Error sending test email:', error);
        res.status(500).json({ error: error.message });
    }
};

/**
 * Helper function: Build HTML email template
 */
function buildNotificationEmail(type, message, data) {
    const timestamp = new Date().toLocaleString();
    const typeIcon = {
        'Booking Request': '📅',
        'New Chat Message': '💬',
        'New Complaint': '⚠️'
    }[type] || '🔔';

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: 'Arial', sans-serif; background-color: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
                .header { border-bottom: 3px solid #7c3aed; padding-bottom: 15px; margin-bottom: 20px; }
                .header h1 { margin: 0; color: #1f2937; font-size: 24px; }
                .logo { color: #7c3aed; font-weight: bold; font-size: 18px; }
                .content { margin: 20px 0; }
                .alert-box { background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 15px 0; border-radius: 4px; }
                .alert-box.booking { background: #fef3c7; border-left-color: #f59e0b; }
                .alert-box.chat { background: #f3e8ff; border-left-color: #a855f7; }
                .alert-box.complaint { background: #fee2e2; border-left-color: #ef4444; }
                .alert-title { font-weight: bold; font-size: 16px; margin-bottom: 8px; }
                .details { background: #f9fafb; padding: 12px; border-radius: 4px; margin: 10px 0; font-size: 14px; }
                .button { display: inline-block; background: #7c3aed; color: white; padding: 10px 20px; border-radius: 4px; text-decoration: none; margin: 15px 0; }
                .footer { text-align: center; color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="logo">🏠 RoomHy Notifications</div>
                </div>

                <div class="content">
                    <div class="alert-box ${type === 'Booking Request' ? 'booking' : type === 'New Chat Message' ? 'chat' : 'complaint'}">
                        <div class="alert-title">${typeIcon} ${type}</div>
                        <p>${message}</p>
                    </div>

                    ${type === 'Booking Request' ? `
                        <div class="details">
                            <strong>Booking Details:</strong><br>
                            Property: ${data?.propertyName || 'N/A'}<br>
                            Guest: ${data?.guestName || 'N/A'}<br>
                            Check-in: ${data?.checkInDate ? new Date(data.checkInDate).toLocaleDateString() : 'N/A'}<br>
                            Status: <span style="color: #f59e0b; font-weight: bold;">${data?.status || 'Pending'}</span>
                        </div>
                    ` : type === 'New Chat Message' ? `
                        <div class="details">
                            <strong>Message from:</strong> ${data?.senderName || 'Someone'}<br>
                            <strong>Preview:</strong> ${(data?.message || '').substring(0, 100)}...<br>
                            <strong>Time:</strong> ${new Date(data?.timestamp || Date.now()).toLocaleString()}
                        </div>
                    ` : `
                        <div class="details">
                            <strong>Complaint from:</strong> ${data?.complaintBy || 'N/A'}<br>
                            <strong>Category:</strong> ${data?.category || 'General'}<br>
                            <strong>Priority:</strong> <span style="color: #ef4444; font-weight: bold;">${data?.priority || 'Medium'}</span><br>
                            <strong>Issue:</strong> ${(data?.description || '').substring(0, 100)}...
                        </div>
                    `}

                    <p style="text-align: center; margin: 20px 0;">
                        <a href="https://roomhy.com" class="button">View in RoomHy Portal</a>
                    </p>

                    <p>Please log in to your RoomHy owner dashboard to take action on this notification.</p>
                </div>

                <div class="footer">
                    <p>This is an automated notification from RoomHy.</p>
                    <p>Sent at: ${timestamp}</p>
                    <p>© 2026 RoomHy. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;
}

// ==================== SUPERADMIN NOTIFICATIONS ====================

/**
 * Send notification to Super Admin for new booking
 */
exports.sendSuperAdminNewBookingNotification = async (req, res) => {
    try {
        const { bookingId, propertyName, guestName, ownerName, amount, checkInDate } = req.body;
        
        // Create in-app notification
        const notification = await Notification.create({
            toRole: 'superadmin',
            toLoginId: 'superadmin',
            from: 'system',
            type: 'new_booking',
            meta: { bookingId, propertyName, guestName, ownerName, amount, checkInDate },
            read: false
        });
        
        console.log(`📢 New booking notification created: ${bookingId}`);

        try {
            const adminEmails = await resolveEmailsByRole('superadmin');
            if (adminEmails.length) {
                const subject = `New Booking Received - ${propertyName || 'RoomHy'}`;
                const html = `
                    <div style="font-family: Arial, sans-serif; font-size: 14px;">
                        <h2>New Booking Notification</h2>
                        <p><strong>Booking ID:</strong> ${bookingId || 'N/A'}</p>
                        <p><strong>Property:</strong> ${propertyName || 'N/A'}</p>
                        <p><strong>Guest:</strong> ${guestName || 'N/A'}</p>
                        <p><strong>Owner:</strong> ${ownerName || 'N/A'}</p>
                        <p><strong>Amount:</strong> INR ${amount || 0}</p>
                        <p><strong>Check-in:</strong> ${checkInDate || 'N/A'}</p>
                    </div>
                `;
                await mailer.sendMail(adminEmails, subject, '', html);
            }
        } catch (mailErr) {
            console.warn('sendSuperAdminNewBookingNotification email failed:', mailErr.message);
        }
        
        res.status(201).json({ 
            success: true, 
            message: 'New booking notification sent to superadmin',
            notification 
        });
    } catch (error) {
        console.error('Error sending new booking notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Send notification to Super Admin for new enquiry
 */
exports.sendSuperAdminNewEnquiryNotification = async (req, res) => {
    try {
        const { enquiryId, userName, userEmail, propertyName, message } = req.body;
        
        // Create in-app notification
        const notification = await Notification.create({
            toRole: 'superadmin',
            toLoginId: 'superadmin',
            from: 'system',
            type: 'new_enquiry',
            meta: { enquiryId, userName, userEmail, propertyName, message },
            read: false
        });
        
        console.log(`📢 New enquiry notification created: ${enquiryId}`);

        try {
            const adminEmails = await resolveEmailsByRole('superadmin');
            if (adminEmails.length) {
                const subject = `New Enquiry - ${propertyName || 'RoomHy'}`;
                const html = `
                    <div style="font-family: Arial, sans-serif; font-size: 14px;">
                        <h2>New Enquiry Notification</h2>
                        <p><strong>Enquiry ID:</strong> ${enquiryId || 'N/A'}</p>
                        <p><strong>User:</strong> ${userName || 'N/A'} (${userEmail || 'N/A'})</p>
                        <p><strong>Property:</strong> ${propertyName || 'N/A'}</p>
                        <p><strong>Message:</strong> ${message || 'N/A'}</p>
                    </div>
                `;
                await mailer.sendMail(adminEmails, subject, '', html);
            }
        } catch (mailErr) {
            console.warn('sendSuperAdminNewEnquiryNotification email failed:', mailErr.message);
        }
        
        res.status(201).json({ 
            success: true, 
            message: 'New enquiry notification sent to superadmin',
            notification 
        });
    } catch (error) {
        console.error('Error sending new enquiry notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==================== PROPERTY OWNER NOTIFICATIONS ====================

/**
 * Send notification to Property Owner for new booking request
 */
exports.sendOwnerNewBookingRequestNotification = async (req, res) => {
    try {
        const { ownerLoginId, ownerEmail, bookingId, propertyName, guestName, checkInDate, amount } = req.body;
        const normalizedOwnerLoginId = (ownerLoginId || '').toString().trim().toUpperCase();
        const resolvedOwnerEmail = (normalizedOwnerLoginId ? await resolveEmailByLoginId(normalizedOwnerLoginId) : '') || ownerEmail || '';
        
        // Create in-app notification
        const notification = await Notification.create({
            toRole: 'owner',
            toLoginId: normalizedOwnerLoginId || ownerLoginId,
            from: 'system',
            type: 'owner_new_booking_request',
            meta: { bookingId, propertyName, guestName, checkInDate, amount },
            read: false
        });
        
        // Send email notification
        if (resolvedOwnerEmail) {
            const mailer = require('../utils/mailer');
            const subject = `📅 New Booking Request for ${propertyName}`;
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #7c3aed;">New Booking Request</h2>
                    <p>You have received a new booking request for your property.</p>
                    <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                        <p><strong>Property:</strong> ${propertyName}</p>
                        <p><strong>Guest:</strong> ${guestName}</p>
                        <p><strong>Check-in:</strong> ${checkInDate}</p>
                        <p><strong>Amount:</strong> ₹${amount}</p>
                    </div>
                    <p>Please check your owner panel to accept or reject this booking.</p>
                </div>
            `;
            await mailer.sendMail(resolvedOwnerEmail, subject, '', html);
        }
        
        console.log(`📢 New booking request notification sent to owner: ${ownerLoginId}`);
        
        res.status(201).json({ 
            success: true, 
            message: 'Booking request notification sent to owner',
            notification 
        });
    } catch (error) {
        console.error('Error sending booking request notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Send notification to Property Owner for new chat message
 */
exports.sendOwnerNewChatNotification = async (req, res) => {
    try {
        const { ownerLoginId, ownerEmail, senderName, senderRole, message, chatId } = req.body;
        const normalizedOwnerLoginId = (ownerLoginId || '').toString().trim().toUpperCase();
        const resolvedOwnerEmail = (normalizedOwnerLoginId ? await resolveEmailByLoginId(normalizedOwnerLoginId) : '') || ownerEmail || '';
        
        // Create in-app notification
        const notification = await Notification.create({
            toRole: 'owner',
            toLoginId: normalizedOwnerLoginId || ownerLoginId,
            from: senderName,
            type: 'owner_new_chat',
            meta: { senderName, senderRole, message, chatId },
            read: false
        });
        
        // Send email notification
        if (resolvedOwnerEmail) {
            const mailer = require('../utils/mailer');
            const subject = `💬 New Message from ${senderName}`;
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #3b82f6;">New Chat Message</h2>
                    <p>You have received a new message from a ${senderRole}.</p>
                    <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                        <p><strong>From:</strong> ${senderName}</p>
                        <p><strong>Message:</strong> ${message}</p>
                    </div>
                    <p>Please check your chat in the owner panel to respond.</p>
                </div>
            `;
            await mailer.sendMail(resolvedOwnerEmail, subject, '', html);
        }
        
        console.log(`📢 New chat notification sent to owner: ${ownerLoginId}`);
        
        res.status(201).json({ 
            success: true, 
            message: 'Chat notification sent to owner',
            notification 
        });
    } catch (error) {
        console.error('Error sending chat notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Send notification to Property Owner for new bidding activity
 */
exports.sendOwnerNewBiddingNotification = async (req, res) => {
    try {
        const { ownerLoginId, ownerEmail, propertyName, bidderName, bidAmount, bidId } = req.body;
        const normalizedOwnerLoginId = (ownerLoginId || '').toString().trim().toUpperCase();
        const resolvedOwnerEmail = (normalizedOwnerLoginId ? await resolveEmailByLoginId(normalizedOwnerLoginId) : '') || ownerEmail || '';
        
        // Create in-app notification
        const notification = await Notification.create({
            toRole: 'owner',
            toLoginId: normalizedOwnerLoginId || ownerLoginId,
            from: 'system',
            type: 'owner_new_bidding',
            meta: { propertyName, bidderName, bidAmount, bidId },
            read: false
        });
        
        // Send email notification
        if (resolvedOwnerEmail) {
            const mailer = require('../utils/mailer');
            const subject = `💰 New Bid for ${propertyName}`;
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #10b981;">New Bid Received</h2>
                    <p>You have received a new bid for your property.</p>
                    <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                        <p><strong>Property:</strong> ${propertyName}</p>
                        <p><strong>Bidder:</strong> ${bidderName}</p>
                        <p><strong>Bid Amount:</strong> ₹${bidAmount}</p>
                    </div>
                    <p>Please check your owner panel to review and respond to this bid.</p>
                </div>
            `;
            await mailer.sendMail(resolvedOwnerEmail, subject, '', html);
        }
        
        console.log(`📢 New bidding notification sent to owner: ${ownerLoginId}`);
        
        res.status(201).json({ 
            success: true, 
            message: 'Bidding notification sent to owner',
            notification 
        });
    } catch (error) {
        console.error('Error sending bidding notification:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Get unread notification count for a user/role
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const { toLoginId, toRole } = req.query;
        
        const filter = { read: false };
        if (toLoginId) filter.toLoginId = toLoginId;
        if (toRole) filter.toRole = toRole;
        
        const count = await Notification.countDocuments(filter);
        
        res.json({ success: true, count });
    } catch (error) {
        console.error('Error getting unread count:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Mark all notifications as read
 */
exports.markAllRead = async (req, res) => {
    try {
        const { toLoginId, toRole } = req.body;
        
        const filter = { read: false };
        if (toLoginId) filter.toLoginId = toLoginId;
        if (toRole) filter.toRole = toRole;
        
        await Notification.updateMany(filter, { read: true });
        
        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        console.error('Error marking all as read:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Delete all read notifications
 */
exports.deleteReadNotifications = async (req, res) => {
    try {
        const { toLoginId, toRole } = req.query;
        
        const filter = { read: true };
        if (toLoginId) filter.toLoginId = toLoginId;
        if (toRole) filter.toRole = toRole;
        
        const result = await Notification.deleteMany(filter);
        
        res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error) {
        console.error('Error deleting read notifications:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};





