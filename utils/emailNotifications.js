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

module.exports = {
    sendBookingAcceptanceEmail,
    sendNewChatNotificationEmail,
    sendBookingRequestEmail,
    sendNotificationEmail
};
