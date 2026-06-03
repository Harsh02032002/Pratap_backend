const express = require('express');
const router = express.Router();
const Amenity = require('../models/Amenity');

// Get all amenities
router.get('/', async (req, res) => {
  try {
    const { status, category } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    
    const amenities = await Amenity.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: amenities });
  } catch (error) {
    console.error('Error fetching amenities:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch amenities' });
  }
});

// Create amenity
router.post('/', async (req, res) => {
  try {
    const { name, icon, category, description, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    
    const existing = await Amenity.findOne({ name: { $regex: new RegExp(name, 'i') } });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Amenity already exists' });
    }
    
    const amenity = new Amenity({
      name,
      icon: icon || 'check',
      category: category || 'basic',
      description: description || '',
      status: status || 'Active'
    });
    
    await amenity.save();
    res.status(201).json({ success: true, data: amenity });
  } catch (error) {
    console.error('Error creating amenity:', error);
    res.status(500).json({ success: false, message: 'Failed to create amenity' });
  }
});

// Update amenity
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, icon, category, description, status } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (icon) updateData.icon = icon;
    if (category) updateData.category = category;
    if (description !== undefined) updateData.description = description;
    if (status) updateData.status = status;
    
    const amenity = await Amenity.findByIdAndUpdate(id, updateData, { new: true });
    
    if (!amenity) {
      return res.status(404).json({ success: false, message: 'Amenity not found' });
    }
    
    res.json({ success: true, data: amenity });
  } catch (error) {
    console.error('Error updating amenity:', error);
    res.status(500).json({ success: false, message: 'Failed to update amenity' });
  }
});

// Delete amenity
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const amenity = await Amenity.findByIdAndDelete(id);
    
    if (!amenity) {
      return res.status(404).json({ success: false, message: 'Amenity not found' });
    }
    
    res.json({ success: true, message: 'Amenity deleted successfully' });
  } catch (error) {
    console.error('Error deleting amenity:', error);
    res.status(500).json({ success: false, message: 'Failed to delete amenity' });
  }
});

module.exports = router;
