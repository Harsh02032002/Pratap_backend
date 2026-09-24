const { sendMail } = require('./mailer');

/**
 * Send email notification for booking request acceptance
 */
async function sendBookingAcceptanceEmail(userEmail, userName, propertyName, ownerName) {
    try {
        const subject = `Booking Request Accepted - ${propertyName}`;
        const html = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">
                <h2>Great News! Your Booking Request Was Accepted 🎉</h2>
                <p>Hi ${userName},</p>
                <p>Your booking request for <strong>${propertyName}</strong> has been accepted by the property owner <strong>${ownerName}</strong>.</p>
                
                <div style="background-color: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 4px;">
                    <p><strong>Property:</strong> ${propertyName}</p>
                    <p><strong>Owner:</strong> ${ownerName}</p>
                    <p><strong>Status:</strong> Booking Accepted ✓</p>
                </div>
                
                <p>You can now view your booking details and communicate with the owner through our chat feature.</p>
                <p>
                    <a href="https://roomhy.com/website/mystays" style="background-color: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        View Your Booking
                    </a>
                </p>
                
                <p style="margin-top: 30px; font-size: 12px; color: #666;">
                    If you have any questions, please contact our support team.
                </p>
            </div>
        `;

        const text = `Your booking request for ${propertyName} has been accepted by ${ownerName}. Check your account for more details.`;

        await sendMail(userEmail, subject, text, html);
        console.log(`✅ Booking acceptance email sent to ${userEmail}`);
        return true;
    } catch (err) {
        console.error('❌ Failed to send booking acceptance email:', err);
        return false;
    }
}

/**
 * Send email notification for new chat messages
 */
async function sendNewChatNotificationEmail(userEmail, userName, senderName, messagePreview) {
    try {
        const subject = `New Message from ${senderName} - Roomhy`;
        const html = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">
                <h2>You Have a New Message 💬</h2>
                <p>Hi ${userName},</p>
                <p><strong>${senderName}</strong> sent you a new message:</p>
                
                <div style="background-color: #f9fafb; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 4px; font-style: italic;">
                    "${messagePreview}"
                </div>
                
                <p>Reply now to continue the conversation!</p>
                <p>
                    <a href="https://roomhy.com/website/websitechat" style="background-color: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        View Chat
                    </a>
                </p>
                
                <p style="margin-top: 30px; font-size: 12px; color: #666;">
                    Stay connected! You received this email because you enabled chat notifications.
                </p>
            </div>
        `;

        const text = `New message from ${senderName}: "${messagePreview}"`;

        await sendMail(userEmail, subject, text, html);
        console.log(`✅ Chat notification email sent to ${userEmail}`);
        return true;
    } catch (err) {
        console.error('❌ Failed to send chat notification email:', err);
        return false;
    }
}

/**
 * Send email notification for booking request
 */
async function sendBookingRequestEmail(ownerEmail, ownerName, tenantName, propertyName, tenantEmail) {
    try {
        const subject = `New Booking Request for ${propertyName}`;
        const html = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">
                <h2>New Booking Request! 📋</h2>
                <p>Hi ${ownerName},</p>
                <p>You have a new booking request for <strong>${propertyName}</strong> from <strong>${tenantName}</strong>.</p>
                
                <div style="background-color: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 4px;">
                    <p><strong>Tenant Name:</strong> ${tenantName}</p>
                    <p><strong>Tenant Email:</strong> ${tenantEmail}</p>
                    <p><strong>Property:</strong> ${propertyName}</p>
                </div>
                
                <p>Please review the request and accept or decline it within 24 hours.</p>
                <p style="margin-top: 30px; font-size: 12px; color: #666;">
                    Log in to your owner dashboard to manage booking requests.
                </p>
            </div>
        `;

        const text = `New booking request from ${tenantName} for ${propertyName}. Email: ${tenantEmail}`;

        await sendMail(ownerEmail, subject, text, html);
        console.log(`✅ Booking request email sent to ${ownerEmail}`);
        return true;
    } catch (err) {
        console.error('❌ Failed to send booking request email:', err);
        return false;
    }
}

/**
 * Send general notification email
 */
async function sendNotificationEmail(email, subject, message, actionUrl) {
    try {
        const html = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111;">
                <h2>${subject}</h2>
                <p>${message}</p>
                ${actionUrl ? `<p><a href="${actionUrl}" style="background-color: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">View Details</a></p>` : ''}
                <p style="margin-top: 30px; font-size: 12px; color: #666;">
                    Roomhy Team
                </p>
            </div>
        `;

        await sendMail(email, subject, message, html);
        console.log(`✅ Notification email sent to ${email}`);
        return true;
    } catch (err) {
        console.error('❌ Failed to send notification email:', err);
        return false;
    }
}

/** Escape user-authored text before it goes into an HTML email body. */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Remind someone that a chat message is sitting unread.
 *
 * Sent by jobs/unreadChatReminderJob once a message has gone unread for the
 * fixed delay. The two audiences land in different places, which is the whole
 * reason this is not one generic template:
 *
 *   owner  -> the Owner Panel  (app.roomhy.com/propertyowner/ownerchat)
 *   tenant -> the website chat (roomhy.com/website/chat, after logging in)
 *
 * Base URLs follow the convention already established in utils/mailer.js
 * getLoginUrlForRole: client apps are APP_URL (never admin.roomhy.com), the
 * public site is WEBSITE_URL.
 *
 * @param {object}  args
 * @param {string}  args.to             recipient email address
 * @param {string}  args.recipientName  who we are writing to
 * @param {string}  args.senderName     who sent the unread message(s)
 * @param {number}  args.unreadCount    how many are waiting
 * @param {string}  args.preview        text of the most recent message
 * @param {'owner'|'tenant'} args.audience which product surface to send them to
 * @returns {Promise<boolean>} whether the mail was handed to the transport
 */
async function sendUnreadChatReminderEmail({ to, recipientName, senderName, unreadCount, preview, audience }) {
    try {
        const isOwner = audience === 'owner';

        const appUrl = (process.env.APP_URL || process.env.CLIENT_APP_URL || 'https://app.roomhy.com').replace(/\/$/, '');
        const siteUrl = (process.env.WEBSITE_URL || 'https://roomhy.com').replace(/\/$/, '');

        const chatUrl = isOwner ? `${appUrl}/propertyowner/ownerchat` : `${siteUrl}/website/chat`;
        const ctaLabel = isOwner ? 'Open Owner Panel' : 'Open your messages';
        const whereText = isOwner
            ? 'Sign in to your Owner Panel and open Communication → Chat to reply.'
            : 'Log in to your Roomhy account and open Messages to reply.';

        const plural = unreadCount > 1;
        const countLine = plural
            ? `${unreadCount} unread messages from ${senderName}`
            : `an unread message from ${senderName}`;

        const subject = plural
            ? `${unreadCount} unread messages from ${senderName} - Roomhy`
            : `${senderName} is waiting for your reply - Roomhy`;

        const safeName = escapeHtml(recipientName || (isOwner ? 'there' : 'there'));
        const safeSender = escapeHtml(senderName);
        const safePreview = escapeHtml(preview);

        const html = `
            <div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #111; line-height: 1.6;">
                <h2 style="margin-bottom: 4px;">You have ${plural ? 'unread messages' : 'an unread message'}</h2>
                <p style="color:#666; margin-top:0;">Hi ${safeName}, you have ${escapeHtml(countLine)} waiting on Roomhy.</p>

                <div style="background-color: #f9fafb; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 4px;">
                    <p style="margin:0 0 6px; font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:.5px;">
                        ${safeSender} wrote
                    </p>
                    <p style="margin:0; font-style: italic;">"${safePreview}"</p>
                    ${plural ? `<p style="margin:10px 0 0; font-size:12px; color:#6b7280;">+ ${unreadCount - 1} more message${unreadCount - 1 > 1 ? 's' : ''}</p>` : ''}
                </div>

                <p>${whereText}</p>
                <p>
                    <a href="${chatUrl}" style="background-color: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                        ${ctaLabel}
                    </a>
                </p>

                <p style="margin-top: 30px; font-size: 12px; color: #666;">
                    Replying quickly keeps your booking moving. Please keep the conversation and any
                    payment on Roomhy - it is what lets us protect both sides of the booking.
                </p>
                <p style="font-size: 12px; color: #999;">
                    You are receiving this because a message you have not opened yet was sent to you on Roomhy.
                </p>
            </div>
        `;

        const text = [
            `Hi ${recipientName || 'there'},`,
            '',
            `You have ${countLine} waiting on Roomhy.`,
            '',
            `${senderName} wrote: "${preview}"`,
            '',
            whereText,
            chatUrl
        ].join('\n');

        await sendMail(to, subject, text, html);
        console.log(`✅ Unread-chat reminder sent (${audience}) for ${unreadCount} message(s)`);
        return true;
    } catch (err) {
        console.error('❌ Failed to send unread-chat reminder email:', err.message);
        return false;
    }
}

module.exports = {
    sendBookingAcceptanceEmail,
    sendNewChatNotificationEmail,
    sendBookingRequestEmail,
    sendNotificationEmail,
    sendUnreadChatReminderEmail
};

