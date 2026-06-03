const Notification = require('../models/Notification');
const User = require('../models/user');
const mailer = require('./mailer');

async function getSuperadminEmails() {
    const users = await User.find({ role: 'superadmin' }).select('email').lean();
    const emails = users.map((u) => u.email).filter(Boolean);
    if (process.env.SUPERADMIN_EMAIL) emails.push(process.env.SUPERADMIN_EMAIL);
    if (process.env.MAILJET_FROM_EMAIL) emails.push(process.env.MAILJET_FROM_EMAIL);
    return [...new Set(emails)];
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildMetaHtml(meta = {}) {
    const rows = Object.entries(meta)
        .filter(([, v]) => v !== undefined && v !== null && `${v}`.trim() !== '')
        .slice(0, 12)
        .map(([k, v]) => `<p><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`)
        .join('');

    return rows || '<p>No additional details.</p>';
}

async function notifySuperadmin({
    type,
    from = 'system',
    meta = {},
    subject = 'RoomHy Superadmin Alert',
    message = 'A new update is available in Superadmin panel.'
}) {
    if (!type) return null;

    const notification = await Notification.create({
        toRole: 'superadmin',
        toLoginId: 'superadmin',
        from,
        type,
        meta,
        read: false
    });

    try {
        const emails = await getSuperadminEmails();
        if (emails.length) {
            const html = `
                <div style="font-family: Arial, sans-serif; font-size: 14px;">
                    <h2>RoomHy Superadmin Notification</h2>
                    <p>${escapeHtml(message)}</p>
                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">
                        ${buildMetaHtml(meta)}
                    </div>
                </div>
            `;
            await mailer.sendMail(emails, subject, message, html);
        }
    } catch (mailError) {
        console.warn('notifySuperadmin email failed:', mailError.message);
    }

    return notification;
}

module.exports = { notifySuperadmin };
