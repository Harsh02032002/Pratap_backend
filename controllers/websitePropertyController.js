const WebsiteProperty = require('../models/WebsiteProperty');

// Simple in-memory cache for Overpass responses
const overpassCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Haversine distance formula (km)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fetch colleges using bounding box (single API call for all properties)
async function fetchCollegesBBox(properties) {
  // Extract coordinates from properties
  const coords = properties
    .map(p => {
      const lat = p.latitude || p.propertyInfo?.latitude || p.propertyInfo?.location?.coordinates?.[1];
      const lng = p.longitude || p.propertyInfo?.longitude || p.propertyInfo?.location?.coordinates?.[0];
      return lat && lng ? { lat, lng } : null;
    })
    .filter(Boolean);

  if (coords.length === 0) {
    return [];
  }

  // Calculate bounding box
  const lats = coords.map(c => c.lat);
  const lngs = coords.map(c => c.lng);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);

  // Add padding to bbox (0.02 degrees ≈ 2km)
  const padding = 0.02;
  const bbox = `${south - padding},${west - padding},${north + padding},${east + padding}`;

  // Create cache key
  const cacheKey = bbox;
  const cached = overpassCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('📋 Using cached Overpass data');
    return cached.data;
  }

  // Build Overpass query for colleges and universities in bbox
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="college"](${bbox});
      node["amenity"="university"](${bbox});
      way["amenity"="college"](${bbox});
      way["amenity"="university"](${bbox});
    );
    out center tags;
  `;

  try {
    console.log(`🌍 Fetching colleges from Overpass API for bbox: ${bbox}`);
    
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });

    if (!response.ok) {
      throw new Error(`Overpass API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Parse colleges from response
    const colleges = data.elements
      .filter(el => el.tags?.name)
      .map(el => {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        return {
          name: el.tags.name,
          lat,
          lon,
          type: el.tags.amenity,
        };
      })
      .filter(c => c.lat && c.lon);

    // Cache the result
    overpassCache.set(cacheKey, {
      data: colleges,
      timestamp: Date.now(),
    });

    console.log(`✅ Fetched ${colleges.length} colleges from Overpass API`);
    return colleges;

  } catch (error) {
    console.error('❌ Error fetching colleges from Overpass:', error);
    return [];
  }
}

// Assign nearby colleges to properties
function assignNearbyColleges(properties, colleges) {
  return properties.map(property => {
    const propLat = property.latitude || property.propertyInfo?.latitude || property.propertyInfo?.location?.coordinates?.[1];
    const propLng = property.longitude || property.propertyInfo?.longitude || property.propertyInfo?.location?.coordinates?.[0];

    if (!propLat || !propLng || colleges.length === 0) {
      return { ...property.toObject(), nearbyColleges: [] };
    }

    // Calculate distance to each college and filter within 2km
    const nearbyColleges = colleges
      .map(college => ({
        ...college,
        distance: getDistance(propLat, propLng, college.lat, college.lon),
      }))
      .filter(c => c.distance <= 2.0)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5) // Top 5 nearest
      .map(c => ({
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        distance: Math.round(c.distance * 100) / 100, // Round to 2 decimals
      }));

    return { ...property.toObject(), nearbyColleges };
  });
}

// Get all website properties
exports.getAllWebsiteProperties = async (req, res) => {
    try {
        const properties = await WebsiteProperty.find().sort({ createdAt: -1 });
        res.json({
            success: true,
            properties: properties
        });
    } catch (err) {
        console.error('Error fetching website properties:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

// Get website properties by status (online/offline)
exports.getWebsitePropertiesByStatus = async (req, res) => {
    try {
        const { status } = req.params; // 'online' or 'offline'
        const isLive = status === 'online';

        const properties = await WebsiteProperty.find({ isLiveOnWebsite: isLive }).sort({ createdAt: -1 });
        res.json({
            success: true,
            properties: properties
        });
    } catch (err) {
        console.error('Error fetching website properties by status:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

// Add property to website
exports.addWebsiteProperty = async (req, res) => {
    try {
        const propertyData = req.body;

        // Check if property already exists
        const existing = await WebsiteProperty.findOne({ visitId: propertyData.visitId });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'Property already exists on website'
            });
        }

        const websiteProperty = new WebsiteProperty(propertyData);
        await websiteProperty.save();

        res.json({
            success: true,
            property: websiteProperty
        });
    } catch (err) {
        console.error('Error adding website property:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

// Toggle property status (online/offline)
exports.toggleWebsiteStatus = async (req, res) => {
    try {
        const { visitId } = req.params;

        const property = await WebsiteProperty.findOne({ visitId });
        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        property.isLiveOnWebsite = !property.isLiveOnWebsite;
        property.status = property.isLiveOnWebsite ? 'online' : 'offline';
        await property.save();

        res.json({
            success: true,
            property: property
        });
    } catch (err) {
        console.error('Error toggling website status:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

// Delete property from website
exports.deleteWebsiteProperty = async (req, res) => {
    try {
        const { visitId } = req.params;

        const result = await WebsiteProperty.findOneAndDelete({ visitId });
        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        res.json({
            success: true,
            message: 'Property removed from website'
        });
    } catch (err) {
        console.error('Error deleting website property:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

// Get properties for public website (only online ones) - MAIN FUNCTION
exports.getPublicWebsiteProperties = async (req, res) => {
    try {
        const { city, area, minPrice, maxPrice, gender, propertyType } = req.query;

        let filter = { isLiveOnWebsite: true };

        if (city) filter.city = new RegExp(city, 'i');
        if (area) filter.area = new RegExp(area, 'i');
        if (gender) filter.gender = new RegExp(gender, 'i');
        if (propertyType) filter.propertyType = new RegExp(propertyType, 'i');
        if (minPrice) filter.monthlyRent = { ...filter.monthlyRent, $gte: parseInt(minPrice) };
        if (maxPrice) {
            if (maxPrice === '50000_plus') {
                filter.monthlyRent = { ...filter.monthlyRent, $gte: 50000 };
            } else {
                filter.monthlyRent = { ...filter.monthlyRent, $lte: parseInt(maxPrice) };
            }
        }

        // Exclude test properties
        filter.propertyName = { $nin: [/jhvhhjhjv/i, /test/i] };

        const properties = await WebsiteProperty.find(filter).sort({ createdAt: -1 });
        console.log(`📊 Found ${properties.length} properties from database`);
        
        // Fetch colleges using bbox (single API call for all properties)
        console.log('🎓 Starting college fetch for all properties...');
        const colleges = await fetchCollegesBBox(properties);
        console.log(`✅ Total colleges fetched: ${colleges.length}`);
        
        // Assign nearby colleges to each property
        console.log('🎯 Assigning colleges to properties...');
        const enrichedProperties = assignNearbyColleges(properties, colleges);
        
        // Log sample
        if (enrichedProperties.length > 0) {
            console.log(`📋 Sample property: ${enrichedProperties[0].propertyName} has ${enrichedProperties[0].nearbyColleges?.length || 0} colleges`);
        }

        res.json({
            success: true,
            properties: enrichedProperties
        });
    } catch (err) {
        console.error('Error fetching public website properties:', err);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};