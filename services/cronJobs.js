const cron = require('node-cron');
let Rent = null;
let Tenant = null;
let Notification = null;
let Owner = null;
let Property = null;
let Room = null;
let Complaint = null;
let TaskBoard = null;
let VisitorLog = null;
let ElectricityMeter = null;
let OwnerChangeRequest = null;
const { sendMail } = require('../utils/mailer');

try {
    Rent = require('../models/Rent');
    Tenant = require('../models/Tenant');
    Notification = require('../models/Notification');
    Owner = require('../models/Owner');
    Property = require('../models/Property');
    Room = require('../models/Room');
    Complaint = require('../models/Complaint');
    TaskBoard = require('../models/TaskBoard');
    VisitorLog = require('../models/VisitorLog');
    ElectricityMeter = require('../models/ElectricityMeter');
    OwnerChangeRequest = require('../models/OwnerChangeRequest');
} catch (err) {
    console.warn('⚠️ Models not found:', err.message);
}

// Ensure DEMO owner exists
async function initDemoOwner() {
    if (!Owner) return;
    try {
        const demoLoginId = 'ROOMHY0000';
        let demo = await Owner.findOne({ loginId: demoLoginId });
        
        if (!demo) {
            demo = await Owner.create({
                loginId: demoLoginId,
                name: 'Demo Owner',
                email: 'demo@roomhy.com',
                phone: '0000000000',
                isActive: true,
                credentials: {
                    password: 'demo123',
                    firstTime: false
                }
            });
            console.log(`✅ Demo owner profile created: ${demoLoginId}`);
        } else if (!demo.credentials || !demo.credentials.password) {
            // Patch existing broken demo account
            demo.credentials = { password: 'demo123', firstTime: false };
            await demo.save();
            console.log('✅ Demo owner profile patched with credentials');
        }

        const User = require('../models/user');
        if (User) {
            const demoUser = await User.findOne({ loginId: demoLoginId });
            if (!demoUser) {
                await User.create({
                    loginId: demoLoginId,
                    name: 'Demo Owner',
                    email: 'demo@roomhy.com',
                    phone: '0000000000',
                    password: 'demo123', // Will be hashed by User pre-save hook
                    role: 'owner',
                    isActive: true,
                    requirePasswordReset: false
                });
                console.log(`✅ Demo owner auth record created: ${demoLoginId} / demo123`);
            } else if (demoUser.requirePasswordReset !== false) {
                demoUser.requirePasswordReset = false;
                await demoUser.save();
            }
        }
    } catch (err) {
        console.error('❌ Failed to init demo owner:', err.message);
    }
}

// Reset DEMO account data every night at midnight
const demoResetSchedule = cron.schedule('0 0 * * *', async () => {
    if (!Owner || !Property) return;
    console.log('🔄 Running daily reset for ROOMHY0000 account...');
    try {
        const demoLoginId = 'ROOMHY0000';
        
        // 1. Get properties
        const properties = await Property.find({ ownerLoginId: demoLoginId });
        const propIds = properties.map(p => p._id);
        
        // 2. Delete Relational Data
        if (Room) await Room.deleteMany({ property: { $in: propIds } });
        if (ElectricityMeter) await ElectricityMeter.deleteMany({ property: { $in: propIds } });
        
        if (Tenant) {
            const tenants = await Tenant.find({ ownerLoginId: demoLoginId });
            const tenantIds = tenants.map(t => t._id);
            if (Rent) await Rent.deleteMany({ tenant: { $in: tenantIds } });
            await Tenant.deleteMany({ ownerLoginId: demoLoginId });
        }
        
        if (Complaint) await Complaint.deleteMany({ ownerLoginId: demoLoginId });
        
        // TaskBoard belongs to owner by object id, fetch owner first
        const demoOwner = await Owner.findOne({ loginId: demoLoginId });
        if (demoOwner && TaskBoard) {
            await TaskBoard.deleteMany({ ownerId: demoOwner._id });
        }
        
        if (VisitorLog) await VisitorLog.deleteMany({ ownerLoginId: demoLoginId });
        if (OwnerChangeRequest) await OwnerChangeRequest.deleteMany({ ownerLoginId: demoLoginId });
        
        // 3. Delete Properties
        await Property.deleteMany({ ownerLoginId: demoLoginId });

        // 4. Reset Owner profile (keep login active but clear PII/Bank details)
        if (demoOwner) {
            demoOwner.checkinAccountHolderName = '';
            demoOwner.checkinBankName = '';
            demoOwner.checkinBranchName = '';
            demoOwner.checkinBankAccountNumber = '';
            demoOwner.checkinIfscCode = '';
            demoOwner.checkinUpiId = '';
            demoOwner.roomCount = 0;
            demoOwner.bedCount = 0;
            demoOwner.vacantRooms = 0;
            demoOwner.vacantBeds = 0;
            demoOwner.occupiedRooms = 0;
            demoOwner.occupiedBeds = 0;
            demoOwner.roomInventory = [];
            await demoOwner.save();
        }

        console.log('✅ Successfully wiped and reset ROOMHY0000 account data.');
    } catch (err) {
        console.error('❌ Failed to reset demo account:', err.message);
    }
});

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
// Runs daily at 9 AM — handles missed dates, grace period, and auto ex-tenant
const agreementRenewalSchedule = cron.schedule('0 9 * * *', async () => {
    if (!Tenant || !Notification) {
        console.warn('⚠️  Skipping agreement renewal job - dependencies not loaded');
        return;
    }
    console.log('🔔 Running agreement renewal check job...');
    try {
        const activeTenants = await Tenant.find({ status: { $in: ['active', 'inactive'] } });
        const now = new Date();
        now.setHours(0, 0, 0, 0); // normalize to midnight

        let notifsSent = 0;
        let exTenantCount = 0;

        for (const tenant of activeTenants) {
            const startDate = tenant.moveInDate || tenant.agreementSignedAt || tenant.createdAt;
            if (!startDate) continue;

            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);

            // Total days since move-in
            const daysSince = Math.floor((now - start) / (1000 * 60 * 60 * 24));

            // Calculate months diff more accurately
            const monthDiff = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());

            // Day of month difference within current month
            const dayInMonthDiff = now.getDate() - start.getDate();

            // ── 11 months + 3 days grace expired → Auto Ex-Tenant ─────────────────
            // Either more than 11 months, or exactly 11 months and 3+ days past anniversary
            const isGraceExpired = monthDiff > 11 || (monthDiff === 11 && dayInMonthDiff >= 3);

            if (isGraceExpired && tenant.status === 'active') {
                // Auto move to inactive (ex-tenant)
                tenant.status = 'inactive';
                await tenant.save();
                exTenantCount++;

                // Notify tenant
                if (tenant.loginId) {
                    await Notification.create({
                        toLoginId: tenant.loginId,
                        from: 'system',
                        type: 'system',
                        meta: { title: '⚠️ Agreement Expired — Account Suspended', message: 'Your 11-month agreement has expired and the 3-day grace period is over. Your account has been marked inactive. Please contact your property owner to renew.' },
                        read: false
                    });
                }

                // Notify owner
                if (tenant.ownerLoginId) {
                    await Notification.create({
                        toLoginId: tenant.ownerLoginId,
                        from: 'system',
                        type: 'system',
                        meta: { title: `🚨 Tenant ${tenant.name} — Agreement Expired`, message: `Tenant ${tenant.name} (Room: ${tenant.roomNo || 'N/A'}) agreement has expired and grace period is over. They have been marked inactive. Please renew or process moveout.` },
                        read: false
                    });
                }

                // Send email to tenant
                if (tenant.email) {
                    await sendMail(
                        tenant.email,
                        '⚠️ Your Roomhy Agreement Has Expired',
                        `Dear ${tenant.name}, your 11-month rental agreement has expired. Please contact your property owner to renew.`,
                        `<h2>Agreement Expired</h2><p>Dear ${tenant.name},</p><p>Your 11-month rental agreement at <b>${tenant.propertyTitle || 'your property'}</b> has expired and the 3-day grace period is now over.</p><p>Your account has been marked inactive. Please contact your property owner immediately to renew your agreement.</p><br><p>— Roomhy Team</p>`
                    ).catch(e => console.error('Email failed:', e.message));
                }

                console.log(`🚨 Auto ex-tenant: ${tenant.name} (${tenant.loginId}) — ${daysSince} days`);
                notifsSent++;
                continue; // Skip other checks for this tenant
            }

            // ── 11-month mark — Agreement Expired, 3-day grace starts ──────────────
            // Fire on anniversary day OR within 2 days after (in case cron missed)
            const isAt11Month = monthDiff === 11 && dayInMonthDiff >= 0 && dayInMonthDiff <= 2;

            if (isAt11Month && tenant.status === 'active') {
                // Check if we already sent this notification recently (dedup)
                const recentNotif = await Notification.findOne({
                    toLoginId: tenant.loginId,
                    title: { $regex: 'ACTION REQUIRED', $options: 'i' },
                    createdAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
                }).catch(() => null);

                if (!recentNotif) {
                    if (tenant.loginId) {
                        await Notification.create({
                            toLoginId: tenant.loginId,
                            from: 'system',
                            type: 'system',
                            meta: { title: 'ACTION REQUIRED: Agreement Expired', message: 'Your 11-month rental agreement has expired. You have 3 days to renew. After 3 days, your account will be suspended.' },
                            read: false
                        });
                    }
                    if (tenant.ownerLoginId) {
                        await Notification.create({
                            toLoginId: tenant.ownerLoginId,
                            from: 'system',
                            type: 'system',
                            meta: { title: `Tenant Agreement Expired — ${tenant.name}`, message: `The 11-month agreement for tenant ${tenant.name} (Room: ${tenant.roomNo || 'N/A'}) has expired. They have 3 days to renew before being marked inactive.` },
                            read: false
                        });
                    }

                    // Email tenant
                    if (tenant.email) {
                        await sendMail(
                            tenant.email,
                            '⚠️ ACTION REQUIRED: Your Agreement Has Expired',
                            `Dear ${tenant.name}, your 11-month agreement has expired. You have 3 days to renew.`,
                            `<h2>Agreement Expired — Action Required</h2><p>Dear ${tenant.name},</p><p>Your 11-month rental agreement at <b>${tenant.propertyTitle || 'your property'}</b> has expired.</p><p><b>You have 3 days to renew your agreement.</b> After 3 days, your account will be automatically suspended.</p><p>Please contact your property owner immediately.</p><br><p>— Roomhy Team</p>`
                        ).catch(e => console.error('Email failed:', e.message));
                    }

                    notifsSent++;
                    console.log(`⚠️  11-month expiry notif sent: ${tenant.name} (${daysSince} days)`);
                }
                continue;
            }

            // ── 10-month mark — 1-month warning ────────────────────────────────────
            // Fire on anniversary day OR within 2 days after (catch-up)
            const isAt10Month = monthDiff === 10 && dayInMonthDiff >= 0 && dayInMonthDiff <= 2;

            if (isAt10Month && tenant.status === 'active') {
                // Dedup: check if already sent in last 3 days
                const recentNotif = await Notification.findOne({
                    toLoginId: tenant.loginId,
                    title: { $regex: 'Agreement Renewal Upcoming', $options: 'i' },
                    createdAt: { $gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
                }).catch(() => null);

                if (!recentNotif) {
                    if (tenant.loginId) {
                        await Notification.create({
                            toLoginId: tenant.loginId,
                            from: 'system',
                            type: 'system',
                            meta: { title: '🔔 Agreement Renewal Upcoming', message: 'Your 11-month rental agreement will expire in 1 month. Please prepare for renewal with your property owner.' },
                            read: false
                        });
                    }
                    if (tenant.ownerLoginId) {
                        await Notification.create({
                            toLoginId: tenant.ownerLoginId,
                            from: 'system',
                            type: 'system',
                            meta: { title: `Tenant Agreement Expiring Soon — ${tenant.name}`, message: `The 11-month agreement for tenant ${tenant.name} (Room: ${tenant.roomNo || 'N/A'}) will expire in 1 month.` },
                            read: false
                        });
                    }

                    // Email tenant
                    if (tenant.email) {
                        await sendMail(
                            tenant.email,
                            '🔔 Your Agreement Expires in 1 Month',
                            `Dear ${tenant.name}, your rental agreement expires in 1 month. Please contact your property owner to renew.`,
                            `<h2>Agreement Renewal Reminder</h2><p>Dear ${tenant.name},</p><p>Your 11-month rental agreement at <b>${tenant.propertyTitle || 'your property'}</b> will expire in <b>1 month</b>.</p><p>Please contact your property owner to discuss renewal before it expires.</p><br><p>— Roomhy Team</p>`
                        ).catch(e => console.error('Email failed:', e.message));
                    }

                    notifsSent++;
                    console.log(`🔔 10-month warning sent: ${tenant.name} (${daysSince} days)`);
                }
            }
        }

        console.log(`✅ Agreement renewal job done: ${notifsSent} notifications, ${exTenantCount} auto ex-tenants`);
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
        initDemoOwner(); // Ensure DEMO owner is ready
        console.log('🕐 Cron jobs initialized');
        console.log('   - Demo account reset: Daily midnight');
        console.log('   - Rent reminders: Daily 10 AM (10-15th)');
        console.log('   - Delayed payment reminders: 9 AM, 2 PM, 6 PM (after 15th)');
        console.log('   - Auto reminders: Daily 10:30 AM (enabled manually per unpaid rent)');
        console.log('   - Agreement renewals: Daily 9 AM (10 and 11 month checks)');
    },
    stopCronJobs: () => {
        demoResetSchedule.stop();
        rentReminderSchedule.stop();
        delayedReminderSchedule.stop();
        autoReminderSchedule.stop();
        agreementRenewalSchedule.stop();
        console.log('🛑 Cron jobs stopped');
    }
};

