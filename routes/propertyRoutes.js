const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const propertyController = require('../controllers/propertyController');
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const { protect, authorize } = require('../middleware/authMiddleware');
const { auditTrail } = require('../middleware/auditTrail');
const { formLimiter } = require('../middleware/security');

// Get All Properties
// Made public for dashboard pages that don't send auth token consistently.
router.get('/', propertyController.getAllProperties);

// Add/Create new property with auto-geocoding
router.post('/add', formLimiter, auditTrail('properties'), propertyController.addProperty);

// Get single property by ID
router.get('/:id', propertyController.getPropertyById);

// Update property with new fields (amenities, benefits, views)
router.put('/:id', formLimiter, auditTrail('properties'), propertyController.updateProperty);

// Delete property
router.delete('/:id', auditTrail('properties'), propertyController.deleteProperty);

// Superadmin publishes property
router.post('/:id/publish', formLimiter, propertyController.publishProperty);

// Submit property enquiry (from list.html)
router.post('/property-enquiry/submit', formLimiter, auditTrail('properties'), propertyController.submitEnquiry);

// Ensure owner has a property and return it.
// This route is intentionally public because owner panel may not always send auth token.
router.post('/ensure-owner', formLimiter, auditTrail('properties'), async (req, res) => {
    try {
        const ownerLoginId = String(req.body.ownerLoginId || req.body.loginId || '').trim().toUpperCase();
        const title = String(req.body.title || req.body.propertyTitle || 'Owner Property').trim();
        const address = String(req.body.address || '').trim();
        const locationCode = String(
            req.body.locationCode ||
            req.body.area ||
            req.body.city ||
            ownerLoginId.slice(0, 3) ||
            'GEN'
        ).trim().toUpperCase();

        if (!ownerLoginId) {
            return res.status(400).json({ success: false, message: 'ownerLoginId is required' });
        }

        let property = await Property.findOne({ ownerLoginId }).sort({ createdAt: 1 });
        if (!property) {
            property = await Property.create({
                title: title || 'Owner Property',
                address,
                locationCode,
                ownerLoginId,
                status: 'active',
                isPublished: true
            });
        }

        return res.status(200).json({ success: true, property });
    } catch (err) {
        console.error('ensure-owner property error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Helper to check if string is valid ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Track view on property
router.post('/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const idParts = id.split('-');
    const locationPart = idParts.length > 1 ? idParts[1] : id;
    
    let query = { 
      $or: [
        { visitId: id }, 
        { locationCode: id },
        { locationCode: locationPart }
      ] 
    };
    
    if (isValidObjectId(id)) {
      query.$or.push({ _id: id });
    }
    
    console.log(`👁️ Backend: Tracking view for property ID: ${id}`);

    // 1. Update ApprovedProperty model
    const approved = await ApprovedProperty.findOneAndUpdate(
      query,
      { $inc: { views: 1 } },
      { new: true }
    );
    
    // 2. Update Property model (for Superadmin Dashboard)
    // If we found an approved property, try to link to the master Property via ownerLoginId
    let propertyUpdateQuery = { ...query };
    if (approved && approved.generatedCredentials?.loginId) {
      propertyUpdateQuery = { 
        $or: [
          ...query.$or,
          { ownerLoginId: approved.generatedCredentials.loginId }
        ] 
      };
    }

    const property = await Property.findOneAndUpdate(
      propertyUpdateQuery,
      { $inc: { views: 1 } },
      { new: true }
    );

    if (!property && !approved) {
      console.warn(`❌ Backend: Property not found for tracking view: ${id}`);
      return res.status(404).json({ success: false, message: 'Property not found' });
    }

    res.json({ 
      success: true, 
      views: (property?.views || approved?.views || 0)
    });
  } catch (error) {
    console.error('Error tracking view:', error);
    res.status(500).json({ success: false, message: 'Failed to track view' });
  }
});

// Track click on property
router.post('/:id/click', async (req, res) => {
  try {
    const { id } = req.params;
    const idParts = id.split('-');
    const locationPart = idParts.length > 1 ? idParts[1] : id;
    
    let query = { 
      $or: [
        { visitId: id }, 
        { locationCode: id },
        { locationCode: locationPart }
      ] 
    };
    
    if (isValidObjectId(id)) {
      query.$or.push({ _id: id });
    }

    console.log(`🖱️ Backend: Tracking click for property ID: ${id}`);

    // 1. Update ApprovedProperty model
    const approved = await ApprovedProperty.findOneAndUpdate(
      query,
      { $inc: { clicks: 1 } },
      { new: true }
    );
    
    // 2. Update Property model (for Superadmin Dashboard)
    let propertyUpdateQuery = { ...query };
    if (approved && approved.generatedCredentials?.loginId) {
      propertyUpdateQuery = { 
        $or: [
          ...query.$or,
          { ownerLoginId: approved.generatedCredentials.loginId }
        ] 
      };
    }

    const property = await Property.findOneAndUpdate(
      propertyUpdateQuery,
      { $inc: { clicks: 1 } },
      { new: true }
    );

    if (!property && !approved) {
      console.warn(`❌ Backend: Property not found for tracking click: ${id}`);
      return res.status(404).json({ success: false, message: 'Property not found' });
    }

    res.json({ 
      success: true, 
      clicks: (property?.clicks || approved?.clicks || 0)
    });
  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).json({ success: false, message: 'Failed to track click' });
  }
});

module.exports = router;
