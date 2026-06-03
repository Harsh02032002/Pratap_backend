const express = require('express');
const router = express.Router();
const PropertyType = require('../models/PropertyType');

// Get all property types (public)
router.get('/', async (req, res) => {
  try {
    const propertyTypes = await PropertyType.find({ status: 'Active' }).sort({ createdAt: 1 });
    res.json({ success: true, data: propertyTypes });
  } catch (error) {
    console.error('Error fetching property types:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch property types' });
  }
});

// Get single property type by category (public)
router.get('/category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const propertyType = await PropertyType.findOne({ 
      category: { $regex: new RegExp(category, 'i') },
      status: 'Active'
    });
    
    if (!propertyType) {
      return res.status(404).json({ success: false, message: 'Property type not found' });
    }
    
    res.json({ success: true, data: propertyType });
  } catch (error) {
    console.error('Error fetching property type:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch property type' });
  }
});

// Create new property type (admin only)
router.post('/', async (req, res) => {
  try {
    const { title, category, description, images } = req.body;
    
    if (!title || !category || !description || !images || images.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title, category, description, and images are required' 
      });
    }
    
    // Check if already exists
    const existing = await PropertyType.findOne({ category: { $regex: new RegExp(category, 'i') } });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Property type with this category already exists' 
      });
    }
    
    const propertyType = new PropertyType({
      title,
      category,
      description,
      images,
      status: 'Active'
    });
    
    await propertyType.save();
    res.status(201).json({ success: true, data: propertyType });
  } catch (error) {
    console.error('Error creating property type:', error);
    res.status(500).json({ success: false, message: 'Failed to create property type' });
  }
});

// Update property type (admin only)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, description, images, status } = req.body;
    
    const updateData = {};
    if (title) updateData.title = title;
    if (category) updateData.category = category;
    if (description) updateData.description = description;
    if (images) updateData.images = images;
    if (status) updateData.status = status;
    
    const propertyType = await PropertyType.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );
    
    if (!propertyType) {
      return res.status(404).json({ success: false, message: 'Property type not found' });
    }
    
    res.json({ success: true, data: propertyType });
  } catch (error) {
    console.error('Error updating property type:', error);
    res.status(500).json({ success: false, message: 'Failed to update property type' });
  }
});

// Bulk import property types (admin only)
router.post('/bulk', async (req, res) => {
  try {
    const { propertyTypes } = req.body;
    
    if (!Array.isArray(propertyTypes) || propertyTypes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'propertyTypes array is required' 
      });
    }
    
    const results = {
      created: [],
      skipped: [],
      errors: []
    };
    
    for (const type of propertyTypes) {
      try {
        if (!type.title || !type.category || !type.description || !type.images) {
          results.errors.push({ category: type.category, error: 'Missing required fields' });
          continue;
        }
        
        // Check if already exists
        const existing = await PropertyType.findOne({ 
          category: { $regex: new RegExp(type.category, 'i') } 
        });
        
        if (existing) {
          results.skipped.push(type.category);
          continue;
        }
        
        const newType = await PropertyType.create({
          title: type.title,
          category: type.category,
          description: type.description,
          images: type.images,
          status: type.status || 'Active'
        });
        
        results.created.push(type.category);
      } catch (error) {
        results.errors.push({ category: type.category, error: error.message });
      }
    }
    
    res.status(201).json({ 
      success: true, 
      message: `Bulk import completed. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`,
      data: results
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    res.status(500).json({ success: false, message: 'Failed to bulk import property types' });
  }
});

// Delete property type (admin only)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const propertyType = await PropertyType.findByIdAndDelete(id);
    
    if (!propertyType) {
      return res.status(404).json({ success: false, message: 'Property type not found' });
    }
    
    res.json({ success: true, message: 'Property type deleted successfully' });
  } catch (error) {
    console.error('Error deleting property type:', error);
    res.status(500).json({ success: false, message: 'Failed to delete property type' });
  }
});

module.exports = router;
