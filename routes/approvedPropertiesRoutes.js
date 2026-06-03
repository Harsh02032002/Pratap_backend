const express = require('express');
const router = express.Router();
const ApprovedProperty = require('../models/ApprovedProperty');

// Simple in-memory cache for Overpass responses
const overpassCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Extract city from property name (e.g., "HOSTEL - Vastrapur, Ahmedabad" -> "Ahmedabad")
function extractCityFromName(name) {
  console.log('🏙️ extractCityFromName input:', name);
  if (!name) {
    console.log('❌ No name provided');
    return null;
  }
  const parts = name.split(',');
  console.log('🏙️ Name parts:', parts);
  if (parts.length > 1) {
    const city = parts[parts.length - 1].trim();
    console.log('✅ Extracted city:', city);
    return city;
  }
  console.log('❌ No comma found in name');
  return null;
}

// Parse amenities from JSON strings to proper objects
function parseAmenities(amenities) {
  if (!amenities || !Array.isArray(amenities)) return [];
  
  console.log('🔧 parseAmenities input:', amenities);
  
  const parsed = amenities.map(amenity => {
    if (typeof amenity === 'string') {
      try {
        // Try to parse JSON string
        const parsed = JSON.parse(amenity);
        console.log('✅ Parsed amenity:', parsed);
        return parsed;
      } catch (e) {
        // If parsing fails, create a basic amenity object
        const fallback = {
          name: amenity.replace(/[{}]/g, '').trim(),
          icon: 'check',
          category: 'basic'
        };
        console.log('❌ Parse failed, fallback:', fallback);
        return fallback;
      }
    }
    return amenity;
  });
  
  console.log('🔧 parseAmenities output:', parsed);
  return parsed;
}

// Haversine distance formula (km)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fetch colleges using bounding box - GROUPED BY CITY with rate limiting
async function fetchCollegesBBox(properties) {
  console.log(`🔍 Processing ${properties.length} properties for coordinates`);
  
  const cityGroups = {};
  properties.forEach(p => {
    const city = p.city || 'unknown';
    if (!cityGroups[city]) cityGroups[city] = [];
    cityGroups[city].push(p);
  });
  
  const cities = Object.entries(cityGroups);
  console.log(`📍 Found ${cities.length} cities:`, cities.map(([city]) => city));
  
  // Process cities with 5 second delay between each to avoid rate limits
  const allColleges = [];
  for (let i = 0; i < cities.length; i++) {
    const [city, cityProps] = cities[i];
    console.log(`\n🏙️ [${i + 1}/${cities.length}] Processing ${city} (${cityProps.length} properties)`);
    
    // Wait 5 seconds between cities (except first one)
    if (i > 0) {
      console.log(`⏳ Waiting 5 seconds before next API call...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    try {
      const cityColleges = await fetchCollegesForCity(cityProps, city);
      allColleges.push(...cityColleges);
    } catch (error) {
      console.error(`❌ Failed to fetch colleges for ${city}:`, error.message);
      // Continue with other cities even if one fails
    }
  }
  
  // Remove duplicates
  const uniqueColleges = [];
  const seen = new Set();
  for (const college of allColleges) {
    const key = `${college.name}-${college.lat}-${college.lon}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueColleges.push(college);
    }
  }
  
  console.log(`\n✅ Total unique colleges fetched: ${uniqueColleges.length}`);
  return uniqueColleges;
}

// Fetch colleges for a single city
async function fetchCollegesForCity(properties, cityName, retryCount = 0) {
  const MAX_RETRIES = 2;
  
  const coords = properties
    .map(p => {
      const lat = p.propertyInfo?.location?.coordinates?.[1] || p.propertyInfo?.latitude;
      const lng = p.propertyInfo?.location?.coordinates?.[0] || p.propertyInfo?.longitude;
      return lat && lng ? { lat, lng } : null;
    })
    .filter(Boolean);

  if (coords.length === 0) {
    console.log(`⚠️ No coordinates for ${cityName}`);
    return [];
  }

  const lats = coords.map(c => c.lat);
  const lngs = coords.map(c => c.lng);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);

  const padding = 0.03;
  const bbox = `${south - padding},${west - padding},${north + padding},${east + padding}`;
  const timeout = Math.min(30 + (properties.length * 10), 60);

  const cacheKey = `${cityName}-${bbox}`;
  const cached = overpassCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`📋 Using cached data for ${cityName}`);
    return cached.data;
  }

  const query = `
    [out:json][timeout:${timeout}];
    (
      node["amenity"="college"](${bbox});
      node["amenity"="university"](${bbox});
      way["amenity"="college"](${bbox});
      way["amenity"="university"](${bbox});
    );
    out center tags;
  `;

  try {
    if (retryCount > 0) {
      console.log(`🔄 Retry ${retryCount} for ${cityName}...`);
    }
    
    console.log(`🌍 Fetching colleges for ${cityName} (timeout: ${timeout}s), bbox: ${bbox}`);
    
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });

    if (!response.ok) {
      if (response.status === 504 && retryCount < MAX_RETRIES) {
        console.warn(`⚠️ Timeout for ${cityName}, waiting 10s before retry...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s
        return fetchCollegesForCity(properties, cityName, retryCount + 1);
      }
      if (response.status === 429) {
        console.warn(`⚠️ Rate limit for ${cityName}, waiting 15s...`);
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s
        if (retryCount < MAX_RETRIES) {
          return fetchCollegesForCity(properties, cityName, retryCount + 1);
        }
        return [];
      }
      throw new Error(`Overpass API error: ${response.status}`);
    }

    const data = await response.json();
    
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

    overpassCache.set(cacheKey, {
      data: colleges,
      timestamp: Date.now(),
    });

    console.log(`✅ Fetched ${colleges.length} colleges for ${cityName}`);
    return colleges;

  } catch (error) {
    console.error(`❌ Error fetching colleges for ${cityName}:`, error.message);
    if (retryCount < MAX_RETRIES && (error.message.includes('504') || error.message.includes('429'))) {
      console.log(`🔄 Retrying ${cityName} after error...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      return fetchCollegesForCity(properties, cityName, retryCount + 1);
    }
    return [];
  }
}

// Assign nearby colleges to properties
function assignNearbyColleges(properties, colleges) {
  return properties.map(property => {
    const propLat = property.propertyInfo?.location?.coordinates?.[1] || property.propertyInfo?.latitude;
    const propLng = property.propertyInfo?.location?.coordinates?.[0] || property.propertyInfo?.longitude;

    if (!propLat || !propLng || colleges.length === 0) {
      return { ...property, nearbyColleges: [] };
    }

    const nearbyColleges = colleges
      .map(college => ({
        ...college,
        distance: getDistance(propLat, propLng, college.lat, college.lon),
      }))
      .filter(c => c.distance <= 2.0)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5)
      .map(c => ({
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        distance: Math.round(c.distance * 100) / 100,
      }));

    return { ...property, nearbyColleges };
  });
}

// ============================================================
// POST: Save an approved property to MongoDB
// ============================================================

router.post('/save', async (req, res) => {

    try {

        const {

            visitId,

            propertyInfo,

            generatedCredentials,

            isLiveOnWebsite,

            approvedBy

        } = req.body;



        if (!visitId || !propertyInfo) {

            return res.status(400).json({

                success: false,

                message: 'Missing required fields: visitId, propertyInfo'

            });

        }



        // Check if already approved

        const existing = await ApprovedProperty.findOne({ visitId });

        if (existing) {

            // Update existing approval

            existing.propertyInfo = propertyInfo;

            existing.isLiveOnWebsite = isLiveOnWebsite || existing.isLiveOnWebsite;

            existing.status = isLiveOnWebsite ? 'live' : 'approved';

            existing.approvedBy = approvedBy || existing.approvedBy;

            if (generatedCredentials) {

                existing.generatedCredentials = generatedCredentials;

            }

            await existing.save();

            console.log('✅ [approved-properties/save] Updated existing approval:', visitId);

            return res.status(200).json({

                success: true,

                message: 'Property approval updated',

                property: existing

            });

        }



        // Create new approved property

        const approvedProperty = new ApprovedProperty({

            visitId,

            propertyInfo,

            generatedCredentials: generatedCredentials || {},

            isLiveOnWebsite: isLiveOnWebsite || false,

            status: isLiveOnWebsite ? 'live' : 'approved',

            approvedBy: approvedBy || 'superadmin'

        });



        await approvedProperty.save();

        console.log('✅ [approved-properties/save] Property approved and saved:', visitId);



        res.status(201).json({

            success: true,

            message: 'Property approved and saved to database',

            property: approvedProperty

        });



    } catch (error) {

        console.error('❌ [approved-properties/save] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error saving approved property',

            error: error.message

        });

    }

});



// ============================================================

// GET: Fetch all approved properties (for website display)

// ============================================================

router.get('/all', async (req, res) => {

    try {

        console.log('🔍 [approved-properties/all] Fetching all approved properties...');

        

        // Get total count first
        const totalCount = await ApprovedProperty.countDocuments({ 
            status: { $in: ['approved', 'live'] }
        });
        
        const properties = await ApprovedProperty.find({ 
            status: { $in: ['approved', 'live'] }
        }).sort({ approvedAt: -1 });

        console.log('✅ [approved-properties/all] Found', properties.length, 'approved properties (Total:', totalCount + ')');

        res.status(200).json({
            success: true,
            count: properties.length,
            total: totalCount,
            properties: properties,
            message: `${totalCount} properties found`
        });



    } catch (error) {

        console.error('❌ [approved-properties/all] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error fetching properties',

            error: error.message

        });

    }

});



// ============================================================

// GET: Fetch approved properties by city

// ============================================================

router.get('/city/:city', async (req, res) => {

    try {

        const { city } = req.params;

        console.log('🔍 [approved-properties/city] Fetching properties for city:', city);

        

        // Get total count for this city
        const totalCount = await ApprovedProperty.countDocuments({
            'propertyInfo.city': city,
            isLiveOnWebsite: true
        });
        
        const properties = await ApprovedProperty.find({ 
            status: { $in: ['approved', 'live'] },
            isLiveOnWebsite: true
        }).sort({ approvedAt: -1 });

        console.log('✅ [approved-properties/city] Found', properties.length, 'properties for city:', city, '(Total:', totalCount + ')');

        res.status(200).json({
            success: true,
            count: properties.length,
            total: totalCount,
            properties: properties,
            message: `${totalCount} properties found in ${city}`
        });



    } catch (error) {

        console.error('❌ [approved-properties/city] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error fetching properties by city',

            error: error.message

        });

    }

});



// ============================================================

// GET: Public approved properties (for ourproperty.html)

// ============================================================

router.get('/public/approved', async (req, res) => {

    try {

        console.log('🔍 [approved-properties/public/approved] Fetching public approved properties...');



        // For now, return all approved properties (both live and offline) to test display

        // Later we can filter by isLiveOnWebsite: true for production

        const rawProperties = await ApprovedProperty.find({
            status: { $in: ['approved', 'live'] }
        }).sort({ updatedAt: -1 });

        const uniqueMap = new Map();
        rawProperties.forEach(p => {
            const key = p.visitId || p.propertyId || p._id.toString();
            if (!uniqueMap.has(key)) uniqueMap.set(key, p);
        });
        
        const properties = Array.from(uniqueMap.values());



        console.log('✅ [approved-properties/public/approved] Found', properties.length, 'approved properties');

        // Get total count before any transformation
        const totalCount = properties.length;

        // Transform to match ourproperty.html expectations

        const transformedProperties = properties.map(prop => {
          console.log(`🔍 Backend Debug - Property: ${prop.propertyInfo?.name || prop.visitId}`);
          console.log(`  City: ${prop.city || prop.propertyInfo?.city || 'Unknown'}`);
          console.log(`  PropertyViews: ${prop.propertyViews?.length || 0} categories`);
          if (prop.propertyViews?.length > 0) {
            console.log(`  First category: ${prop.propertyViews[0].label} (${prop.propertyViews[0].images?.length || 0} images)`);
          }
          
          return {

            _id: prop._id,

            visitId: prop.visitId,

            propertyId: prop.propertyId || prop.visitId,

            enquiry_id: prop.enquiry_id || prop.visitId,

            property_name: prop.propertyInfo?.name || 'Property',

            property_type: prop.propertyInfo?.propertyType || '',

            locality: prop.propertyInfo?.area || '',

            city: prop.city || prop.propertyInfo?.city || prop.propertyInfo?.address?.city || extractCityFromName(prop.propertyInfo?.name) || 'Unknown',

            rent: prop.propertyInfo?.rent || 0,
            featuredImage: prop.featuredImage || prop.propertyInfo?.photos?.[0] || '',

            photos: prop.images && prop.images.length > 0 ? prop.images : (prop.propertyInfo?.photos || []),
            images: prop.images && prop.images.length > 0 ? prop.images : (prop.propertyInfo?.photos || []),

            professionalPhotos: prop.professionalPhotos || [],

            isVerified: true,

            rating: 4.5,

            reviewsCount: 10,

            propertyInfo: prop.propertyInfo,

            propertyViews: prop.propertyViews || [],
            amenities: parseAmenities(prop.amenities || prop.propertyInfo?.amenities || []),
            roomTypes: prop.roomTypes || [],
            facilities: prop.facilities || {},
            propertyDetails: prop.propertyDetails || {},
            pricing: prop.pricing || {},
            policies: prop.policies || {},
            tenantDescription: prop.tenantDescription || "",
            videoUrl: prop.videoUrl || "",
            state: prop.state || "",
            pincode: prop.pincode || "",
            landmark: prop.landmark || "",
            contact: prop.contact || {},
            monthlyRent: prop.monthlyRent || prop.propertyInfo?.rent || 0,
            gender: prop.gender || prop.propertyInfo?.genderSuitability || 'Co-ed',
            status: prop.status,
            isLiveOnWebsite: prop.isLiveOnWebsite,
            submittedAt: prop.submittedAt,
            approvedAt: prop.approvedAt,
            updatedAt: prop.updatedAt,
            generatedCredentials: prop.generatedCredentials,
            ownerLoginId: prop.generatedCredentials?.loginId,
            description: prop.description || prop.propertyInfo?.description || "",
            createdBy: prop.approvedBy
          };
        });

        // Return proper response with count, total, and pagination info
        res.status(200).json({
            success: true,
            count: transformedProperties.length,
            total: totalCount,
            properties: transformedProperties,
            page: 1,
            pages: 1,
            message: `${totalCount} properties found`
        });

    } catch (error) {

        console.error('❌ [approved-properties/public/approved] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error fetching public approved properties',

            error: error.message

        });

    }

});



// ============================================================

// GET: Fetch all approved properties (including offline)

// ============================================================

router.get('/approved/all', async (req, res) => {

    try {

        console.log('🔍 [approved-properties/approved/all] Fetching all approved properties...');



        const properties = await ApprovedProperty.find({

            status: { $in: ['approved', 'live'] }

        }).sort({ approvedAt: -1 });



        console.log('✅ [approved-properties/approved/all] Found', properties.length, 'approved properties');



        res.status(200).json({

            success: true,

            count: properties.length,

            properties: properties

        });



    } catch (error) {

        console.error('❌ [approved-properties/approved/all] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error fetching approved properties',

            error: error.message

        });

    }

});

// ============================================================
// GET: Fetch nearby colleges for all properties
// ============================================================
router.get('/colleges/all', async (req, res) => {
    try {
        console.log('🎓 [approved-properties/colleges/all] Fetching colleges...');
        
        const properties = await ApprovedProperty.find({
            status: { $in: ['approved', 'live'] }
        }).sort({ approvedAt: -1 });
        
        const transformedProperties = properties.map(prop => {
            const rawProp = prop.toObject ? prop.toObject() : prop;
            return {
                _id: rawProp.visitId,
                property_name: rawProp.propertyInfo?.name || 'Property',
                city: rawProp.propertyInfo?.city || '',
                propertyInfo: {
                    location: rawProp.propertyInfo?.location,
                    latitude: rawProp.propertyInfo?.location?.coordinates?.[1] || rawProp.propertyInfo?.latitude,
                    longitude: rawProp.propertyInfo?.location?.coordinates?.[0] || rawProp.propertyInfo?.longitude,
                }
            };
        });
        
        const colleges = await fetchCollegesBBox(transformedProperties);
        const enrichedProperties = assignNearbyColleges(transformedProperties, colleges);
        
        const collegesMap = enrichedProperties.map(p => ({
            propertyId: p._id,
            propertyName: p.property_name,
            city: p.city,
            nearbyColleges: p.nearbyColleges
        }));
        
        res.status(200).json({
            success: true,
            count: collegesMap.length,
            colleges: collegesMap,
            allColleges: [...new Set(colleges.map(c => c.name))].sort()
        });
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error fetching colleges',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch a specific approved property by visitId
// ============================================================

router.get('/:visitId', async (req, res) => {

    try {

        const { visitId } = req.params;

        console.log('🔍 [approved-properties/:visitId] Fetching property:', visitId);

        

        const property = await ApprovedProperty.findOne({ visitId });

        

        if (!property) {

            return res.status(404).json({

                success: false,

                message: 'Property not found'

            });

        }



        console.log('✅ [approved-properties/:visitId] Found property:', visitId);



        res.status(200).json({

            success: true,

            property: property

        });



    } catch (error) {

        console.error('❌ [approved-properties/:visitId] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error fetching property',

            error: error.message

        });

    }

});



// ============================================================

// PUT: Update property to toggle live status

// ============================================================

router.put('/:visitId/toggle-live', async (req, res) => {

    try {

        const { visitId } = req.params;

        const { isLiveOnWebsite } = req.body;



        const property = await ApprovedProperty.findOne({ visitId });

        if (!property) {

            return res.status(404).json({

                success: false,

                message: 'Property not found'

            });

        }



        property.isLiveOnWebsite = isLiveOnWebsite;

        property.status = isLiveOnWebsite ? 'live' : 'approved';

        await property.save();



        console.log('✅ [approved-properties/toggle-live] Updated property:', visitId, 'isLive:', isLiveOnWebsite);



        res.status(200).json({

            success: true,

            message: 'Property status updated',

            property: property

        });



    } catch (error) {

        console.error('❌ [approved-properties/toggle-live] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error updating property',

            error: error.message

        });

    }

});



// ============================================================

// DELETE: Remove an approved property

// ============================================================

router.delete('/:visitId', async (req, res) => {

    try {

        const { visitId } = req.params;



        const result = await ApprovedProperty.findOneAndDelete({ visitId });

        if (!result) {

            return res.status(404).json({

                success: false,

                message: 'Property not found'

            });

        }



        console.log('✅ [approved-properties/delete] Property deleted:', visitId);



        res.status(200).json({

            success: true,

            message: 'Property deleted successfully'

        });



    } catch (error) {

        console.error('❌ [approved-properties/delete] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error deleting property',

            error: error.message

        });

    }

});



// ============================================================

// PUT: Toggle property live status (for website.html admin panel)

// ============================================================

router.put('/:id/toggle-live', async (req, res) => {

    try {

        const propertyId = req.params.id;

        console.log('🔄 [approved-properties/toggle-live] Toggling live status for:', propertyId);



        const property = await ApprovedProperty.findOne({

            $or: [

                { _id: propertyId },

                { visitId: propertyId },

                { propertyId: propertyId }

            ]

        });



        if (!property) {

            console.error('❌ [approved-properties/toggle-live] Property not found:', propertyId);

            return res.status(404).json({

                success: false,

                message: 'Property not found'

            });

        }



        // Toggle the live status

        property.isLiveOnWebsite = !property.isLiveOnWebsite;

        property.status = property.isLiveOnWebsite ? 'live' : 'approved';

        await property.save();



        console.log('✅ [approved-properties/toggle-live] Toggled to:', property.isLiveOnWebsite);



        res.status(200).json({

            success: true,

            message: 'Property live status updated',

            property: {

                _id: property._id,

                visitId: property.visitId,

                isLiveOnWebsite: property.isLiveOnWebsite,

                status: property.status,

                propertyInfo: property.propertyInfo

            }

        });



    } catch (error) {

        console.error('❌ [approved-properties/toggle-live] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error toggling live status',

            error: error.message

        });

    }

});



// ============================================================

// DELETE: Delete property by ID (for website.html admin panel)

// ============================================================

router.delete('/:id', async (req, res) => {

    try {

        const propertyId = req.params.id;

        console.log('🗑️ [approved-properties/delete-by-id] Deleting property:', propertyId);



        const property = await ApprovedProperty.findOne({

            $or: [

                { _id: propertyId },

                { visitId: propertyId },

                { propertyId: propertyId }

            ]

        });



        if (!property) {

            console.error('❌ [approved-properties/delete-by-id] Property not found:', propertyId);

            return res.status(404).json({

                success: false,

                message: 'Property not found'

            });

        }



        await ApprovedProperty.deleteOne({ _id: property._id });

        console.log('✅ [approved-properties/delete-by-id] Property deleted:', propertyId);



        res.status(200).json({

            success: true,

            message: 'Property deleted successfully'

        });



    } catch (error) {

        console.error('❌ [approved-properties/delete-by-id] Error:', error.message);

        res.status(500).json({

            success: false,

            message: 'Error deleting property',

            error: error.message

        });

    }

});



module.exports = router;

