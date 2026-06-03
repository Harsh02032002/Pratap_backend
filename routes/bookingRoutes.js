const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');

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
router.post('/create', bookingController.createBookingRequest);

// Create bulk booking request (for filtered properties)
router.post('/bulk-create', bookingController.createBulkBookingRequest);

// Create booking request or bid (legacy)
router.post('/requests', bookingController.createBookingRequest);

// Get all booking requests (filtered by area, request_type, status)
router.get('/', bookingController.getBookingRequests);
router.get('/requests', bookingController.getBookingRequests);

// Get user bookings (tenant's mystays page) - MUST BE BEFORE /requests/:id route
router.get('/user/:userId', bookingController.getUserBookings);

// Confirm booking from booking form (save all tenant data) - MUST BE BEFORE /:id route
router.post('/confirm', bookingController.confirmBooking);

// ================== REFUND REQUEST ROUTES (BEFORE generic /:id route) ==================

// Create refund request (user submits refund/alternative property request)
router.post('/refund-request', bookingController.createRefundRequest);

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

module.exports = router;
