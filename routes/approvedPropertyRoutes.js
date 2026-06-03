const express = require('express');
const router = express.Router();
const ApprovedProperty = require('../models/ApprovedProperty');

// ============================================================
// GET: Get all approved properties
// ============================================================
router.get('/all', async (req, res) => {
    try {
        const properties = await ApprovedProperty.find({}).sort({ approvedAt: -1 });
        res.json({
            success: true,
            count: properties.length,
            properties: properties
        });
    } catch (error) {
        console.error('Error fetching approved properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching approved properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get public approved properties (for website visitors)
// ============================================================
router.get('/public/approved', async (req, res) => {
    try {
        const properties = await ApprovedProperty.find({ 
            status: 'approved',
            isLiveOnWebsite: true
        }).sort({ approvedAt: -1 });
        
        console.log('📋 [approved-properties/public/approved] Fetched', properties.length, 'live properties');
        
        res.json({
            success: true,
            count: properties.length,
            properties: properties,
            visits: properties  // Alias for compatibility
        });
    } catch (error) {
        console.error('Error fetching public approved properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching approved properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get properties for website (isLiveOnWebsite = true)
// ============================================================
router.get('/website/live', async (req, res) => {
    try {
        const properties = await ApprovedProperty.find({ 
            isLiveOnWebsite: true 
        }).sort({ approvedAt: -1 });
        
        res.json({
            success: true,
            count: properties.length,
            properties: properties
        });
    } catch (error) {
        console.error('Error fetching website properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching website properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get properties for ourproperty (isLiveOnOurProperty = true)
// ============================================================
router.get('/ourproperty/live', async (req, res) => {
    try {
        const properties = await ApprovedProperty.find({ 
            isLiveOnOurProperty: true 
        }).sort({ approvedAt: -1 });
        
        res.json({
            success: true,
            count: properties.length,
            properties: properties
        });
    } catch (error) {
        console.error('Error fetching ourproperty properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching ourproperty properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get properties by city
// ============================================================
router.get('/city/:city', async (req, res) => {
    try {
        const properties = await ApprovedProperty.find({ 
            city: req.params.city,
            isLiveOnWebsite: true
        }).sort({ approvedAt: -1 });
        
        res.json({
            success: true,
            count: properties.length,
            properties: properties
        });
    } catch (error) {
        console.error('Error fetching properties by city:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching properties by city',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get a single approved property
// ============================================================
router.get('/:propertyId', async (req, res) => {
    try {
        const property = await ApprovedProperty.findOne({ 
            propertyId: req.params.propertyId 
        });
        
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        res.json({
            success: true,
            property: property
        });
    } catch (error) {
        console.error('Error fetching property:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching property',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Toggle property visibility on website
// ============================================================
router.put('/:propertyId/toggle-website', async (req, res) => {
    try {
        const property = await ApprovedProperty.findOne({ 
            propertyId: req.params.propertyId 
        });
        
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        property.isLiveOnWebsite = !property.isLiveOnWebsite;
        await property.save();

        res.json({
            success: true,
            message: `Property visibility on website toggled to ${property.isLiveOnWebsite}`,
            property: property
        });
    } catch (error) {
        console.error('Error toggling website visibility:', error);
        res.status(500).json({
            success: false,
            message: 'Error toggling website visibility',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Toggle property visibility on ourproperty
// ============================================================
router.put('/:propertyId/toggle-ourproperty', async (req, res) => {
    try {
        const property = await ApprovedProperty.findOne({ 
            propertyId: req.params.propertyId 
        });
        
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        property.isLiveOnOurProperty = !property.isLiveOnOurProperty;
        await property.save();

        res.json({
            success: true,
            message: `Property visibility on ourproperty toggled to ${property.isLiveOnOurProperty}`,
            property: property
        });
    } catch (error) {
        console.error('Error toggling ourproperty visibility:', error);
        res.status(500).json({
            success: false,
            message: 'Error toggling ourproperty visibility',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Update property details
// ============================================================
router.put('/:propertyId', async (req, res) => {
    try {
        const property = await ApprovedProperty.findOneAndUpdate(
            { propertyId: req.params.propertyId },
            req.body,
            { new: true }
        );
        
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        res.json({
            success: true,
            message: 'Property updated successfully',
            property: property
        });
    } catch (error) {
        console.error('Error updating property:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating property',
            error: error.message
        });
    }
});

// ============================================================
// DELETE: Delete an approved property
// ============================================================
router.delete('/:propertyId', async (req, res) => {
    try {
        const property = await ApprovedProperty.findOneAndDelete({ 
            propertyId: req.params.propertyId 
        });
        
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        res.json({
            success: true,
            message: 'Property deleted successfully',
            property: property
        });
    } catch (error) {
        console.error('Error deleting property:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting property',
            error: error.message
        });
    }
});

module.exports = router;
