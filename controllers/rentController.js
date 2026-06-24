const Rent = require('../models/Rent');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const { sendMail } = require('../utils/mailer');
const Notification = require('../models/Notification');
const Owner = require('../models/Owner');
const crypto = require('crypto');

async function getTenantProfileByLoginId(loginId) {
    const normalizedLoginId = String(loginId || '').trim().toUpperCase();
    if (!normalizedLoginId) return null;
    try {
        const tenant = await Tenant.findOne({ loginId: normalizedLoginId }).lean();
        return tenant || null;
    } catch (err) {
        console.warn('Failed to load tenant profile for rent hydration:', err.message);
        return null;
    }
}

function applyTenantProfileToRent(rent, tenantProfile = {}) {
    if (!rent || !tenantProfile) return rent;

    rent.tenantLoginId = rent.tenantLoginId || tenantProfile.loginId;
    rent.tenantId = rent.tenantId || tenantProfile._id;
    rent.tenantName = rent.tenantName || tenantProfile.name || '';
    rent.tenantEmail = rent.tenantEmail || tenantProfile.email || '';
    rent.tenantPhone = rent.tenantPhone || tenantProfile.phone || '';
    rent.roomNumber = rent.roomNumber || tenantProfile.roomNo || '';
    rent.ownerLoginId = rent.ownerLoginId || tenantProfile.ownerLoginId || '';
    rent.propertyName = rent.propertyName || tenantProfile.propertyTitle || '';
    rent.rentAmount = Number(rent.rentAmount || tenantProfile.agreedRent || 0);
    rent.totalDue = Number(rent.totalDue || rent.rentAmount || tenantProfile.agreedRent || 0);
    return rent;
}

function buildRazorpayReceipt(prefix, primaryId, fallbackId) {
    const safePrefix = String(prefix || 'rcpt').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'rcpt';
    const safePrimary = String(primaryId || fallbackId || 'na').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'na';
    const stamp = Date.now().toString(36).slice(-8);
    return `${safePrefix}_${safePrimary}_${stamp}`.slice(0, 40);
}

// Create rent record for tenant
exports.createRent = async (req, res) => {
    try {
        const { tenantId, propertyId, rentAmount, deposit, tenantName, tenantEmail, tenantPhone, roomNumber, ownerLoginId, area } = req.body;

        const property = await Property.findById(propertyId);
        if (!property) return res.status(404).json({ error: 'Property not found' });

        const rent = new Rent({
            tenantId,
            propertyId,
            propertyName: property.title,
            rentAmount,
            deposit,
            totalDue: rentAmount + (deposit || 0),
            tenantName,
            tenantEmail,
            tenantPhone,
            roomNumber,
            area,
            ownerLoginId,
            collectionMonth: new Date().toISOString().slice(0, 7)
        });

        await rent.save();
        res.json({ success: true, rent });
    } catch (err) {
        console.error('Create rent error:', err);
        res.status(500).json({ error: err.message });
    }
};

// Get all rents for owner with filtering
exports.getRentsByOwner = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const { month, status } = req.query;

        let query = { ownerLoginId };
        if (month) query.collectionMonth = month;
        if (status) query.paymentStatus = status;

        const rents = await Rent.find(query).sort({ updatedAt: -1 }).populate('tenantId', 'name email phone').populate('propertyId', 'title');

        res.json({ success: true, rents });
    } catch (err) {
        console.error('Get rents error:', err);
        res.status(500).json({ error: err.message });
    }
};

// Get all rents (superadmin view)
exports.getAllRents = async (req, res) => {
    try {
        const { month, status, ownerLoginId, paymentStatus } = req.query;
        let query = {};

        if (month) query.collectionMonth = month;
        if (status) query.paymentStatus = status;
        if (ownerLoginId) query.ownerLoginId = ownerLoginId;
        if (paymentStatus) query.paymentStatus = paymentStatus;

        const rents = await Rent.find(query)
            .sort({ createdAt: -1 })
            .populate('tenantId', 'name email phone')
            .populate('propertyId', 'title');

        res.json({ success: true, rents });
    } catch (err) {
        console.error('Get all rents error:', err);
        res.status(500).json({ error: err.message });
    }
};

// Get single rent
exports.getRent = async (req, res) => {
    try {
        const { rentId } = req.params;
        const rent = await Rent.findById(rentId).populate('tenantId').populate('propertyId');
        if (!rent) return res.status(404).json({ error: 'Rent not found' });
        res.json({ success: true, rent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Update payment status after successful Razorpay payment
exports.recordPayment = async (req, res) => {
    try {
        const { rentId, razorpayPaymentId, paidAmount, paymentMethod } = req.body;

        const rent = await Rent.findById(rentId);
        if (!rent) return res.status(404).json({ error: 'Rent not found' });

        rent.paidAmount = (rent.paidAmount || 0) + paidAmount;
        rent.razorpayPaymentId = razorpayPaymentId;
        rent.paymentMethod = paymentMethod || 'razorpay';
        rent.paymentDate = new Date();

        if (rent.paidAmount >= rent.totalDue) {
            rent.paymentStatus = 'paid';
            rent.autoReminderEnabled = false;
            rent.autoReminderLastSentAt = undefined;
        } else if (rent.paidAmount > 0) {
            rent.paymentStatus = 'partially_paid';
        }

        await rent.save();

        // Send payment confirmation email
        await sendPaymentConfirmationEmail(rent);

        res.json({ success: true, rent, message: 'Payment recorded successfully' });
    } catch (err) {
        console.error('Record payment error:', err);
        res.status(500).json({ error: err.message });
    }
};

// Record payment by tenant (for Razorpay callback)
exports.recordPaymentByTenant = async (req, res) => {
    try {
        const { tenantId, razorpayPaymentId, paidAmount, paymentMethod } = req.body;

        console.log(`🔍 [recordPaymentByTenant] Searching for rent - tenantId: ${tenantId}, amount: ${paidAmount}`);

        if (!tenantId || !paidAmount) {
            return res.status(400).json({ error: 'tenantId and paidAmount required' });
        }

        const tenantProfile = await getTenantProfileByLoginId(tenantId);

        // Find the most recent unpaid or partially paid rent for this tenant
        // Search by tenantLoginId (string field) instead of tenantId (ObjectId)
        let rent = await Rent.findOne({
            $and: [
                {
                    $or: [
                        { tenantLoginId: tenantId }, // Primary search by login ID
                        { tenantEmail: tenantId } // Try email as fallback
                    ]
                },
                {
                    $or: [
                        { paymentStatus: { $in: ['pending', 'partially_paid'] } },
                        { paymentStatus: { $exists: false } }
                    ]
                }
            ]
        }).sort({ dueDate: -1 });

        console.log(`📊 [recordPaymentByTenant] Rent found:`, rent ? 'YES' : 'NO');

        if (!rent) {
            // If not found, try to create a minimal rent record for this first payment
            console.log(`⚠️ [recordPaymentByTenant] No rent found. Attempting to create one...`);
            
            rent = new Rent({
                tenantLoginId: tenantId,
                tenantId: tenantProfile?._id,
                ownerLoginId: tenantProfile?.ownerLoginId || '',
                tenantName: tenantProfile?.name || `Tenant ${tenantId}`,
                tenantEmail: tenantProfile?.email || '',
                tenantPhone: tenantProfile?.phone || '',
                propertyName: tenantProfile?.propertyTitle || '',
                roomNumber: tenantProfile?.roomNo || '',
                rentAmount: Number(tenantProfile?.agreedRent || paidAmount),
                totalDue: Number(tenantProfile?.agreedRent || paidAmount),
                paidAmount: paidAmount,
                paymentStatus: paidAmount > 0 ? 'paid' : 'pending',
                paymentMethod: paymentMethod || 'razorpay',
                razorpayPaymentId: razorpayPaymentId,
                paymentDate: new Date(),
                collectionMonth: new Date().toISOString().slice(0, 7)
            });
            applyTenantProfileToRent(rent, tenantProfile);
            
            await rent.save();
            console.log(`✅ [recordPaymentByTenant] Created new rent record: ${rent._id}`);
            
            // Send confirmation
            await sendPaymentConfirmationEmail(rent);
            
            return res.json({ 
                success: true, 
                rent, 
                message: 'Payment recorded and rent record created',
                paymentStatus: rent.paymentStatus,
                isNewRecord: true
            });
        }
        
        console.log(`✅ [recordPaymentByTenant] Found rent: ${rent._id}`);
        applyTenantProfileToRent(rent, tenantProfile);

        rent.paidAmount = (rent.paidAmount || 0) + paidAmount;
        rent.razorpayPaymentId = razorpayPaymentId;
        rent.paymentMethod = paymentMethod || 'razorpay';
        rent.paymentDate = new Date();

        // Update payment status
        if (rent.paidAmount >= rent.totalDue) {
            rent.paymentStatus = 'paid';
            rent.autoReminderEnabled = false;
            rent.autoReminderLastSentAt = undefined;
            console.log(`💳 [recordPaymentByTenant] Payment complete: ₹${rent.paidAmount} >= ₹${rent.totalDue}`);
        } else if (rent.paidAmount > 0) {
            rent.paymentStatus = 'partially_paid';
            console.log(`💳 [recordPaymentByTenant] Partial payment: ₹${rent.paidAmount} of ₹${rent.totalDue}`);
        }

        await rent.save();

        // Send payment confirmation email
        await sendPaymentConfirmationEmail(rent);

        console.log(`✅ Payment recorded for tenant ${tenantId}: ₹${paidAmount}`);

        res.json({ 
            success: true, 
            rent, 
            message: 'Payment recorded successfully',
            paymentStatus: rent.paymentStatus
        });
    } catch (err) {
        console.error('❌ Record payment by tenant error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to record payment' });
    }
};

exports.verifyRazorpayPayment = async (req, res) => {
    try {
        const {
            tenantId,
            rentId,
            paidAmount,
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body || {};

        if (!tenantId || !paidAmount || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, error: 'tenantId, paidAmount and Razorpay payment fields are required' });
        }

        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keySecret) {
            return res.status(500).json({ success: false, error: 'Razorpay secret is not configured' });
        }

        const expectedSignature = crypto
            .createHmac('sha256', keySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, error: 'Invalid Razorpay payment signature' });
        }

        req.body.razorpayPaymentId = razorpay_payment_id;
        req.body.paymentMethod = 'razorpay';

        const originalJson = res.json.bind(res);
        res.json = async (payload) => {
            try {
                const resolvedRentId = payload?.rent?._id || rentId;
                if (resolvedRentId) {
                    await Rent.findByIdAndUpdate(resolvedRentId, {
                        $set: {
                            razorpayOrderId: razorpay_order_id,
                            razorpayPaymentId: razorpay_payment_id,
                            razorpaySignature: razorpay_signature,
                            paymentMethod: 'razorpay'
                        }
                    });
                }
            } catch (e) {
                console.warn('Failed to persist Razorpay verification metadata:', e.message);
            }
            return originalJson({ ...payload, verified: true });
        };

        return exports.recordPaymentByTenant(req, res);
    } catch (err) {
        console.error('verifyRazorpayPayment error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to verify Razorpay payment' });
    }
};

// Get rent/payment history for a tenant by loginId
exports.getRentsByTenant = async (req, res) => {
    try {
        const tenantLoginId = String(req.params.tenantLoginId || '').trim().toUpperCase();
        const limit = Math.min(Number(req.query.limit || 12), 100);

        if (!tenantLoginId) {
            return res.status(400).json({ success: false, message: 'tenantLoginId is required' });
        }

        const rents = await Rent.find({ tenantLoginId })
            .sort({ paymentDate: -1, updatedAt: -1, createdAt: -1 })
            .limit(limit)
            .lean();

        return res.json({ success: true, rents });
    } catch (err) {
        console.error('Get rents by tenant error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Send payment confirmation email
async function sendPaymentConfirmationEmail(rent) {
    try {
        const subject = `Payment Confirmation - ${rent.propertyName}`;
        const transactionId = rent.razorpayPaymentId || rent.razorpayOrderId || 'N/A';
        const html = `
                <h2>Payment Confirmation</h2>
                <p>Dear ${rent.tenantName},</p>
                <p>Your rent payment has been recorded successfully.</p>
                <hr>
                <p><strong>Payment Details:</strong></p>
                <ul>
                    <li>Property: ${rent.propertyName}</li>
                    <li>Amount Paid: ₹${rent.paidAmount}</li>
                    <li>Total Due: ₹${rent.totalDue}</li>
                    <li>Payment Status: ${rent.paymentStatus}</li>
                    <li>Payment Method: ${rent.paymentMethod || 'N/A'}</li>
                    <li>Transaction ID: ${transactionId}</li>
                    <li>Payment Date: ${new Date(rent.paymentDate).toLocaleDateString()}</li>
                </ul>
                <p>Thank you for your payment!</p>
            `;

        if (rent.tenantEmail) {
            await sendMail(rent.tenantEmail, subject, '', html);
        }
        if (process.env.ADMIN_EMAIL) {
            await sendMail(process.env.ADMIN_EMAIL, `[Copy] ${subject}`, '', html);
        }

        console.log('Payment confirmation email attempted for', rent.tenantEmail || 'no-tenant-email');
    } catch (err) {
        console.error('Failed to send payment email:', err.message);
    }
}

// Send rent reminder (called during collection period: 10-15th)
exports.sendRentReminder = async (req, res) => {
    try {
        const today = new Date().getDate();
        
        if (today < 10 || today > 15) {
            return res.json({ message: 'Not in collection period (10-15th)' });
        }

        const currentMonth = new Date().toISOString().slice(0, 7);
        const pendingRents = await Rent.find({
            collectionMonth: currentMonth,
            paymentStatus: { $in: ['pending', 'partially_paid'] }
        });

        let sent = 0;
        for (const rent of pendingRents) {
            const emailSent = await sendRentReminderEmail(rent, 'initial');
            if (emailSent) {
                rent.reminders.push({
                    sentAt: new Date(),
                    type: 'initial',
                    status: 'sent',
                    message: 'Initial rent reminder'
                });
                await rent.save();
                sent++;
            }
        }

        res.json({ success: true, sent, message: `Sent ${sent} rent reminders` });
    } catch (err) {
        console.error('Send reminder error:', err);
        res.status(500).json({ error: err.message });
    }
};

// Send delayed payment reminder (3x daily for overdue rents)
exports.sendDelayedPaymentReminder = async (req, res) => {
    try {
        const today = new Date().getDate();
        
        if (today > 15 && today <= 31) {
            // Collection period ended, find overdue rents
            const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
            
            const overdueRents = await Rent.find({
                collectionMonth: lastMonth,
                paymentStatus: { $in: ['pending', 'partially_paid', 'overdue'] }
            });

            let sent = 0;
            for (const rent of overdueRents) {
                // Limit to 3 reminders per day for each rent
                const todayReminders = rent.reminders.filter(r => {
                    const sentDate = new Date(r.sentAt);
                    return sentDate.toDateString() === new Date().toDateString() && r.type.includes('delayed');
                });

                if (todayReminders.length < 3) {
                    const reminderType = `delayed_${todayReminders.length + 1}`;
                    const emailSent = await sendDelayedReminderEmail(rent, reminderType);
                    
                    if (emailSent) {
                        rent.paymentStatus = 'overdue';
                        if (!rent.overdueStartDate) rent.overdueStartDate = new Date();
                        
                        rent.reminders.push({
                            sentAt: new Date(),
                            type: reminderType,
                            status: 'sent',
                            message: `Delayed payment reminder #${todayReminders.length + 1}`
                        });
                        await rent.save();
                        sent++;
                    }
                }
            }

            res.json({ success: true, sent, message: `Sent ${sent} delayed payment reminders` });
        } else {
            res.json({ message: 'Collection period still active' });
        }
    } catch (err) {
        console.error('Send delayed reminder error:', err);
        res.status(500).json({ error: err.message });
    }
};

// Email function for rent reminder
async function sendRentReminderEmail(rent, type = 'initial') {
    try {
        const appBaseUrl = (process.env.APP_BASE_URL || 'https://app.roomhy.com').replace(/\/$/, '');
        const dashboardUrl = `${appBaseUrl}/tenant/tenantdashboard`;
        const onlinePayUrl = `${dashboardUrl}?pay=online`;
        const cashPayUrl = `${dashboardUrl}?pay=cash`;
        const subject = `Rent Due Reminder - ${rent.propertyName}`;
        const text = [
            `Hi ${rent.tenantName || 'Tenant'},`,
            `Your rent for ${rent.propertyName || 'your property'} is due by 15th (${rent.collectionMonth || 'current month'}).`,
            `Amount: INR ${Number(rent.rentAmount || 0)}`,
            '',
            'Payment options:',
            `1) Pay Online (Razorpay): ${onlinePayUrl}`,
            `2) Pay by Cash (Owner collection + OTP): ${cashPayUrl}`,
            '',
            'If already paid, please ignore this reminder.'
        ].join('\n');
        const html = `
                <h2>Rent Due Reminder</h2>
                <p>Dear ${rent.tenantName},</p>
                <p>This is a reminder that rent is due between <strong>10th to 15th</strong> of the month.</p>
                <hr>
                <p><strong>Rent Details:</strong></p>
                <ul>
                    <li>Property: ${rent.propertyName}</li>
                    <li>Room: ${rent.roomNumber}</li>
                    <li>Rent Amount: ₹${rent.rentAmount}</li>
                    <li>Collection Period: 10th - 15th of the month</li>
                    <li>Current Month: ${rent.collectionMonth}</li>
                </ul>
                <p style="color: #d32f2f;"><strong>Please complete your payment by 15th to avoid late fees.</strong></p>
                <p>Choose a payment method:</p>
                <p>
                    <a href="${onlinePayUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-right: 8px;">Pay Online (Razorpay)</a>
                    <a href="${cashPayUrl}" style="background-color: #16a34a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Pay by Cash</a>
                </p>
                <p style="font-size: 13px; color: #444;">
                    Cash flow: Request cash in tenant dashboard, owner marks received, then enter OTP to complete.
                </p>
            `;

        if (rent.tenantEmail) {
            await sendMail(rent.tenantEmail, subject, text, html);
        }
        if (process.env.ADMIN_EMAIL) {
            await sendMail(process.env.ADMIN_EMAIL, `[Copy] ${subject}`, text, html);
        }

        console.log('Rent reminder email attempted for', rent.tenantEmail || 'no-tenant-email');
        return true;
    } catch (err) {
        console.error('Failed to send rent reminder:', err.message);
        return false;
    }
}

// Email function for delayed payment reminder
async function sendDelayedReminderEmail(rent, reminderType) {
    try {
        const reminderNumber = reminderType.split('_')[1];
        const urgency = ['', 'URGENT', 'VERY URGENT', 'FINAL NOTICE'];
        const appBaseUrl = (process.env.APP_BASE_URL || 'https://app.roomhy.com').replace(/\/$/, '');
        const dashboardUrl = `${appBaseUrl}/tenant/tenantdashboard`;
        const onlinePayUrl = `${dashboardUrl}?pay=online`;
        const cashPayUrl = `${dashboardUrl}?pay=cash`;

        const subject = `${urgency[reminderNumber]} - Overdue Rent Payment - ${rent.propertyName}`;
        const text = [
            `${urgency[reminderNumber]}: Overdue rent payment`,
            `Property: ${rent.propertyName || '-'}`,
            `Room: ${rent.roomNumber || '-'}`,
            `Amount Due: INR ${Number((rent.totalDue || 0) - (rent.paidAmount || 0))}`,
            `Days Overdue: ${getDaysOverdue(rent.overdueStartDate)}`,
            '',
            'Pay now using:',
            `1) Razorpay Online: ${onlinePayUrl}`,
            `2) Cash + OTP flow: ${cashPayUrl}`
        ].join('\n');
        const html = `
                <h2 style="color: #d32f2f;">${urgency[reminderNumber]}</h2>
                <p>Dear ${rent.tenantName},</p>
                <p style="color: #d32f2f; font-weight: bold;">Your rent payment is overdue!</p>
                <hr>
                <p><strong>Overdue Details:</strong></p>
                <ul>
                    <li>Property: ${rent.propertyName}</li>
                    <li>Room: ${rent.roomNumber}</li>
                    <li>Amount Due: ₹${rent.totalDue - rent.paidAmount}</li>
                    <li>Due Date: 15th of ${rent.collectionMonth}</li>
                    <li>Days Overdue: ${getDaysOverdue(rent.overdueStartDate)}</li>
                </ul>
                <p style="color: #d32f2f; background-color: #fff3cd; padding: 10px; border-left: 4px solid #d32f2f;">
                    <strong>Reminder #${reminderNumber}:</strong> Please arrange payment immediately to avoid late fees and legal action.
                </p>
                <p>
                    <a href="${onlinePayUrl}" style="background-color: #d32f2f; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-right: 8px;">Pay Online (Razorpay)</a>
                    <a href="${cashPayUrl}" style="background-color: #16a34a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Pay by Cash</a>
                </p>
            `;

        if (rent.tenantEmail) {
            await sendMail(rent.tenantEmail, subject, text, html);
        }
        if (process.env.ADMIN_EMAIL) {
            await sendMail(process.env.ADMIN_EMAIL, `[Copy] ${subject}`, text, html);
        }

        console.log(`Delayed payment reminder #${reminderNumber} attempted for`, rent.tenantEmail || 'no-tenant-email');
        return true;
    } catch (err) {
        console.error('Failed to send delayed reminder:', err.message);
        return false;
    }
}

// Helper function to calculate days overdue
function getDaysOverdue(overdueStartDate) {
    if (!overdueStartDate) return 0;
    const today = new Date();
    const start = new Date(overdueStartDate);
    return Math.floor((today - start) / (1000 * 60 * 60 * 24));
}

// Update rent details (admin)
exports.updateRent = async (req, res) => {
    try {
        const { rentId } = req.params;
        const updateData = req.body;

        const rent = await Rent.findByIdAndUpdate(rentId, { $set: updateData }, { new: true });
        if (!rent) return res.status(404).json({ error: 'Rent not found' });

        res.json({ success: true, rent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Delete rent record
exports.deleteRent = async (req, res) => {
    try {
        const { rentId } = req.params;
        await Rent.findByIdAndDelete(rentId);
        res.json({ success: true, message: 'Rent deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Create Razorpay order for rent payment
exports.createRazorpayOrder = async (req, res) => {
    try {
        const Razorpay = require('razorpay');
        const { amount, tenantId, rentId, description } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // Check if Razorpay credentials are configured
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret || keySecret === 'your_key_secret_here') {
            console.error('⚠️  Razorpay credentials not configured. Add to .env file:');
            console.error('RAZORPAY_KEY_ID=rzp_test_xxxxx');
            console.error('RAZORPAY_KEY_SECRET=your_actual_key_secret');
            return res.status(500).json({ 
                error: 'Razorpay credentials not configured. Please add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env file',
                instructions: 'Get your credentials from https://dashboard.razorpay.com/app/keys'
            });
        }

        const razorpay = new Razorpay({
            key_id: keyId,
            key_secret: keySecret
        });

        const options = {
            amount: amount * 100, // Convert to paise
            currency: 'INR',
            receipt: buildRazorpayReceipt('rent', rentId, tenantId),
            notes: {
                tenantId: tenantId || 'unknown',
                rentId: rentId || 'unknown',
                description: description || 'Rent Payment'
            }
        };

        const order = await razorpay.orders.create(options);
        
        res.json({
            success: true,
            order: {
                id: order.id,
                amount: order.amount,
                currency: order.currency,
                receipt: order.receipt
            },
            key: keyId
        });
    } catch (err) {
        console.error('Razorpay order creation error:', err);
        res.status(500).json({ error: err.message || 'Failed to create payment order' });
    }
};


// Tenant requests cash payment collection by owner
exports.requestCashPayment = async (req, res) => {
    try {
        const {
            tenantLoginId,
            ownerLoginId,
            amount,
            propertyName,
            roomNumber,
            tenantName,
            tenantEmail,
            tenantPhone
        } = req.body || {};

        if (!tenantLoginId || !ownerLoginId || !amount) {
            return res.status(400).json({ success: false, message: 'tenantLoginId, ownerLoginId and amount are required' });
        }

        const loginId = String(tenantLoginId).trim().toUpperCase();
        const ownerId = String(ownerLoginId).trim().toUpperCase();
        const rentAmount = Number(amount || 0);
        if (!Number.isFinite(rentAmount) || rentAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid amount' });
        }

        const month = new Date().toISOString().slice(0, 7);

        const tenantProfile = await getTenantProfileByLoginId(loginId);

        let rent = await Rent.findOne({
            tenantLoginId: loginId,
            ownerLoginId: ownerId,
            collectionMonth: month
        }).sort({ createdAt: -1 });

        if (!rent) {
            rent = await Rent.create({
                tenantLoginId: loginId,
                ownerLoginId: ownerId,
                tenantId: tenantProfile?._id,
                tenantName: tenantName || tenantProfile?.name || '',
                tenantEmail: tenantEmail || tenantProfile?.email || '',
                tenantPhone: tenantPhone || tenantProfile?.phone || '',
                propertyName: propertyName || tenantProfile?.propertyTitle || '',
                roomNumber: roomNumber || tenantProfile?.roomNo || '',
                rentAmount,
                totalDue: rentAmount,
                paidAmount: 0,
                paymentStatus: 'pending',
                paymentMethod: 'cash',
                collectionMonth: month
            });
        } else {
            applyTenantProfileToRent(rent, tenantProfile);
            rent.paymentMethod = 'cash';
            rent.paymentStatus = rent.paymentStatus === 'paid' ? 'paid' : 'pending';
            rent.rentAmount = rentAmount || rent.rentAmount;
            rent.totalDue = rent.totalDue || rentAmount;
            rent.tenantName = tenantName || rent.tenantName;
            rent.tenantEmail = tenantEmail || rent.tenantEmail;
            rent.tenantPhone = tenantPhone || rent.tenantPhone;
            rent.propertyName = propertyName || rent.propertyName;
            rent.roomNumber = roomNumber || rent.roomNumber;
        }

        rent.cashRequestStatus = 'requested';
        rent.cashRequestedAt = new Date();
        rent.cashOtpCode = undefined;
        rent.cashOtpExpiry = undefined;
        rent.cashOtpSentAt = undefined;
        await rent.save();

        await Notification.create({
            toLoginId: ownerId,
            from: loginId,
            type: 'cash_payment_requested',
            meta: {
                title: 'Cash Payment Request',
                message: `${tenantName || loginId} requested cash payment collection`,
                rentId: String(rent._id),
                tenantLoginId: loginId,
                amount: rentAmount
            },
            read: false
        });

        try {
            const owner = await Owner.findOne({ loginId: ownerId }).select('email profile.email').lean();
            const ownerEmail = (owner && (owner.email || (owner.profile && owner.profile.email))) || '';
            if (ownerEmail) {
                const ownerPortalBaseUrl = (
                    process.env.OWNER_PORTAL_URL ||
                    process.env.API_URL ||
                    process.env.APP_BASE_URL ||
                    'https://api.roomhy.com'
                ).replace(/\/$/, '');
                const receivedUrl = `${ownerPortalBaseUrl}/propertyowner/payment-received?rentId=${encodeURIComponent(String(rent._id))}&ownerLoginId=${encodeURIComponent(ownerId)}`;
                const html = `
                    <div style="font-family:Arial,sans-serif;">
                        <h3>Cash Payment Request</h3>
                        <p>Tenant has requested to pay rent by cash.</p>
                        <p><strong>Tenant:</strong> ${tenantName || loginId}</p>
                        <p><strong>Login ID:</strong> ${loginId}</p>
                        <p><strong>Amount:</strong> INR ${rentAmount}</p>
                        <p><strong>Property:</strong> ${propertyName || '-'}</p>
                        <p><strong>Room:</strong> ${roomNumber || '-'}</p>
                        <p style="margin:16px 0;">
                            <a href="${receivedUrl}" style="background:#16a34a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;font-weight:600;">
                                Payment Received
                            </a>
                        </p>
                        <p style="font-size:12px;color:#666;">If button does not open, copy this link:<br>${receivedUrl}</p>
                    </div>
                `;
                await sendMail(ownerEmail, 'RoomHy Cash Payment Request', '', html);
            }
        } catch (e) {
            console.warn('cash request owner email failed:', e.message);
        }

        return res.json({ success: true, message: 'Cash payment request sent to owner', rent });
    } catch (err) {
        console.error('requestCashPayment error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Start reminder campaign for all unpaid rents and send immediate reminder
exports.startManualUnpaidReminders = async (req, res) => {
    try {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const unpaidRents = await Rent.find({
            collectionMonth: currentMonth,
            paymentStatus: { $in: ['pending', 'partially_paid', 'overdue', 'defaulted'] }
        });

        if (!unpaidRents.length) {
            return res.json({ success: true, sent: 0, enabled: 0, message: 'No unpaid tenants found' });
        }

        let sent = 0;
        let enabled = 0;
        for (const rent of unpaidRents) {
            const sentNow = await sendRentReminderEmail(rent, 'initial');

            rent.autoReminderEnabled = true;
            if (!rent.autoReminderStartedAt) {
                rent.autoReminderStartedAt = new Date();
            }
            if (sentNow) {
                rent.autoReminderLastSentAt = new Date();
                rent.reminders.push({
                    sentAt: new Date(),
                    type: 'auto_daily',
                    status: 'sent',
                    message: 'Manual trigger + daily auto reminder enabled'
                });
                sent++;
            }
            enabled++;
            await rent.save();
        }

        return res.json({
            success: true,
            sent,
            enabled,
            message: `Reminder sent to ${sent} unpaid tenant(s). Daily auto reminders enabled until payment.`
        });
    } catch (err) {
        console.error('startManualUnpaidReminders error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Owner marks cash received -> send OTP to tenant email
exports.markCashReceivedByOwner = async (req, res) => {
    try {
        const { rentId, ownerLoginId } = req.body || {};
        if (!rentId || !ownerLoginId) {
            return res.status(400).json({ success: false, message: 'rentId and ownerLoginId are required' });
        }

        const ownerId = String(ownerLoginId).trim().toUpperCase();
        const rent = await Rent.findById(rentId);
        if (!rent) return res.status(404).json({ success: false, message: 'Rent record not found' });
        if (String(rent.ownerLoginId || '').toUpperCase() !== ownerId) {
            return res.status(403).json({ success: false, message: 'Not authorized for this rent record' });
        }

        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const expiry = new Date(Date.now() + 10 * 60 * 1000);

        rent.cashRequestStatus = 'otp_sent';
        rent.cashReceivedAt = new Date();
        rent.cashOtpCode = otp;
        rent.cashOtpExpiry = expiry;
        rent.cashOtpSentAt = new Date();
        rent.paymentMethod = 'cash';
        await rent.save();

        if (!rent.tenantEmail) {
            return res.status(400).json({ success: false, message: 'Tenant email missing in rent record' });
        }

        const html = `
            <div style="font-family:Arial,sans-serif;">
                <h3>RoomHy Cash Payment OTP</h3>
                <p>Your owner marked cash as received.</p>
                <p>Enter this OTP in tenant panel to complete payment:</p>
                <p style="font-size:26px;font-weight:700;letter-spacing:3px;">${otp}</p>
                <p style="font-size:12px;color:#666;">Expires in 10 minutes.</p>
            </div>
        `;
        await sendMail(rent.tenantEmail, 'RoomHy Cash Payment OTP', '', html);

        return res.json({ success: true, message: 'OTP sent to tenant email', rentId: String(rent._id) });
    } catch (err) {
        console.error('markCashReceivedByOwner error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Tenant verifies cash OTP -> mark payment paid
exports.verifyCashPaymentOtp = async (req, res) => {
    try {
        const { tenantLoginId, otp } = req.body || {};
        if (!tenantLoginId || !otp) {
            return res.status(400).json({ success: false, message: 'tenantLoginId and otp are required' });
        }
        const loginId = String(tenantLoginId).trim().toUpperCase();
        const rent = await Rent.findOne({
            tenantLoginId: loginId,
            cashRequestStatus: { $in: ['otp_sent', 'received', 'requested'] }
        }).sort({ updatedAt: -1 });

        if (!rent) return res.status(404).json({ success: false, message: 'No pending cash payment found' });
        if (!rent.cashOtpCode || !rent.cashOtpExpiry) {
            return res.status(400).json({ success: false, message: 'OTP not sent yet by owner' });
        }
        if (new Date() > new Date(rent.cashOtpExpiry)) {
            return res.status(400).json({ success: false, message: 'OTP expired' });
        }
        if (String(otp).trim() !== String(rent.cashOtpCode).trim()) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        rent.cashRequestStatus = 'paid';
        rent.paymentStatus = 'paid';
        rent.paymentMethod = 'cash';
        rent.paidAmount = rent.totalDue || rent.rentAmount || rent.paidAmount || 0;
        rent.paymentDate = new Date();
        rent.autoReminderEnabled = false;
        rent.autoReminderLastSentAt = undefined;
        rent.cashOtpCode = undefined;
        rent.cashOtpExpiry = undefined;
        await rent.save();

        try {
            await Notification.create({
                toLoginId: String(rent.ownerLoginId || '').toUpperCase(),
                from: loginId,
                type: 'cash_payment_completed',
                meta: {
                    title: 'Cash Payment Completed',
                    message: `${rent.tenantName || loginId} verified cash OTP and payment marked paid`,
                    rentId: String(rent._id),
                    amount: rent.paidAmount
                },
                read: false
            });
        } catch (_) {}

        return res.json({ success: true, message: 'Cash payment marked as paid', rent });
    } catch (err) {
        console.error('verifyCashPaymentOtp error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

function normalizeLoginId(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeAccountNumber(value) {
    return String(value || '').replace(/\s+/g, '').trim();
}

function extractOwnerPayoutInfo(ownerDoc) {
    const profile = ownerDoc?.profile || {};
    return {
        ownerName: profile.name || ownerDoc?.name || '',
        ownerEmail: profile.email || ownerDoc?.email || '',
        bankName: profile.bankName || ownerDoc?.checkinBankName || '',
        accountHolderName: ownerDoc?.checkinAccountHolderName || profile.name || ownerDoc?.name || '',
        accountNumber: normalizeAccountNumber(profile.accountNumber || ownerDoc?.checkinBankAccountNumber || ''),
        ifscCode: (profile.ifscCode || ownerDoc?.checkinIfscCode || '').trim().toUpperCase(),
        branchName: profile.branchName || ownerDoc?.checkinBranchName || ''
    };
}

async function sendOwnerPayoutSuccessEmail({ toEmail, ownerName, amount, reference, propertyName, tenantLoginId }) {
    if (!toEmail) return;
    const subject = 'RoomHy Owner Payout Successful';
    const html = `
        <div style="font-family:Arial,sans-serif;color:#111">
            <h3>Owner Payout Completed</h3>
            <p>Hi ${ownerName || 'Owner'},</p>
            <p>Your payout has been transferred successfully.</p>
            <ul>
                <li><strong>Amount:</strong> INR ${Number(amount || 0).toLocaleString('en-IN')}</li>
                <li><strong>Reference:</strong> ${reference || '-'}</li>
                <li><strong>Property:</strong> ${propertyName || '-'}</li>
                <li><strong>Tenant Login ID:</strong> ${tenantLoginId || '-'}</li>
            </ul>
            <p>Thank you,<br>RoomHy Team</p>
        </div>
    `;
    await sendMail(toEmail, subject, '', html);
}

// Platform payout to owner bank account (superadmin action from platform.html)
exports.processOwnerPayout = async (req, res) => {
    try {
        const {
            ownerLoginId,
            tenantLoginId,
            amount,
            rentAmount,
            commissionAmount,
            serviceFeeAmount,
            propertyName
        } = req.body || {};

        const ownerId = normalizeLoginId(ownerLoginId);
        const tenantId = normalizeLoginId(tenantLoginId);
        const payoutAmount = Number(amount || 0);

        if (!ownerId || !tenantId || !Number.isFinite(payoutAmount) || payoutAmount <= 0) {
            return res.status(400).json({ success: false, message: 'ownerLoginId, tenantLoginId and valid amount are required' });
        }

        const ownerDoc = await Owner.findOne({ loginId: ownerId });
        if (!ownerDoc) {
            return res.status(404).json({ success: false, message: `Owner not found: ${ownerId}` });
        }

        const ownerInfo = extractOwnerPayoutInfo(ownerDoc);
        if (!ownerInfo.accountNumber || !ownerInfo.ifscCode) {
            return res.status(400).json({
                success: false,
                message: 'Owner bank details missing (account number / IFSC). Please complete owner profile first.'
            });
        }

        const month = new Date().toISOString().slice(0, 7);
        const rentDocs = await Rent.find({
            ownerLoginId: ownerId,
            tenantLoginId: tenantId,
            collectionMonth: month
        }).sort({ createdAt: -1 });

        if (!rentDocs.length) {
            return res.status(404).json({ success: false, message: 'No rent record found for this owner/tenant in current month' });
        }

        const anyAlreadyPaid = rentDocs.some((r) => r.ownerPayoutStatus === 'paid');
        if (anyAlreadyPaid) {
            return res.status(409).json({ success: false, message: 'Payout already completed for this owner/tenant' });
        }

        // Mark processing before external call
        await Rent.updateMany(
            { _id: { $in: rentDocs.map((r) => r._id) } },
            {
                $set: {
                    ownerPayoutStatus: 'processing',
                    ownerPayoutAmount: payoutAmount,
                    ownerPayoutNote: `Rent: ${Number(rentAmount || 0)}, Commission: ${Number(commissionAmount || 0)}, Service Fee: ${Number(serviceFeeAmount || 0)}`
                }
            }
        );

        const Razorpay = require('razorpay');
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        const payoutAccountNumber = process.env.RAZORPAY_PAYOUT_ACCOUNT_NUMBER;

        if (!keyId || !keySecret) {
            await Rent.updateMany(
                { _id: { $in: rentDocs.map((r) => r._id) } },
                { $set: { ownerPayoutStatus: 'failed', ownerPayoutNote: 'Razorpay key/secret not configured' } }
            );
            return res.status(500).json({ success: false, message: 'Razorpay credentials are not configured' });
        }

        if (!payoutAccountNumber) {
            await Rent.updateMany(
                { _id: { $in: rentDocs.map((r) => r._id) } },
                { $set: { ownerPayoutStatus: 'failed', ownerPayoutNote: 'RAZORPAY_PAYOUT_ACCOUNT_NUMBER missing' } }
            );
            return res.status(500).json({ success: false, message: 'RAZORPAY_PAYOUT_ACCOUNT_NUMBER is required for payout transfers' });
        }

        const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

        // Create contact and fund account for owner payout
        const contact = await razorpay.contacts.create({
            name: ownerInfo.ownerName || ownerId,
            email: ownerInfo.ownerEmail || undefined,
            type: 'vendor',
            reference_id: `owner_${ownerId}`,
            notes: { ownerLoginId: ownerId }
        });

        const fundAccount = await razorpay.fundAccount.create({
            contact_id: contact.id,
            account_type: 'bank_account',
            bank_account: {
                name: ownerInfo.accountHolderName || ownerInfo.ownerName || ownerId,
                ifsc: ownerInfo.ifscCode,
                account_number: ownerInfo.accountNumber
            }
        });

        const payout = await razorpay.payouts.create({
            account_number: payoutAccountNumber,
            fund_account_id: fundAccount.id,
            amount: Math.round(payoutAmount * 100),
            currency: 'INR',
            mode: 'IMPS',
            purpose: 'payout',
            queue_if_low_balance: true,
            reference_id: `roomhy_${ownerId}_${tenantId}_${Date.now()}`,
            narration: 'RoomHy Rent Payout',
            notes: {
                ownerLoginId: ownerId,
                tenantLoginId: tenantId,
                propertyName: propertyName || ''
            }
        });

        const payoutRef = payout.id || payout.reference_id || '';
        await Rent.updateMany(
            { _id: { $in: rentDocs.map((r) => r._id) } },
            {
                $set: {
                    ownerPayoutStatus: 'paid',
                    ownerPayoutAt: new Date(),
                    ownerPayoutRef: payoutRef,
                    ownerPayoutAmount: payoutAmount,
                    ownerPayoutNote: 'Transfer successful'
                }
            }
        );

        await sendOwnerPayoutSuccessEmail({
            toEmail: ownerInfo.ownerEmail,
            ownerName: ownerInfo.ownerName,
            amount: payoutAmount,
            reference: payoutRef,
            propertyName,
            tenantLoginId: tenantId
        });

        return res.json({
            success: true,
            message: 'Owner payout transferred successfully',
            payout: {
                id: payout.id,
                status: payout.status,
                amount: payoutAmount,
                reference: payoutRef
            }
        });
    } catch (err) {
        console.error('processOwnerPayout error:', err && err.message ? err.message : err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to process owner payout' });
    }
};

exports.getPlatformPayoutSummary = async (req, res) => {
    try {
        const rents = await Rent.find({}).select('ownerPayoutStatus ownerPayoutAmount commissionAmount serviceFeeAmount paidAmount totalDue rentAmount');
        const summary = {
            totalPayoutTransferred: 0,
            totalPendingPayout: 0,
            totalRents: 0,
            paidRows: 0,
            pendingRows: 0
        };

        rents.forEach((rent) => {
            summary.totalRents += Number(rent.rentAmount || rent.totalDue || 0);
            const payoutAmount = Number(rent.ownerPayoutAmount || 0);
            if (rent.ownerPayoutStatus === 'paid') {
                summary.totalPayoutTransferred += payoutAmount;
                summary.paidRows += 1;
            } else if (rent.ownerPayoutStatus === 'pending' || rent.ownerPayoutStatus === 'processing' || rent.ownerPayoutStatus === 'failed' || !rent.ownerPayoutStatus) {
                summary.totalPendingPayout += payoutAmount;
                summary.pendingRows += 1;
            }
        });

        return res.json({ success: true, summary });
    } catch (err) {
        console.error('getPlatformPayoutSummary error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to fetch payout summary' });
    }
};

exports.testTenantEmail = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email required' });

        const mailer = require('../utils/mailer');
        const subject = 'RoomHy System Check - Multiple Channel Verification';
        const text = 'Testing email delivery priorities: 1. Mailjet API, 2. Gmail SMTP.';
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #6366f1; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">RoomHy System Check</h2>
                </div>
                <div style="padding: 25px; color: #374151; line-height: 1.6;">
                    <p>Hello,</p>
                    <p>This is a <strong>multi-channel delivery test</strong> triggered from the RoomHy server.</p>
                    <p>Current configuration status:</p>
                    <ul style="padding-left: 20px;">
                        <li><strong>Primary:</strong> Mailjet HTTP API</li>
                        <li><strong>Fallback:</strong> Gmail SMTP Relay</li>
                    </ul>
                    <p>If you received this, the delivery system is functional.</p>
                </div>
            </div>
        `;

        const sent = await mailer.sendMail(email, subject, text, html);
        return res.json({ 
            success: sent, 
            message: sent ? 'Email sent successfully' : 'Email delivery failed (check mail_log.txt)' 
        });
    } catch (error) {
        console.error('testTenantEmail controller error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};
