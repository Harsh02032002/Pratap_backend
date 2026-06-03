const VisitReport = require('../models/VisitReport');
const Notification = require('../models/Notification');
const User = require('../models/user');

// 1. Submit a visit report (Area Manager)
exports.submitVisit = async (req, res) => {
    try {
        const { name, address, locationCode, contactPhone, notes } = req.body;
        
        // Use authenticated user ID if available
        const areaManagerId = req.user ? req.user._id : (req.body.areaManager || null);

        if (!areaManagerId) {
             return res.status(401).json({ success: false, message: 'Unauthorized: Area Manager ID required' });
        }

        const report = await VisitReport.create({
            areaManager: areaManagerId,
            propertyInfo: { name, address, locationCode, contactPhone },
            notes,
            submittedToAdmin: true, 
            status: 'submitted',
            submittedAt: new Date()
        });

        return res.status(201).json({ success: true, report });
    } catch (err) {
        console.error("Submit Visit Error:", err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

// 2. Get Pending Visits (Super Admin)
exports.getPendingVisits = async (req, res) => {
    try {
        const visits = await VisitReport.find({ status: 'submitted' })
            .populate('areaManager', 'name email') 
            .sort({ submittedAt: 1 })
            .lean();
        res.json({ success: true, visits });
    } catch (err) {
        console.error("Pending Visits Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// 3. Get My Reports (Area Manager)
exports.getMyVisits = async (req, res) => {
    try {
        // If auth middleware is used, req.user is set
        const visits = await VisitReport.find({ areaManager: req.user._id }).sort({ submittedAt: -1 });
        res.json({ success: true, visits });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Public fallbacks (for demo without auth middleware)
exports.submitVisitPublic = async (req, res) => {
    // Logic for demo submission without strict auth
    // ... (Implementation same as standard submit but relaxed checks)
    res.json({ success: true, message: "Demo submission received" }); 
};

// 4. Get Approved Properties for Website (Public Endpoint)
// Used by ourproperty.html to fetch live properties from database
exports.getApprovedPropertiesForWebsite = async (req, res) => {
    try {
        // Optional query parameters for filtering
        const { city, area, gender, propertyType, minPrice, maxPrice, occupancy, search } = req.query;
        
        // Build filter object
        let filter = {
            status: 'approved',
            isLiveOnWebsite: true
        };

        // Apply optional filters
        if (city) {
            filter['propertyInfo.city'] = { $regex: city, $options: 'i' }; // Case-insensitive
        }
        
        if (area) {
            filter['propertyInfo.area'] = area;
        }
        
        if (gender) {
            // Match specific gender or co-ed
            if (gender.toLowerCase() === 'co-ed') {
                filter['propertyInfo.gender'] = 'co-ed';
            } else {
                filter['propertyInfo.gender'] = { $in: [gender, 'co-ed'] };
            }
        }
        
        if (propertyType) {
            filter['propertyInfo.propertyType'] = { $regex: propertyType, $options: 'i' };
        }
        
        if (occupancy) {
            filter['roomInfo.occupancy'] = occupancy;
        }
        
        // Price range filtering
        if (minPrice || maxPrice) {
            filter.monthlyRent = {};
            if (minPrice) {
                filter.monthlyRent.$gte = parseInt(minPrice);
            }
            if (maxPrice && maxPrice !== '50000_plus') {
                filter.monthlyRent.$lte = parseInt(maxPrice);
            }
        }
        
        // Text search in property name or area
        if (search) {
            filter.$or = [
                { 'propertyInfo.name': { $regex: search, $options: 'i' } },
                { 'propertyInfo.area': { $regex: search, $options: 'i' } },
                { 'propertyInfo.city': { $regex: search, $options: 'i' } }
            ];
        }

        // Fetch properties from database
        const properties = await VisitReport.find(filter)
            .select('_id propertyInfo roomInfo monthlyRent rent rating reviewsCount isVerified photos professionalPhotos')
            .sort({ createdAt: -1 })
            .lean();

        // Transform data to match frontend expectations
        const transformedProperties = properties.map(prop => ({
            _id: prop._id,
            propertyInfo: prop.propertyInfo,
            roomInfo: prop.roomInfo,
            monthlyRent: prop.monthlyRent || prop.rent || 0,
            rent: prop.rent || prop.monthlyRent || 0,
            rating: prop.rating || 4.5,
            reviewsCount: prop.reviewsCount || 0,
            isVerified: prop.isVerified || false,
            photos: prop.professionalPhotos || prop.photos || [],
            status: 'approved',
            isLiveOnWebsite: true
        }));

        res.json({ 
            success: true, 
            count: transformedProperties.length,
            properties: transformedProperties 
        });

    } catch (err) {
        console.error("Get Approved Properties Error:", err);
        res.status(500).json({ 
            success: false, 
            message: 'Error fetching properties',
            error: err.message 
        });
    }
};