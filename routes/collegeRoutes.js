const express = require('express');
const router = express.Router();
const ApprovedProperty = require('../models/ApprovedProperty');

// College data by city
const collegesByCity = {
  'Kota': [
    'Allen Kota',
    'Resonance Kota',
    'Bansal Classes',
    'Motion Kota',
    'Vidyamandir Classes',
    'Akash Institute'
  ],
  'Indore': [
    'IIT Indore',
    'MITS Indore',
    'Devi Ahilya University',
    'Prestige Institute',
    'Choithram School'
  ],
  'Jaipur': [
    'MNIT Jaipur',
    'Jaipur University',
    'Manipal University',
    'IIT Jodhpur',
    'ICFAI Jaipur'
  ],
  'Delhi': [
    'Delhi University',
    'AIIMS Delhi',
    'IIT Delhi',
    'IIIT Delhi',
    'Delhi Technological University',
    'St. Stephens College'
  ],
  'Bhopal': [
    'Bhopal University',
    'IISER Bhopal',
    'Barkatullah University',
    'IIM Indore'
  ],
  'Nagpur': [
    'VNIT Nagpur',
    'RCOEM Nagpur',
    'Nagpur University',
    'IIT Bombay (Nagpur Campus)'
  ],
  'Mumbai': [
    'IIT Bombay',
    'IIMC Mumbai',
    'Mumbai University',
    'St. Xaviers College',
    'NMIMS Mumbai',
    'AIIMS Mumbai'
  ],
  'Bangalore': [
    'IIT Bangalore',
    'IISC Bangalore',
    'NIT Karnataka',
    'Christ University',
    'Bangalore University',
    'CMIT Bangalore'
  ]
};

// Get colleges by city
router.get('/by-city/:city', (req, res) => {
  try {
    const { city } = req.params;
    const colleges = collegesByCity[city] || [];
    
    res.status(200).json({
      success: true,
      city,
      colleges,
      count: colleges.length
    });
  } catch (error) {
    console.error('Error fetching colleges:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching colleges',
      error: error.message
    });
  }
});

// Get colleges for a specific property
router.get('/property/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const property = await ApprovedProperty.findById(propertyId);
    if (!property) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const city = property.propertyInfo?.city;
    const nearbyColleges = property.nearbyColleges || collegesByCity[city] || [];

    res.status(200).json({
      success: true,
      propertyId,
      city,
      nearbyColleges,
      count: nearbyColleges.length
    });
  } catch (error) {
    console.error('Error fetching property colleges:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching colleges',
      error: error.message
    });
  }
});

// Get all available cities with colleges
router.get('/cities/all', (req, res) => {
  try {
    const cities = Object.keys(collegesByCity);
    
    res.status(200).json({
      success: true,
      cities,
      count: cities.length
    });
  } catch (error) {
    console.error('Error fetching cities:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching cities',
      error: error.message
    });
  }
});

// ============================================================
// NEW: Fetch nearby colleges from Overpass API - SEPARATE
// ============================================================
const collegesCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

async function fetchCollegesFromOverpass(city) {
  // Check cache
  const cached = collegesCache.get(city);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`📦 [${city}] Using cached colleges`);
    return cached.data;
  }
  
  // City coordinates (approximate center)
  const cityCenters = {
    'Kota': [25.18, 75.83],
    'Indore': [22.72, 75.85],
    'Jaipur': [26.91, 75.78],
    'Delhi': [28.61, 77.20],
    'Bhopal': [23.25, 77.41],
    'Nagpur': [21.14, 79.08],
    'Mumbai': [19.07, 72.87],
    'Bangalore': [12.97, 77.59]
  };
  
  const center = cityCenters[city];
  if (!center) {
    return collegesByCity[city] || [];
  }
  
  const [lat, lng] = center;
  const bbox = `${lat-0.1},${lng-0.1},${lat+0.1},${lng+0.1}`;
  
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="college"](${bbox});
      way["amenity"="college"](${bbox});
      node["amenity"="university"](${bbox});
      way["amenity"="university"](${bbox});
    );
    out center tags 15;
  `;
  
  try {
    console.log(`🌍 [${city}] Calling Overpass API...`);
    
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    
    if (!response.ok) {
      console.warn(`⚠️ [${city}] Overpass error: ${response.status}, using static data`);
      return collegesByCity[city] || [];
    }
    
    const data = await response.json();
    
    const colleges = data.elements
      .filter(el => el.tags && el.tags.name)
      .map(el => el.tags.name)
      .slice(0, 10);
    
    console.log(`✅ [${city}] Found ${colleges.length} colleges from Overpass`);
    
    // Cache result
    collegesCache.set(city, { data: colleges, timestamp: Date.now() });
    
    return colleges;
    
  } catch (error) {
    console.error(`❌ [${city}] Overpass error:`, error.message);
    return collegesByCity[city] || [];
  }
}

// GET: Fetch nearby colleges from Overpass - ONE CITY AT A TIME
router.get('/fetch-nearby', async (req, res) => {
  try {
    const { city } = req.query;
    
    if (!city) {
      return res.status(400).json({
        success: false,
        message: 'City parameter required'
      });
    }
    
    console.log(`🎓 [/api/colleges/fetch-nearby] Fetching for city: ${city}`);
    
    // Fetch from Overpass (with fallback to static)
    const colleges = await fetchCollegesFromOverpass(city);
    
    res.status(200).json({
      success: true,
      city,
      colleges,
      count: colleges.length,
      source: collegesCache.has(city) ? 'overpass' : 'static'
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

// GET: Fetch for multiple cities with delay
router.get('/fetch-all-cities', async (req, res) => {
  try {
    const cities = Object.keys(collegesByCity);
    const results = {};
    
    console.log('🎓 [/api/colleges/fetch-all-cities] Starting batch fetch...');
    
    // Process one by one with delay
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      
      // Wait 3 seconds between cities
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      try {
        const colleges = await fetchCollegesFromOverpass(city);
        results[city] = colleges;
        console.log(`✅ [${i+1}/${cities.length}] ${city}: ${colleges.length} colleges`);
      } catch (error) {
        console.error(`❌ ${city} failed:`, error.message);
        results[city] = collegesByCity[city] || [];
      }
    }
    
    // Flatten all colleges
    const allColleges = [...new Set(Object.values(results).flat())].sort();
    
    res.status(200).json({
      success: true,
      cities: results,
      allColleges,
      totalColleges: allColleges.length,
      cityCount: cities.length
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

module.exports = router;
