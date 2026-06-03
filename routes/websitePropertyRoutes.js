const express = require('express');
const router = express.Router();
const websitePropertyController = require('../controllers/websitePropertyController');

// Get all website properties (for admin)
router.get('/all', websitePropertyController.getAllWebsiteProperties);

// Get properties by status (online/offline)
router.get('/status/:status', websitePropertyController.getWebsitePropertiesByStatus);

// Get properties for public website (only online ones)
router.get('/public', websitePropertyController.getPublicWebsiteProperties);

// Search properties by filters (for fast bidding)
router.get('/search', (req, res) => {
    try {
        const { area, minPrice, maxPrice, gender } = req.query;
        
        // This would normally query the database
        // For now, returning sample data
        const sampleProperties = [
            {
                _id: '601',
                propertyNumber: 'PROP001',
                name: 'Cozy PG North',
                rentAmount: 8000,
                gender: 'female',
                propertyType: 'PG',
                area: area,
                city: 'unknown'
            },
            {
                _id: '602',
                propertyNumber: 'PROP002',
                name: 'Student Hostel Central',
                rentAmount: 6500,
                gender: 'male',
                propertyType: 'Hostel',
                area: area,
                city: 'unknown'
            },
            {
                _id: '603',
                propertyNumber: 'PROP003',
                name: 'Premium Shared Room',
                rentAmount: 9500,
                gender: 'co-ed',
                propertyType: 'Flat',
                area: area,
                city: 'unknown'
            }
        ];

        // Filter by price range
        let filtered = sampleProperties;
        if (minPrice && maxPrice) {
            filtered = filtered.filter(p => 
                p.rentAmount >= parseInt(minPrice) && p.rentAmount <= parseInt(maxPrice)
            );
        }

        res.json(filtered);
    } catch (error) {
        console.error('Error searching properties:', error);
        res.status(500).json({ error: 'Error searching properties' });
    }
});

// Add property to website
router.post('/add', websitePropertyController.addWebsiteProperty);

// Toggle property status
router.put('/toggle/:visitId', websitePropertyController.toggleWebsiteStatus);

// Delete property from website
router.delete('/delete/:visitId', websitePropertyController.deleteWebsiteProperty);

module.exports = router;