const express = require('express');
const router = express.Router();
const WebsitePropertyData = require('../models/WebsitePropertyData');

// ============================================================
// POST: Save website property data
// ============================================================
router.post('/save', async (req, res) => {
    try {
        const {
            propertyId,
            propertyInfo,
            gender,
            status,
            isLiveOnWebsite,
            photos,
            professionalPhotos,
            websiteBannerPhoto,
            monthlyRent,
            notes
        } = req.body;

        if (!propertyId || !propertyInfo) {
            return res.status(400).json({
                success: false,
                message: 'propertyId and propertyInfo are required'
            });
        }

        // Find and update or create
        let propertyData = await WebsitePropertyData.findOneAndUpdate(
            { propertyId },
            {
                propertyId,
                propertyInfo,
                gender,
                status,
                isLiveOnWebsite,
                photos: photos || [],
                professionalPhotos: professionalPhotos || [],
                websiteBannerPhoto,
                monthlyRent,
                notes,
                submittedAt: new Date()
            },
            { upsert: true, new: true }
        );

        res.status(201).json({
            success: true,
            message: 'Property data saved successfully',
            data: propertyData
        });

    } catch (error) {
        console.error('Error saving property data:', error);
        res.status(500).json({
            success: false,
            message: 'Error saving property data',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get all website properties
// ============================================================
router.get('/all', async (req, res) => {
    try {
        // Get total count first
        const totalCount = await WebsitePropertyData.countDocuments({});
        const properties = await WebsitePropertyData.find({}).sort({ createdAt: -1 });
        res.json({
            success: true,
            count: properties.length,
            total: totalCount,
            properties: properties,
            message: `${totalCount} properties found`
        });
    } catch (error) {
        console.error('Error fetching properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get approved properties only
// ============================================================
router.get('/approved', async (req, res) => {
    try {
        const totalCount = await WebsitePropertyData.countDocuments({ status: 'approved' });
        const properties = await WebsitePropertyData.find({ status: 'approved' }).sort({ createdAt: -1 });
        res.json({
            success: true,
            count: properties.length,
            total: totalCount,
            properties: properties,
            message: `${totalCount} approved properties found`
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
// GET: Get live (online) properties
// ============================================================
router.get('/live', async (req, res) => {
    try {
        const totalCount = await WebsitePropertyData.countDocuments({ 
            status: 'approved',
            isLiveOnWebsite: true 
        });
        const properties = await WebsitePropertyData.find({ 
            status: 'approved',
            isLiveOnWebsite: true 
        }).sort({ createdAt: -1 });
        res.json({
            success: true,
            count: properties.length,
            total: totalCount,
            properties: properties,
            message: `${totalCount} live properties found`
        });
    } catch (error) {
        console.error('Error fetching live properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching live properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get offline properties
// ============================================================
router.get('/offline', async (req, res) => {
    try {
        const properties = await WebsitePropertyData.find({ 
            status: 'approved',
            isLiveOnWebsite: false 
        }).sort({ createdAt: -1 });
        res.json({
            success: true,
            count: properties.length,
            properties: properties
        });
    } catch (error) {
        console.error('Error fetching offline properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching offline properties',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get a single property by ID
// ============================================================
router.get('/:propertyId', async (req, res) => {
    try {
        const property = await WebsitePropertyData.findOne({ propertyId: req.params.propertyId });
        
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
// PUT: Update property status
// ============================================================
router.put('/:propertyId/status', async (req, res) => {
    try {
        const { status } = req.body;
        
        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'status is required'
            });
        }

        const property = await WebsitePropertyData.findOneAndUpdate(
            { propertyId: req.params.propertyId },
            { status, updatedAt: new Date() },
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
            message: 'Property status updated',
            property: property
        });
    } catch (error) {
        console.error('Error updating property status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating property status',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Toggle live status (online/offline)
// ============================================================
router.put('/:propertyId/toggle-live', async (req, res) => {
    try {
        const property = await WebsitePropertyData.findOne({ propertyId: req.params.propertyId });
        
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        property.isLiveOnWebsite = !property.isLiveOnWebsite;
        property.updatedAt = new Date();
        await property.save();

        res.json({
            success: true,
            message: `Property is now ${property.isLiveOnWebsite ? 'ONLINE' : 'OFFLINE'}`,
            property: property
        });
    } catch (error) {
        console.error('Error toggling live status:', error);
        res.status(500).json({
            success: false,
            message: 'Error toggling live status',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Update website banner photo
// ============================================================
router.put('/banner/photo', async (req, res) => {
    try {
        const { websiteBannerPhoto } = req.body;
        
        if (!websiteBannerPhoto) {
            return res.status(400).json({
                success: false,
                message: 'websiteBannerPhoto URL is required'
            });
        }

        // Find or create a single banner record
        let banner = await WebsitePropertyData.findOne({ propertyId: 'website-banner' });
        
        if (!banner) {
            banner = new WebsitePropertyData({
                propertyId: 'website-banner',
                propertyInfo: { name: 'Website Banner' },
                websiteBannerPhoto
            });
        } else {
            banner.websiteBannerPhoto = websiteBannerPhoto;
            banner.updatedAt = new Date();
        }

        await banner.save();

        res.json({
            success: true,
            message: 'Website banner photo updated',
            banner: banner
        });
    } catch (error) {
        console.error('Error updating banner photo:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating banner photo',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get website banner photo
// ============================================================
router.get('/banner/photo', async (req, res) => {
    try {
        const banner = await WebsitePropertyData.findOne({ propertyId: 'website-banner' });
        
        res.json({
            success: true,
            photo: banner?.websiteBannerPhoto || null
        });
    } catch (error) {
        console.error('Error fetching banner photo:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching banner photo',
            error: error.message
        });
    }
});

// ============================================================
// DELETE: Delete a property
// ============================================================
router.delete('/:propertyId', async (req, res) => {
    try {
        const property = await WebsitePropertyData.findOneAndDelete({ propertyId: req.params.propertyId });
        
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

// ============================================================
// POST: Bulk save properties (migrate from localStorage)
// ============================================================
router.post('/bulk/save', async (req, res) => {
    try {
        const { properties } = req.body;
        
        if (!Array.isArray(properties)) {
            return res.status(400).json({
                success: false,
                message: 'properties must be an array'
            });
        }

        const results = [];
        
        for (const prop of properties) {
            const saved = await WebsitePropertyData.findOneAndUpdate(
                { propertyId: prop.propertyId || prop._id },
                {
                    propertyId: prop.propertyId || prop._id,
                    propertyInfo: prop.propertyInfo,
                    gender: prop.gender,
                    status: prop.status,
                    isLiveOnWebsite: prop.isLiveOnWebsite,
                    photos: prop.photos || [],
                    professionalPhotos: prop.professionalPhotos || [],
                    monthlyRent: prop.monthlyRent,
                    submittedAt: prop.submittedAt || new Date()
                },
                { upsert: true, new: true }
            );
            results.push(saved);
        }

        res.json({
            success: true,
            message: `${results.length} properties saved successfully`,
            saved: results.length,
            properties: results
        });

    } catch (error) {
        console.error('Error bulk saving properties:', error);
        res.status(500).json({
            success: false,
            message: 'Error bulk saving properties',
            error: error.message
        });
    }
});

module.exports = router;
