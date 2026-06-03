const express = require('express');
const router = express.Router();
const PropertyEnquiry = require('../models/PropertyEnquiry');

// GET /api/property-enquiries
router.get('/', async (req, res) => {
    try {
        const enquiries = await PropertyEnquiry.find().sort({ submittedAt: -1 });
        res.status(200).json({
            success: true,
            enquiries
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/property-enquiries
router.post('/', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload.enquiryId) {
            payload.enquiryId = `enq_${Date.now()}`;
        }
        
        // Upsert behavior: delete existing if any to avoid duplicates
        await PropertyEnquiry.findOneAndDelete({ enquiryId: payload.enquiryId });

        const enquiry = new PropertyEnquiry(payload);
        await enquiry.save();
        
        res.status(201).json({
            success: true,
            enquiry
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// PUT /api/property-enquiries/:enquiryId
router.put('/:enquiryId', async (req, res) => {
    try {
        const { enquiryId } = req.params;
        const updateData = req.body;

        const enquiry = await PropertyEnquiry.findOneAndUpdate(
            { enquiryId },
            { $set: updateData },
            { new: true }
        );

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        res.status(200).json({
            success: true,
            enquiry
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
