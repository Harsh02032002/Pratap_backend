const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { formLimiter, refundLimiter } = require('../middleware/security');

// ================== CONFIG ROUTES ==================

// Get Razorpay Key (public endpoint for frontend payment initialization)
router.get('/config/razorpay-key', (req, res) => {
    try {
        const key = process.env.RAZORPAY_KEY_ID;
        
        if (!key || key === 'rzp_test_default' || !key.startsWith('rzp_')) {
            console.warn('⚠️  RAZORPAY_KEY_ID not configured properly');
            console.warn('⚠️  Current value:', key || 'UNDEFINED');
            console.warn('⚠️  Please set RAZORPAY_KEY_ID in .env file with a valid Razorpay key');
            console.warn('⚠️  Keys should start with: rzp_test_ (test) or rzp_live_ (production)');
        } else {
            console.log('✅ Razorpay key configured:', key.substring(0, 15) + '...');
        }
        
        res.json({ 
            success: true,
            razorpayKey: key || 'rzp_test_default'
        });
    } catch (error) {
        console.error('❌ Error fetching Razorpay key:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            hint: 'Check RAZORPAY_KEY_ID in .env file'
        });
    }
});

// Get Default Booking Token Amount (public endpoint for frontend booking checkout)
router.get('/config/booking-amount', async (req, res) => {
    try {
        const SystemSettings = require('../models/SystemSettings');
        const settings = await SystemSettings.findOne().lean();
        const bookingAmount = settings?.defaultBookingAmount ?? 500;
        res.json({ success: true, bookingAmount });
    } catch (error) {
        res.json({ success: true, bookingAmount: 500 });
    }
});

// Create Razorpay order for booking payment
router.post('/create-order', (req, res) => {
    try {
        const Razorpay = require('razorpay');
        const { amount, currency = 'INR', receipt, notes } = req.body;

        if (!amount) {
            return res.status(400).json({ 
                success: false, 
                message: 'Amount is required' 
            });
        }

        // Check if keys are configured
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            console.error('❌ RAZORPAY CONFIGURATION ERROR');
            console.error('❌ RAZORPAY_KEY_ID:', keyId ? 'SET' : 'MISSING');
            console.error('❌ RAZORPAY_KEY_SECRET:', keySecret ? 'SET' : 'MISSING');
            console.error('❌ Please configure Razorpay keys in your .env or deployment environment');
            
            return res.status(500).json({ 
                success: false, 
                message: 'Razorpay keys not configured',
                error: 'RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing in environment',
                hint: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env or deployment platform'
            });
        }

        const razorpay = new Razorpay({
            key_id: keyId,
            key_secret: keySecret
        });

        const options = {
            amount: Math.round(amount * 100), // Convert to paise
            currency: currency,
            receipt: (receipt || `receipt_${Date.now()}`).substring(0, 40),
            notes: notes || {}
        };

        razorpay.orders.create(options, (err, order) => {
            if (err) {
                console.error('❌ Razorpay order creation error:', err);
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to create order',
                    error: err.message 
                });
            }
            
            console.log('✅ Razorpay order created:', order.id);
            res.json({ 
                success: true, 
                orderId: order.id,
                amount: order.amount,
                currency: order.currency
            });
        });
    } catch (error) {
        console.error('❌ Error creating Razorpay order:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error',
            error: error.message 
        });
    }
});

// ================== BOOKING REQUEST ROUTES ==================

// Create booking request or bid (new unified endpoint)
router.post('/create', formLimiter, bookingController.createBookingRequest);

// Create bulk booking request (for filtered properties)
router.post('/bulk-create', formLimiter, bookingController.createBulkBookingRequest);

// Create booking request or bid (legacy)
router.post('/requests', formLimiter, bookingController.createBookingRequest);

const { protect } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');

// Get all booking requests (filtered by area, request_type, status)
router.get('/', protect, applyEmployeeScope, bookingController.getBookingRequests);
router.get('/requests', protect, applyEmployeeScope, bookingController.getBookingRequests);

// Get user bookings (tenant's mystays page) - MUST BE BEFORE /requests/:id route
router.get('/user/:userId', bookingController.getUserBookings);

// Confirm booking from booking form (save all tenant data) - MUST BE BEFORE /requests/:id route
router.post('/confirm', bookingController.confirmBooking);

// Confirm payment from payment page (update booking request status and add payment transaction)
router.post('/payment/confirm', bookingController.confirmPayment);

// ================== REFUND REQUEST ROUTES (BEFORE generic /:id route) ==================

// Create refund request (user submits refund/alternative property request)
router.post('/refund-request', bookingController.createRefundRequest);

// Create public support ticket (from Contact Us page)
router.post('/contact-submit', async (req, res) => {
    try {
        const SupportTicket = require('../models/SupportTicket');
        const { name, email, subject, message } = req.body;
        
        if (!name || !email || !subject || !message) {
            return res.status(400).json({
                success: false,
                message: 'All fields (name, email, subject, message) are required'
            });
        }
        
        const ticket = new SupportTicket({
            ticket_type: 'Other',
            raised_by: 'website_user',
            raised_by_name: name,
            raised_by_role: 'website_user',
            user_email: email,
            subject: subject,
            description: message,
            status: 'Open',
            priority: 'Medium',
            created_at: new Date(),
            updated_at: new Date()
        });
        
        await ticket.save();
        
        res.status(201).json({
            success: true,
            message: 'Your message has been submitted successfully',
            data: ticket
        });
    } catch (error) {
        console.error('Error submitting contact form:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit message: ' + error.message
        });
    }
});

// Get all refund requests (for superadmin dashboard) - MUST BE BEFORE /refund-request/:id
router.get('/refund-requests', bookingController.getAllRefundRequests);

// Get refund request by ID
router.get('/refund-request/:id', bookingController.getRefundRequestById);

// Create Razorpay order for refund
router.post('/refund-request/:id/create-order', bookingController.createRefundOrder);

// Process refund (admin approves and refunds money)
router.post('/refund-request/:id/process', bookingController.processRefund);

// Process refund with Razorpay payment
router.post('/refund-request/:id/process-payment', bookingController.processRefundPayment);

// Update refund request status
router.put('/refund-request/:id/status', bookingController.updateRefundRequestStatus);

// ================== PROPERTY HOLD ROUTES ==================

// Check if property is on hold
router.get('/hold/:property_id', bookingController.checkPropertyHold);

// Release property hold
router.put('/hold/:property_id/release', bookingController.releasePropertyHold);

// Generic booking update endpoint (for frontend compatibility)
router.put('/update', bookingController.updateBookingStatus);

// Get booking request by ID (supports both /bookings/:id and /booking/requests/:id paths) - MUST BE LAST
router.get('/:id', bookingController.getBookingRequestById);
router.get('/requests/:id', bookingController.getBookingRequestById);

// Update booking status (approve, reject, or schedule visit)
router.put('/requests/:id/status', bookingController.updateBookingStatus);

// Approve booking
router.put('/requests/:id/approve', bookingController.approveBooking);

// Reject booking
router.put('/requests/:id/reject', bookingController.rejectBooking);

// Schedule visit
router.post('/requests/:id/schedule-visit', bookingController.scheduleVisit);

// Delete booking
router.delete('/requests/:id', bookingController.deleteBooking);

// Update chat decision (like/reject)
router.put('/requests/:id/decision', bookingController.updateChatDecision);

// Bulk approve booking requests
router.put('/requests/bulk-approve', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, message: 'ids[] required' });
        const Booking = require('../models/Booking');
        const result = await Booking.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { status: 'approved', updatedAt: new Date() } });
        res.json({ success: true, modified: result.modifiedCount, message: `${result.modifiedCount} bookings approved` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Bulk reject booking requests
router.put('/requests/bulk-reject', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, message: 'ids[] required' });
        const Booking = require('../models/Booking');
        const result = await Booking.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { status: 'rejected', updatedAt: new Date() } });
        res.json({ success: true, modified: result.modifiedCount, message: `${result.modifiedCount} bookings rejected` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Register bid requirement for no-match scenario (saves requirement for future auto-matching)
router.post('/register-requirement', async (req, res) => {
    try {
        const {
            user_id, name, email, phone,
            city, area, gender, budget_min, budget_max,
            bid_amount, message
        } = req.body;

        if (!user_id || !name) {
            return res.status(400).json({ success: false, message: 'user_id and name are required' });
        }

        const BookingRequest = require('../models/BookingRequest');
        const Notification = require('../models/Notification');
        const mailer = require('../utils/mailer');

        // Use a system-level property placeholder so the bid is stored
        const requirement = new BookingRequest({
            property_id: `req_${city || 'any'}_${area || 'any'}_${Date.now()}`,
            property_name: `Requirement — ${area || city || 'Any Area'}`,
            area: area || city || 'Any',
            city: city || null,
            property_type: 'PG/Hostel',
            rent_amount: budget_max || bid_amount || 0,
            user_id,
            name,
            email: email || '',
            phone: phone || null,
            owner_id: 'SYSTEM',
            request_type: 'bid',
            bid_amount: Number(budget_max || bid_amount || 0),
            bid_min: Number(budget_min || 0) || null,
            bid_max: Number(budget_max || 0) || null,
            match_category: 'no_match_active',
            filter_criteria: { city, area, gender, min_price: budget_min, max_price: budget_max },
            message: message || `Budget: ₹${budget_min || 0}–₹${budget_max || 0}/month | Gender: ${gender || 'Any'} | Area: ${area || city || 'Any'}`,
            status: 'pending',
            is_expired: false
        });

        await requirement.save();

        // In-app notification confirming requirement registered
        const bidAmt = Number(budget_max || bid_amount || 0);
        const notifTitle = '📌 Requirement Registered — Auto-Matching Active!';
        const notifMsg = `Your budget requirement of ₹${bidAmt.toLocaleString('en-IN')}/month for ${area || city || 'any area'} has been registered as ACTIVE. You will be automatically notified via Push, Email & WhatsApp when a suitable property is listed!`;

        await Notification.create({
            toRole: 'website_user',
            toLoginId: user_id,
            from: 'Roomhy Auto-Match',
            type: 'requirement_registered',
            meta: {
                title: notifTitle,
                message: notifMsg,
                requirementId: String(requirement._id || ''),
                bidAmount: bidAmt,
                city, area,
                matchCategory: 'no_match_active',
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            },
            read: false
        }).catch(() => {});

        // Email confirmation
        if (email && !email.includes('roomhy.com')) {
            const html = `
                <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <div style="background:#0FA596;color:#fff;padding:20px;text-align:center;">
                        <h2 style="margin:0;font-size:20px;">📌 ${notifTitle}</h2>
                    </div>
                    <div style="padding:24px;color:#1e293b;line-height:1.6;">
                        <p>Hi <strong>${name}</strong>,</p>
                        <p>${notifMsg}</p>
                        <div style="background:#f8fafc;padding:16px;border-radius:8px;border-left:4px solid #0FA596;margin:16px 0;">
                            <p style="margin:4px 0;"><strong>Budget:</strong> ₹${Number(budget_min||0).toLocaleString('en-IN')} – ₹${bidAmt.toLocaleString('en-IN')}/month</p>
                            <p style="margin:4px 0;"><strong>Area:</strong> ${area || 'Any'}, ${city || 'Any City'}</p>
                            <p style="margin:4px 0;"><strong>Gender:</strong> ${gender || 'Any'}</p>
                            <p style="margin:4px 0;"><strong>Status:</strong> ACTIVE (Auto-Matching ON)</p>
                        </div>
                        <p>We'll notify you the moment a matching property is listed on Roomhy!</p>
                    </div>
                </div>
            `;
            mailer.sendMail(email, `📌 Requirement Registered | Roomhy`, notifMsg, html).catch(() => {});
        }

        res.status(201).json({
            success: true,
            message: 'Requirement registered. You will be notified when a matching property is available.',
            matchCategory: 'no_match_active',
            requirementId: String(requirement._id || ''),
            data: requirement
        });
    } catch (err) {
        console.error('Error registering requirement:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
