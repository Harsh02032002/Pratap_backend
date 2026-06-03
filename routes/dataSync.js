const express = require('express');
const router = express.Router();
const BookingRequest = require('../models/BookingRequest');
const KYCVerification = require('../models/KYCVerification');

// ========== BOOKING REQUEST ENDPOINTS ==========

// Get all booking requests
router.get('/booking-requests', async (req, res) => {
    try {
        const { area, status, user_id, email, area_manager_id } = req.query;
        
        let filter = {};
        if (area) filter.area = area;
        if (status) filter.status = status;
        if (user_id) filter.user_id = user_id;
        if (email) filter.email = email;
        if (area_manager_id) filter.area_manager_id = area_manager_id;
        
        const requests = await BookingRequest.find(filter)
            .sort({ created_at: -1 })
            .limit(100);
        
        res.json(requests);
    } catch (error) {
        console.error('Error fetching booking requests:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single booking request
router.get('/booking-requests/:id', async (req, res) => {
    try {
        const request = await BookingRequest.findById(req.params.id);
        if (!request) {
            return res.status(404).json({ error: 'Booking request not found' });
        }
        res.json(request);
    } catch (error) {
        console.error('Error fetching booking request:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create new booking request
router.post('/booking-requests', async (req, res) => {
    try {
        const bookingRequest = new BookingRequest(req.body);
        await bookingRequest.save();
        res.status(201).json(bookingRequest);
    } catch (error) {
        console.error('Error creating booking request:', error);
        res.status(400).json({ error: error.message });
    }
});

// Update booking request
router.put('/booking-requests/:id', async (req, res) => {
    try {
        const bookingRequest = await BookingRequest.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        if (!bookingRequest) {
            return res.status(404).json({ error: 'Booking request not found' });
        }
        res.json(bookingRequest);
    } catch (error) {
        console.error('Error updating booking request:', error);
        res.status(400).json({ error: error.message });
    }
});

// Delete booking request
router.delete('/booking-requests/:id', async (req, res) => {
    try {
        const bookingRequest = await BookingRequest.findByIdAndDelete(req.params.id);
        if (!bookingRequest) {
            return res.status(404).json({ error: 'Booking request not found' });
        }
        res.json({ message: 'Booking request deleted successfully' });
    } catch (error) {
        console.error('Error deleting booking request:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sync booking requests from localStorage (bulk insert/update)
router.post('/booking-requests/sync', async (req, res) => {
    try {
        const { bookingRequests } = req.body;
        
        if (!Array.isArray(bookingRequests)) {
            return res.status(400).json({ error: 'bookingRequests must be an array' });
        }
        
        const results = [];
        
        for (const request of bookingRequests) {
            try {
                // Upsert: Update if exists, create if not
                const result = await BookingRequest.findOneAndUpdate(
                    { property_id: request.property_id, user_id: request.user_id },
                    request,
                    { new: true, upsert: true }
                );
                results.push({ success: true, id: result._id });
            } catch (err) {
                results.push({ success: false, error: err.message, data: request });
            }
        }
        
        res.json({
            message: 'Sync completed',
            total: bookingRequests.length,
            results
        });
    } catch (error) {
        console.error('Error syncing booking requests:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== KYC VERIFICATION ENDPOINTS ==========

// Get all KYC records
router.get('/kyc-verifications', async (req, res) => {
    try {
        const { status, kycStatus, area } = req.query;
        
        let filter = {};
        if (status) filter.status = status;
        if (kycStatus) filter.kycStatus = kycStatus;
        if (area) filter.area = area;
        
        const records = await KYCVerification.find(filter)
            .select('-password')
            .sort({ createdAt: -1 })
            .limit(100);
        
        res.json(records);
    } catch (error) {
        console.error('Error fetching KYC records:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single KYC record
router.get('/kyc-verifications/:id', async (req, res) => {
    try {
        const record = await KYCVerification.findById(req.params.id).select('-password');
        if (!record) {
            return res.status(404).json({ error: 'KYC record not found' });
        }
        res.json(record);
    } catch (error) {
        console.error('Error fetching KYC record:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create new KYC record
router.post('/kyc-verifications', async (req, res) => {
    try {
        const kycRecord = new KYCVerification(req.body);
        await kycRecord.save();
        res.status(201).json({
            ...kycRecord.toObject(),
            password: '***' // Don't return password
        });
    } catch (error) {
        console.error('Error creating KYC record:', error);
        res.status(400).json({ error: error.message });
    }
});

// Update KYC record
router.put('/kyc-verifications/:id', async (req, res) => {
    try {
        const kycRecord = await KYCVerification.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        ).select('-password');
        
        if (!kycRecord) {
            return res.status(404).json({ error: 'KYC record not found' });
        }
        res.json(kycRecord);
    } catch (error) {
        console.error('Error updating KYC record:', error);
        res.status(400).json({ error: error.message });
    }
});

// Delete KYC record
router.delete('/kyc-verifications/:id', async (req, res) => {
    try {
        const kycRecord = await KYCVerification.findByIdAndDelete(req.params.id);
        if (!kycRecord) {
            return res.status(404).json({ error: 'KYC record not found' });
        }
        res.json({ message: 'KYC record deleted successfully' });
    } catch (error) {
        console.error('Error deleting KYC record:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sync KYC records from localStorage (bulk insert/update)
router.post('/kyc-verifications/sync', async (req, res) => {
    try {
        const { kycRecords } = req.body;
        
        if (!Array.isArray(kycRecords)) {
            return res.status(400).json({ error: 'kycRecords must be an array' });
        }
        
        const results = [];
        
        for (const record of kycRecords) {
            try {
                // Upsert: Update if exists, create if not
                const result = await KYCVerification.findOneAndUpdate(
                    { email: record.email },
                    record,
                    { new: true, upsert: true }
                );
                results.push({ success: true, id: result._id, email: record.email });
            } catch (err) {
                results.push({ success: false, error: err.message, email: record.email });
            }
        }
        
        res.json({
            message: 'KYC Sync completed',
            total: kycRecords.length,
            results
        });
    } catch (error) {
        console.error('Error syncing KYC records:', error);
        res.status(500).json({ error: error.message });
    }
});

// Verify KYC (approve/reject)
router.post('/kyc-verifications/:id/verify', async (req, res) => {
    try {
        const { kycStatus, verificationNotes } = req.body;
        
        const kycRecord = await KYCVerification.findByIdAndUpdate(
            req.params.id,
            {
                kycStatus,
                verificationNotes,
                verifiedAt: new Date(),
                status: kycStatus === 'verified' ? 'active' : 'inactive'
            },
            { new: true }
        ).select('-password');
        
        if (!kycRecord) {
            return res.status(404).json({ error: 'KYC record not found' });
        }
        
        res.json(kycRecord);
    } catch (error) {
        console.error('Error verifying KYC:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== BULK SYNC ENDPOINT ==========

// Sync both booking requests and KYC records at once
router.post('/sync-all', async (req, res) => {
    try {
        const { bookingRequests = [], kycRecords = [] } = req.body;
        
        const results = {
            bookingRequests: { total: 0, synced: 0, failed: 0 },
            kycRecords: { total: 0, synced: 0, failed: 0 }
        };
        
        // Sync booking requests
        results.bookingRequests.total = bookingRequests.length;
        for (const request of bookingRequests) {
            try {
                await BookingRequest.findOneAndUpdate(
                    { property_id: request.property_id, user_id: request.user_id },
                    request,
                    { new: true, upsert: true }
                );
                results.bookingRequests.synced++;
            } catch (err) {
                console.error('Error syncing booking request:', err);
                results.bookingRequests.failed++;
            }
        }
        
        // Sync KYC records
        results.kycRecords.total = kycRecords.length;
        for (const record of kycRecords) {
            try {
                await KYCVerification.findOneAndUpdate(
                    { email: record.email },
                    record,
                    { new: true, upsert: true }
                );
                results.kycRecords.synced++;
            } catch (err) {
                console.error('Error syncing KYC record:', err);
                results.kycRecords.failed++;
            }
        }
        
        res.json({
            message: 'All data synced to MongoDB Atlas',
            timestamp: new Date(),
            results
        });
    } catch (error) {
        console.error('Error in bulk sync:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
