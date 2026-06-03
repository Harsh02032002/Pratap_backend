const Property = require('../models/Property');
const Enquiry = require('../models/Enquiry');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const ApprovedProperty = require('../models/ApprovedProperty');
const { geocodeAddress } = require('../utils/geocode');
const { clearCache } = require('../middleware/apiCache');

const deriveLocationCode = (input = {}) => {
  const candidates = [
    input.locationCode,
    input.location_code,
    input.areaCode,
    input.area_code,
    input.locality,
    input.city
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (compact.length >= 3) return compact.slice(0, 12);
    if (compact.length > 0) return compact.padEnd(3, 'X');
  }

  return 'GEN';
};

// Helper: Sync Property to ApprovedProperty for website visibility
const syncToApprovedProperty = async (property) => {
    if (!property.isLiveOnWebsite || property.status !== 'active') return;
    try {
        const vId = property.visitId || property._id.toString();
        const approvedPropertyData = {
            visitId: vId,
            propertyId: property.propertyId || property._id.toString(),
            enquiry_id: property.enquiry_id || property._id.toString(),
            propertyCategory: property.propertyCategory || "",
            state: property.state || "",
            pincode: property.pincode || "",
            landmark: property.landmark || "",
            contact: property.contact || {},
            videoUrl: property.videoUrl || "",
            images: property.images || [],
            featuredImage: property.featuredImage || (property.images && property.images[0]) || "",
            propertyInfo: {
                name: property.title || 'Property',
                city: property.city || 'Unknown',
                area: property.locality || property.area || 'Unknown',
                address: property.address || '',
                rent: property.monthlyRent || 0,
                propertyType: property.propertyType || 'pg',
                genderSuitability: property.gender || 'any',
                amenities: property.amenities?.map(a => typeof a === 'string' ? a : a.name) || [],
                photos: property.images || [],
                latitude: property.latitude,
                longitude: property.longitude,
                description: property.description || ''
            },
            // Sync root level fields for premium UI
            amenities: property.amenities || [],
            propertyViews: property.propertyViews || [],
            facilities: property.facilities || {},
            exclusiveBenefits: property.exclusiveBenefits || [],
            roomTypes: property.roomTypes || [],
            propertyDetails: property.propertyDetails || {},
            pricing: property.pricing || {},
            policies: property.policies || {},
            tenantDescription: property.tenantDescription || "",
            latitude: property.latitude,
            longitude: property.longitude,
            generatedCredentials: {
                ownerName: property.ownerName || 'Verified Owner',
                loginId: property.ownerLoginId || ''
            },
            isLiveOnWebsite: true,
            status: 'live',
            updatedAt: new Date()
        };

        await ApprovedProperty.findOneAndUpdate(
            { visitId: vId },
            approvedPropertyData,
            { upsert: true, new: true }
        );
        console.log(`✅ Synced property ${property._id} to website`);
    } catch (err) {
        console.error('❌ Sync to ApprovedProperty failed:', err);
    }
};

// Create / Add a new Property with auto-geocoding
exports.addProperty = async (req, res) => {
  try {
    const propertyData = { ...req.body };
    propertyData.locationCode = deriveLocationCode(propertyData);

    // Auto-geocode address to lat/long ONLY IF coordinates are not already provided
    if ((!propertyData.latitude || !propertyData.longitude) && propertyData.address && propertyData.address.trim()) {
      try {
        const geo = await geocodeAddress(propertyData.address);
        propertyData.latitude = geo.latitude;
        propertyData.longitude = geo.longitude;
        console.log(`Geocoded "${propertyData.address}" → ${geo.latitude}, ${geo.longitude}`);
      } catch (geoErr) {
        console.warn('Geocoding failed, saving without coordinates:', geoErr.message);
      }
    }

    // If added by owner, it should be pending approval. Otherwise, auto-active for superadmin.
    if (propertyData.ownerLoginId) {
        propertyData.status = 'pending_approval';
        propertyData.isPublished = false;
        propertyData.isLiveOnWebsite = false;
    } else {
        propertyData.status = 'active'; // Auto active for superadmin
        propertyData.isPublished = true;
        propertyData.isLiveOnWebsite = true;
    }

    const property = new Property(propertyData);
    await property.save();

    // Auto-approve and make live on website
    await syncToApprovedProperty(property);

    res.status(201).json({
      success: true,
      message: 'Property created successfully',
      property
    });
  } catch (err) {
    console.error('Add Property Error:', err);
    res.status(500).json({ success: false, message: 'Failed to create property', error: err.message });
  }
};

// Get single property by ID
exports.getPropertyById = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id).populate('owner', 'name phone email');
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
    res.json({ success: true, property });
  } catch (err) {
    console.error('Get Property Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get ALL Properties (For Super Admin & Area Manager lists) with Pagination
exports.getAllProperties = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        
        // Run counts in parallel
        const [total, publishedCount, inactiveCount, rejectedCount] = await Promise.all([
            Property.countDocuments(),
            Property.countDocuments({ $or: [{ isLiveOnWebsite: true }, { status: 'active' }] }),
            Property.countDocuments({ status: 'inactive' }),
            Property.countDocuments({ status: 'blocked' })
        ]);
        
        const pendingCount = total - (publishedCount + inactiveCount + rejectedCount);
 
        const properties = await Property.find()
            .populate('owner', 'name phone email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({ 
            success: true, 
            properties, 
            total,
            page,
            totalPages: Math.ceil(total / limit),
            stats: {
                published: publishedCount,
                pending: Math.max(0, pendingCount),
                inactive: inactiveCount,
                rejected: rejectedCount
            }
        });
    } catch (err) {
        console.error("Get Properties Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update property with new fields (amenities, benefits, views)
exports.updateProperty = async (req, res) => {
  try {
    const propId = req.params.id;
    const updateData = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updateData, 'locationCode') || !updateData.locationCode) {
      updateData.locationCode = deriveLocationCode(updateData);
    }
    
    // Auto-geocode if address changed and coordinates are not already provided
    if ((!updateData.latitude || !updateData.longitude) && updateData.address && updateData.address.trim()) {
      try {
        const geo = await geocodeAddress(updateData.address);
        updateData.latitude = geo.latitude;
        updateData.longitude = geo.longitude;
      } catch (geoErr) {
        console.warn('Geocoding failed:', geoErr.message);
      }
    }
    
    const property = await Property.findByIdAndUpdate(
      propId,
      updateData,
      { new: true, runValidators: true }
    ).populate('owner', 'name phone email');
    
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    // Sync with ApprovedProperty
    await syncToApprovedProperty(property);

    // If not active OR not live, ensure it's removed from website listing
    if (!property.isLiveOnWebsite || property.status !== 'active') {
        try {
            await ApprovedProperty.deleteMany({
                visitId: property.visitId || property._id.toString()
            });
            console.log(`Removed property ${property._id} from ApprovedProperty (Inactive or Not Live)`);
        } catch (removeErr) {
            console.warn('Failed to remove property from website listing:', removeErr);
        }
    }
    
    // Clear API cache to reflect changes immediately
    clearCache('/api/approved-properties');
    clearCache('/api/properties');
    
    res.json({ success: true, message: 'Property updated successfully', property });
  } catch (err) {
    console.error('Update Property Error:', err);
    res.status(500).json({ success: false, message: 'Failed to update property', error: err.message });
  }
};

// Publish property (Super Admin action)
exports.publishProperty = async (req, res) => {
    try {
        const propId = req.params.id;
        const property = await Property.findById(propId);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        property.status = 'active';
        property.isPublished = true;
        property.isLiveOnWebsite = true;
        await property.save();

        // Sync with ApprovedProperty collection for website visibility
        await syncToApprovedProperty(property);

        // Clear API cache to reflect changes immediately
        clearCache('/api/approved-properties');
        clearCache('/api/properties');

        res.json({ success: true, message: 'Property published successfully', property });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Unpublish property (Super Admin action)
exports.unpublishProperty = async (req, res) => {
    try {
        const propId = req.params.id;
        const property = await Property.findById(propId);
        if (!property) return res.status(404).json({ message: 'Property not found' });

        property.isPublished = false;
        property.isLiveOnWebsite = false;
        await property.save();

        // Remove from ApprovedProperty
        try {
            await ApprovedProperty.deleteMany({
                $or: [
                    { visitId: property.visitId || property._id.toString() },
                    { propertyId: property.propertyId || "" },
                    { 'generatedCredentials.loginId': property.ownerLoginId || "" }
                ]
            });
        } catch (syncErr) {
            console.error('Removal from ApprovedProperty failed during unpublish:', syncErr);
        }

        // Clear API cache to reflect changes immediately
        clearCache('/api/approved-properties');
        clearCache('/api/properties');

        res.json({ success: true, message: 'Property unpublished successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Submit property enquiry (from list.html)
exports.submitEnquiry = async (req, res) => {
    try {
        const enquiryData = req.body;

        // Find area manager based on city/locality
        const city = enquiryData.city || enquiryData.locality;
        let assignedManager = null;

        if (city) {
            // Try to find area manager by city or area code
            assignedManager = await Employee.findOne({
                role: 'areamanager',
                $or: [
                    { city: new RegExp(city, 'i') },
                    { area: new RegExp(city, 'i') },
                    { areaCode: new RegExp(city.substring(0, 2), 'i') },
                    { locationCode: new RegExp(city.substring(0, 2), 'i') }
                ],
                isActive: true
            });
        }

        // If no specific manager found, assign to first available area manager
        if (!assignedManager) {
            assignedManager = await Employee.findOne({
                role: 'areamanager',
                isActive: true
            });
        }

        // Create the enquiry
        const enquiry = new Enquiry({
            ...enquiryData,
            status: 'pending_review',
            assignedTo: assignedManager ? assignedManager.loginId : null,
            ts: Date.now()
        });

        await enquiry.save();

        // Send notification to area manager if assigned
        if (assignedManager) {
            const notification = new Notification({
                to: assignedManager.loginId,
                from: 'SYSTEM',
                type: 'property_enquiry',
                title: 'New Property Enquiry',
                message: `New property enquiry from ${enquiryData.owner_name || 'Unknown'} for ${enquiryData.property_name || 'Property'} in ${city || 'Unknown location'}`,
                data: {
                    enquiryId: enquiry._id,
                    propertyName: enquiryData.property_name,
                    ownerName: enquiryData.owner_name,
                    city: city
                },
                read: false,
                createdAt: new Date()
            });

            await notification.save();
        }

        res.json({
            success: true,
            message: 'Property enquiry submitted successfully',
            enquiry: enquiry,
            assignedTo: assignedManager ? `${assignedManager.name} (${assignedManager.loginId})` : 'No area manager found'
        });

    } catch (err) {
        console.error('Submit Enquiry Error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to submit enquiry',
            error: err.message
        });
    }
};

// Delete property
exports.deleteProperty = async (req, res) => {
    try {
        const propId = req.params.id;
        const property = await Property.findById(propId);
        if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

        // Remove ALL instances from ApprovedProperty as well (to clear duplicates)
        await ApprovedProperty.deleteMany({
            $or: [
                { visitId: property.visitId || property._id.toString() },
                { propertyId: property.propertyId || "" },
                { 'generatedCredentials.loginId': property.ownerLoginId || "" }
            ]
        });

        await Property.findByIdAndDelete(propId);

        // Clear API cache to reflect changes immediately
        clearCache('/api/approved-properties');
        clearCache('/api/properties');

        res.json({ success: true, message: 'Property deleted successfully' });
    } catch (err) {
        console.error('Delete Property Error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete property', error: err.message });
    }
};
