const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const propertyController = require('../controllers/propertyController');
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const { protect, optionalProtect, authorize } = require('../middleware/authMiddleware');
const { auditTrail } = require('../middleware/auditTrail');
const { formLimiter } = require('../middleware/security');

const { applyEmployeeScope } = require('../middleware/employeeScope');
const { requirePropertyInScope } = require('../utils/scopeHelpers');

// Get All Properties (Scoped for employees, public for website)
router.get('/', applyEmployeeScope, propertyController.getAllProperties);

// Add/Create new property with auto-geocoding
router.post('/add', optionalProtect, formLimiter, auditTrail('properties'), propertyController.addProperty);

// Get single property by ID (Scoped for employees, public for website)
router.get('/:id', optionalProtect, applyEmployeeScope, requirePropertyInScope('id'), propertyController.getPropertyById);

// Update property with new fields (amenities, benefits, views).
// Superadmin-only: this is the route that sets/clears status: 'blocked', so it
// must never be reachable by an owner — they go through /owner-edit-request
// below instead, which is reviewed before anything goes live.
router.put('/:id', protect, authorize('superadmin'), formLimiter, auditTrail('properties'), propertyController.updateProperty);

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
                isPublished: true,
                isLiveOnWebsite: true
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

// Owner submits edit request (saved as pendingChanges, not applied live).
// Ownership and blocked-status are enforced inside the controller, since it
// needs to compare req.user against the specific property being edited.
router.put('/:id/owner-edit-request', protect, formLimiter, propertyController.ownerEditRequest);

// Superadmin approves owner pending changes (applies to live property)
router.put('/:id/approve-changes', formLimiter, auditTrail('properties'), propertyController.approveOwnerChanges);

// Superadmin rejects owner pending changes
router.put('/:id/reject-changes', formLimiter, auditTrail('properties'), propertyController.rejectOwnerChanges);

// Superadmin assigns verification task to employee
router.put('/:id/assign-verification', protect, authorize('superadmin'), propertyController.assignPropertyVerification);

// ─── Toggle Website Visibility ────────────────────────────────────────────────
// PUT /api/properties/:id/toggle-website
// Works with MongoDB _id. Updates both Property and ApprovedProperty models.
router.put('/:id/toggle-website', protect, authorize('superadmin'), async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ success: false, message: 'Invalid property ID' });
        }

        const property = await Property.findById(id);
        if (!property) {
            return res.status(404).json({ success: false, message: 'Property not found' });
        }

        const newValue = !property.isLiveOnWebsite;
        property.isLiveOnWebsite = newValue;
        property.status = newValue ? 'active' : 'inactive';
        await property.save();

        // Build search conditions for ApprovedProperty
        const apOrConditions = [
            { _id: isValidObjectId(id) ? id : null },
            { propertyId: id },
            { visitId: property.visitId || id }
        ].filter(cond => Object.values(cond)[0]);

        if (property.propertyId) {
            apOrConditions.push({ propertyId: property.propertyId });
        }
        if (property.ownerLoginId) {
            apOrConditions.push({ 'generatedCredentials.loginId': property.ownerLoginId });
        }

        if (apOrConditions.length > 0) {
            await ApprovedProperty.updateMany(
                { $or: apOrConditions },
                {
                    $set: {
                        isLiveOnWebsite: newValue,
                        status: newValue ? 'approved' : 'inactive'
                    }
                }
            );
        }

        // Clear backend cache so public website endpoints update immediately
        try {
            const { clearCache } = require('../middleware/apiCache');
            clearCache('/api/approved-properties');
            clearCache('/api/properties');
        } catch (e) {
            console.warn('Cache clear error:', e.message);
        }

        console.log(`🌐 [toggle-website] Property ${id} (${property.title}) → isLiveOnWebsite: ${newValue}`);
        res.json({
            success: true,
            message: `Property is now ${newValue ? 'LIVE on website ✅' : 'taken OFFLINE 🔴'}`,
            isLiveOnWebsite: newValue
        });
    } catch (error) {
        console.error('Error toggling website visibility:', error);
        res.status(500).json({ success: false, message: 'Error toggling website visibility' });
    }
});


module.exports = router;
