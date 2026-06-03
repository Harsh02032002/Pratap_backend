const cron = require('node-cron');
let Rent = null;
let Tenant = null;
let Notification = null;
const { sendMail } = require('../utils/mailer');

try {
    Rent = require('../models/Rent');
    Tenant = require('../models/Tenant');
    Notification = require('../models/Notification');
} catch (err) {
    console.warn('⚠️ Models not found:', err.message);
}

// Send rent reminders: Every day at 10 AM during collection period (10-15th)
const rentReminderSchedule = cron.schedule('0 10 10-15 * *', async () => {
    if (!Rent) {
        console.warn('⚠️  Skipping rent reminder - dependencies not loaded');
        return;
    }
    console.log('🔔 Running rent reminder job...');
    try {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const pendingRents = await Rent.find({
            collectionMonth: currentMonth,
            paymentStatus: { $in: ['pending', 'partially_paid'] }
        });

        for (const rent of pendingRents) {
            await sendRentReminderEmail(rent);
            rent.reminders.push({
                sentAt: new Date(),
                type: 'initial',
                status: 'sent',
                message: 'Rent due reminder sent'
            });
            await rent.save();
        }

        console.log(`✅ Sent ${pendingRents.length} rent reminders`);
    } catch (err) {
        console.error('❌ Rent reminder job error:', err.message);
    }
});

// Send delayed payment reminders: 3x daily (9 AM, 2 PM, 6 PM) after 15th until 31st
const delayedReminderSchedule = cron.schedule('0 9,14,18 16-31 * *', async () => {
    if (!Rent) {
        console.warn('⚠️  Skipping delayed reminder - dependencies not loaded');
        return;
    }
    console.log('🚨 Running delayed payment reminder job...');
    try {
        // Get previous month's overdue rents
        const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
        
        const overdueRents = await Rent.find({
            collectionMonth: lastMonth,
            paymentStatus: { $in: ['pending', 'partially_paid', 'overdue'] }
        });

        let sent = 0;
        for (const rent of overdueRents) {
            // Limit to 3 reminders per day
            const todayReminders = rent.reminders.filter(r => {
                const sentDate = new Date(r.sentAt);
                return sentDate.toDateString() === new Date().toDateString() && r.type.includes('delayed');
            });

            if (todayReminders.length < 3) {
                const reminderNumber = todayReminders.length + 1;
                const sent_today = await sendDelayedReminderEmail(rent, reminderNumber);
                
                if (sent_today) {
                    rent.paymentStatus = 'overdue';
                    if (!rent.overdueStartDate) rent.overdueStartDate = new Date();
                    
                    rent.reminders.push({
                        sentAt: new Date(),
                        type: `delayed_${reminderNumber}`,
                        status: 'sent',
                        message: `Overdue payment reminder #${reminderNumber}`
                    });
                    await rent.save();
                    sent++;
                }
            }
        }

        console.log(`✅ Sent ${sent} delayed payment reminders`);
    } catch (err) {
        console.error('❌ Delayed reminder job error:', err.message);
    }
});

// Daily auto reminders for rents manually enabled from rent collection page
const autoReminderSchedule = cron.schedule('30 10 * * *', async () => {
    if (!Rent) {
        console.warn('??  Skipping daily auto reminder - dependencies not loaded');
        return;
    }

    console.log('?? Running daily auto reminder job...');
    try {
        const activeRents = await Rent.find({ autoReminderEnabled: true });

        let sent = 0;
        for (const rent of activeRents) {
            // Auto-stop if already paid
            if (rent.paymentStatus === 'paid' || rent.paymentStatus === 'completed') {
                rent.autoReminderEnabled = false;
                rent.autoReminderLastSentAt = undefined;
                await rent.save();
                continue;
            }

            const lastSent = rent.autoReminderLastSentAt ? new Date(rent.autoReminderLastSentAt) : null;
            const now = new Date();
            const alreadySentToday = lastSent && lastSent.toDateString() === now.toDateString();
            if (alreadySentToday) continue;

            const emailSent = await sendRentReminderEmail(rent);
            if (!emailSent) continue;

            rent.autoReminderLastSentAt = now;
            rent.reminders.push({
                sentAt: now,
                type: 'auto_daily',
                status: 'sent',
                message: 'Daily auto reminder sent'
            });
            await rent.save();
            sent++;
        }

        console.log(`? Sent ${sent} daily auto reminders`);
    } catch (err) {
        console.error('? Daily auto reminder job error:', err.message);
    }
});

// Daily agreement renewal checks (11-month rule)
const agreementRenewalSchedule = cron.schedule('0 9 * * *', async () => {
    if (!Tenant || !Notification) {
        console.warn('⚠️  Skipping agreement renewal job - dependencies not loaded');
        return;
    }
    console.log('🔔 Running agreement renewal check job...');
    try {
        const activeTenants = await Tenant.find({ status: 'active' });
        const now = new Date();
        
        let notifsSent = 0;
        for (const tenant of activeTenants) {
            const startDate = tenant.moveInDate || tenant.agreementSignedAt || tenant.createdAt;
            if (!startDate) continue;
            
            const start = new Date(startDate);
            const monthDiff = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
            
            // Trigger exactly when the day of month matches
            if (now.getDate() === start.getDate()) {
                if (monthDiff === 10) {
                    await Notification.create({
                        toLoginId: tenant.loginId,
                        type: 'system',
                        title: 'Agreement Renewal Upcoming',
                        message: 'Your 11-month agreement will expire in 1 month. Please prepare for renewal.',
                        read: false
                    });
                    if (tenant.ownerLoginId) {
                        await Notification.create({
                            toLoginId: tenant.ownerLoginId,
                            type: 'system',
                            title: 'Tenant Agreement Expiring',
                            message: `The 11-month agreement for tenant ${tenant.name} will expire in 1 month.`,
                            read: false
                        });
                    }
                    notifsSent++;
                } else if (monthDiff === 11) {
                    await Notification.create({
                        toLoginId: tenant.loginId,
                        type: 'system',
                        title: 'ACTION REQUIRED: Agreement Expired',
                        message: 'Your 11-month agreement has expired. You have 3 days to renew your agreement.',
                        read: false
                    });
                    if (tenant.ownerLoginId) {
                        await Notification.create({
                            toLoginId: tenant.ownerLoginId,
                            type: 'system',
                            title: 'Tenant Agreement Expired',
                            message: `The 11-month agreement for tenant ${tenant.name} has expired. They have 3 days to renew.`,
                            read: false
                        });
                    }
                    notifsSent++;
                }
            }
        }
        console.log(`✅ Sent ${notifsSent} agreement renewal notifications`);
    } catch (err) {
        console.error('❌ Agreement renewal job error:', err.message);
    }
});

// Send rent reminder email
async function sendRentReminderEmail(rent) {
    try {
        const appBaseUrl = (process.env.APP_BASE_URL || 'https://app.roomhy.com').replace(/\/$/, '');
        const dashboardUrl = `${appBaseUrl}/tenant/tenantdashboard`;
        const onlinePayUrl = `${dashboardUrl}?pay=online`;
        const cashPayUrl = `${dashboardUrl}?pay=cash`;
        const text = [
            `Hi ${rent.tenantName || 'Tenant'},`,
            `Rent due reminder for ${rent.propertyName || 'your property'}.`,
            `Amount: INR ${Number(rent.rentAmount || 0)}`,
            `Due: 15th of ${rent.collectionMonth || 'this month'}`,
            '',
            'Payment options:',
            `1) Online (Razorpay): ${onlinePayUrl}`,
            `2) Cash + OTP flow: ${cashPayUrl}`
        ].join('\n');
        const mailOptions = {
                        to: rent.tenantEmail,
                        subject: `🔔 Rent Due Reminder - ${rent.propertyName}`,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background-color: #2563eb; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
                        .content { background-color: #f3f4f6; padding: 20px; border-radius: 0 0 8px 8px; }
                        .details { background-color: white; padding: 15px; border-left: 4px solid #2563eb; margin: 15px 0; }
                        .alert { background-color: #fef3c7; border: 1px solid #fcd34d; color: #92400e; padding: 12px; border-radius: 4px; margin: 15px 0; }
                        .button { background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 15px 0; }
                        .footer { font-size: 12px; color: #6b7280; text-align: center; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h2>Rent Payment Reminder</h2>
                        </div>
                        <div class="content">
                            <p>Dear ${rent.tenantName},</p>
                            <p>This is a friendly reminder that your monthly rent is due between <strong>10th to 15th</strong> of the month.</p>
                            
                            <div class="details">
                                <h4>Rent Details:</h4>
                                <p><strong>Property:</strong> ${rent.propertyName}</p>
                                <p><strong>Room:</strong> ${rent.roomNumber}</p>
                                <p><strong>Rent Amount:</strong> ₹${rent.rentAmount}</p>
                                <p><strong>Due By:</strong> 15th of ${rent.collectionMonth}</p>
                            </div>
                            
                            <div class="alert">
                                <strong>Important:</strong> Please complete your payment by 15th to avoid late fees.
                            </div>
                            
                            <p>Choose a payment method below:</p>
                            <center>
                                <a href="${onlinePayUrl}" class="button" style="margin-right: 8px;">Pay Online (Razorpay)</a>
                                <a href="${cashPayUrl}" class="button" style="background-color:#16a34a;">Pay by Cash</a>
                            </center>
                            <p style="font-size: 13px; color:#555;">
                                Cash flow: request cash in dashboard, owner marks received, then verify OTP.
                            </p>
                            
                            <p>If you have already made the payment, please disregard this message.</p>
                            
                            <div class="footer">
                                <p>RoomHy - Property Management System</p>
                                <p>This is an automated message. Please do not reply to this email.</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
            `
        };

        await sendMail(mailOptions.to, mailOptions.subject, text, mailOptions.html);
        console.log('✅ Rent reminder email sent to', rent.tenantEmail);
        return true;
    } catch (err) {
        console.error('❌ Failed to send rent reminder:', err.message);
        return false;
    }
}

// Send delayed payment reminder email
async function sendDelayedReminderEmail(rent, reminderNumber = 1) {
    try {
        const urgencyLevels = ['', 'URGENT', 'VERY URGENT', 'FINAL NOTICE'];
        const urgency = urgencyLevels[reminderNumber] || 'FINAL NOTICE';
        const daysOverdue = Math.floor((new Date() - new Date(rent.overdueStartDate)) / (1000 * 60 * 60 * 24));
        const appBaseUrl = (process.env.APP_BASE_URL || 'https://app.roomhy.com').replace(/\/$/, '');
        const dashboardUrl = `${appBaseUrl}/tenant/tenantdashboard`;
        const onlinePayUrl = `${dashboardUrl}?pay=online`;
        const cashPayUrl = `${dashboardUrl}?pay=cash`;
        const text = [
            `${urgency} - Overdue rent payment`,
            `Property: ${rent.propertyName || '-'}`,
            `Outstanding: INR ${Number((rent.totalDue || 0) - (rent.paidAmount || 0))}`,
            `Days overdue: ${daysOverdue}`,
            '',
            `Pay online: ${onlinePayUrl}`,
            `Pay by cash: ${cashPayUrl}`
        ].join('\n');
        
        const mailOptions = {
                        to: rent.tenantEmail,
                        subject: `⚠️ ${urgency} - Overdue Rent Payment - ${rent.propertyName}`,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                        .header { background-color: #dc2626; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
                        .header h2 { margin: 0; font-size: 24px; }
                        .content { background-color: #fef2f2; padding: 20px; border-radius: 0 0 8px 8px; }
                        .alert { background-color: #fee2e2; border: 2px solid #dc2626; color: #7f1d1d; padding: 15px; border-radius: 4px; margin: 15px 0; font-weight: bold; }
                        .details { background-color: white; padding: 15px; border-left: 4px solid #dc2626; margin: 15px 0; }
                        .button { background-color: #dc2626; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 15px 0; font-weight: bold; }
                        .footer { font-size: 12px; color: #6b7280; text-align: center; margin-top: 20px; }
                        .reminder-count { background-color: #fbbf24; color: #78350f; padding: 10px; border-radius: 4px; margin: 10px 0; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h2>${urgency}</h2>
                            <p>Payment Overdue</p>
                        </div>
                        <div class="content">
                            <p>Dear ${rent.tenantName},</p>
                            <p><strong style="color: #dc2626;">Your rent payment is overdue!</strong></p>
                            
                            <div class="alert">
                                ⚠️ Immediate action required. Please arrange payment immediately.
                            </div>
                            
                            <div class="details">
                                <h4 style="color: #dc2626;">Overdue Details:</h4>
                                <p><strong>Property:</strong> ${rent.propertyName}</p>
                                <p><strong>Room:</strong> ${rent.roomNumber}</p>
                                <p><strong>Outstanding Amount:</strong> ₹${rent.totalDue - rent.paidAmount}</p>
                                <p><strong>Days Overdue:</strong> ${daysOverdue} days</p>
                                <p><strong>Original Due Date:</strong> 15th of ${rent.collectionMonth}</p>
                            </div>
                            
                            <div class="reminder-count">
                                <strong>Reminder #${reminderNumber} of 3</strong> - This is your ${reminderNumber === 1 ? 'first' : reminderNumber === 2 ? 'second' : 'final'} notice
                            </div>
                            
                            <p style="color: #dc2626;"><strong>Failure to pay may result in:</strong></p>
                            <ul style="color: #dc2626;">
                                <li>Late payment fees</li>
                                <li>Legal action</li>
                                <li>Eviction proceedings</li>
                            </ul>
                            
                            <center>
                                <a href="${onlinePayUrl}" class="button" style="margin-right:8px;">Pay Online (Razorpay)</a>
                                <a href="${cashPayUrl}" class="button" style="background-color:#16a34a;">Pay by Cash</a>
                            </center>
                            
                            <p style="margin-top: 20px; color: #6b7280;"><strong>Need help?</strong> Contact your property manager immediately.</p>
                            
                            <div class="footer">
                                <p>RoomHy - Property Management System</p>
                                <p>This is an automated message. Please do not reply to this email.</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
            `
        };

        await sendMail(mailOptions.to, mailOptions.subject, text, mailOptions.html);
        console.log(`✅ Delayed payment reminder #${reminderNumber} sent to`, rent.tenantEmail);
        return true;
    } catch (err) {
        console.error(`❌ Failed to send delayed reminder #${reminderNumber}:`, err.message);
        return false;
    }
}

// Export functions
module.exports = {
    startCronJobs: () => {
        console.log('🕐 Cron jobs initialized');
        console.log('   - Rent reminders: Daily 10 AM (10-15th)');
        console.log('   - Delayed payment reminders: 9 AM, 2 PM, 6 PM (after 15th)');
        console.log('   - Auto reminders: Daily 10:30 AM (enabled manually per unpaid rent)');
        console.log('   - Agreement renewals: Daily 9 AM (10 and 11 month checks)');
    },
    stopCronJobs: () => {
        rentReminderSchedule.stop();
        delayedReminderSchedule.stop();
        autoReminderSchedule.stop();
        agreementRenewalSchedule.stop();
        console.log('🛑 Cron jobs stopped');
    }
};

