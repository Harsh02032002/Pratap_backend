const express = require('express');
const router = express.Router();
const WebsiteProperty = require('../models/WebsiteProperty');
const ApprovedProperty = require('../models/ApprovedProperty');

// Update property with nearby colleges/institutes
router.put('/properties/:id/colleges', async (req, res) => {
  try {
    const { id } = req.params;
    const { nearbyColleges, nearbyUniversities, nearbyInstitutes } = req.body;
    
    console.log(`🔄 Updating colleges for property: ${id}`);
    
    // Try to find and update in WebsiteProperty first
    let property = await WebsiteProperty.findOne({
      $or: [
        { _id: id },
        { visitId: id },
        { propertyName: id }
      ]
    });
    
    if (!property) {
      // Try ApprovedProperty if not found in WebsiteProperty
      property = await ApprovedProperty.findOne({
        $or: [
          { _id: id },
          { visitId: id },
          { propertyName: id }
        ]
      });
    }
    
    if (!property) {
      return res.status(404).json({ 
        success: false, 
        message: 'Property not found' 
      });
    }
    
    // Update colleges/institutes
    if (nearbyColleges && Array.isArray(nearbyColleges)) {
      property.nearbyColleges = nearbyColleges;
      console.log(`✅ Updated ${nearbyColleges.length} colleges`);
    }
    
    if (nearbyUniversities && Array.isArray(nearbyUniversities)) {
      property.nearbyUniversities = nearbyUniversities;
      console.log(`✅ Updated ${nearbyUniversities.length} universities`);
    }
    
    if (nearbyInstitutes && Array.isArray(nearbyInstitutes)) {
      property.nearbyInstitutes = nearbyInstitutes;
      console.log(`✅ Updated ${nearbyInstitutes.length} institutes`);
    }
    
    // Add metadata
    property.collegesUpdatedAt = new Date();
    property.collegesSource = 'overpass_api';
    
    await property.save();
    
    console.log(`💾 Successfully saved colleges for property: ${property.propertyName}`);
    
    res.json({
      success: true,
      message: 'Colleges updated successfully',
      data: {
        propertyId: property._id || property.visitId,
        propertyName: property.propertyName,
        nearbyColleges: property.nearbyColleges,
        nearbyUniversities: property.nearbyUniversities,
        nearbyInstitutes: property.nearbyInstitutes,
        updatedAt: property.collegesUpdatedAt
      }
    });
    
  } catch (error) {
    console.error('❌ Error updating property colleges:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Get all unique colleges from all properties (for filter)
router.get('/colleges', async (req, res) => {
  try {
    console.log('📋 Fetching all colleges from database');
    
    // Get colleges from both collections
    const [websiteProperties, approvedProperties] = await Promise.all([
      WebsiteProperty.find({ nearbyColleges: { $exists: true, $ne: [] } })
        .select('nearbyColleges nearbyUniversities nearbyInstitutes propertyName'),
      ApprovedProperty.find({ nearbyColleges: { $exists: true, $ne: [] } })
        .select('nearbyColleges nearbyUniversities nearbyInstitutes propertyName')
    ]);
    
    // Combine all colleges
    const allColleges = new Set();
    const allUniversities = new Set();
    const allInstitutes = new Set();
    
    [...websiteProperties, ...approvedProperties].forEach(property => {
      if (property.nearbyColleges) {
        property.nearbyColleges.forEach(college => allColleges.add(college));
      }
      if (property.nearbyUniversities) {
        property.nearbyUniversities.forEach(university => allUniversities.add(university));
      }
      if (property.nearbyInstitutes) {
        property.nearbyInstitutes.forEach(institute => allInstitutes.add(institute));
      }
    });
    
    const result = {
      colleges: Array.from(allColleges).sort(),
      universities: Array.from(allUniversities).sort(),
      institutes: Array.from(allInstitutes).sort(),
      totalProperties: websiteProperties.length + approvedProperties.length,
      totalColleges: allColleges.size,
      totalUniversities: allUniversities.size,
      totalInstitutes: allInstitutes.size
    };
    
    console.log(`✅ Found ${result.totalColleges} colleges, ${result.totalUniversities} universities, ${result.totalInstitutes} institutes`);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('❌ Error fetching colleges:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

module.exports = router;
