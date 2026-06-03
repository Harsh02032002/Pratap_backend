const express = require('express');
const router = express.Router();
const FeaturedListing = require('../models/FeaturedListing');
const Property = require('../models/Property');

// Get all featured listings
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status === 'active') filter.isActive = true;
    if (status === 'expired') filter.endDate = { $lt: new Date() };
    
    const listings = await FeaturedListing.find(filter).sort({ position: 1, createdAt: -1 });
    res.json({ success: true, data: listings });
  } catch (error) {
    console.error('Error fetching featured listings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch featured listings' });
  }
});

// Get available properties for featuring
router.get('/available-properties', async (req, res) => {
  try {
    const properties = await Property.find({ isPublished: true })
      .select('title locationCode city address photos')
      .limit(50);
    
    const available = properties.map(p => ({
      _id: p._id,
      title: p.title,
      locationCode: p.locationCode,
      city: p.city,
      address: p.address,
      image: p.photos?.[0] || ''
    }));
    
    res.json({ success: true, data: available });
  } catch (error) {
    console.error('Error fetching available properties:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch properties' });
  }
});

// Create featured listing
router.post('/', async (req, res) => {
  try {
    const { propertyId, propertyTitle, propertyImage, city, startDate, endDate, position, paymentAmount, paymentStatus, notes } = req.body;
    
    if (!propertyId || !propertyTitle || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Property, title, start date and end date are required' });
    }
    
    const listing = new FeaturedListing({
      propertyId,
      propertyTitle,
      propertyImage: propertyImage || '',
      city: city || '',
      startDate,
      endDate,
      position: position || 0,
      paymentAmount: paymentAmount || 0,
      paymentStatus: paymentStatus || 'pending',
      notes: notes || ''
    });
    
    await listing.save();
    res.status(201).json({ success: true, data: listing });
  } catch (error) {
    console.error('Error creating featured listing:', error);
    res.status(500).json({ success: false, message: 'Failed to create featured listing' });
  }
});

// Update featured listing
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    
    const listing = await FeaturedListing.findByIdAndUpdate(id, updateData, { new: true });
    
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Featured listing not found' });
    }
    
    res.json({ success: true, data: listing });
  } catch (error) {
    console.error('Error updating featured listing:', error);
    res.status(500).json({ success: false, message: 'Failed to update featured listing' });
  }
});

// Delete featured listing
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await FeaturedListing.findByIdAndDelete(id);
    
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Featured listing not found' });
    }
    
    res.json({ success: true, message: 'Featured listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting featured listing:', error);
    res.status(500).json({ success: false, message: 'Failed to delete featured listing' });
  }
});

// Track view
router.post('/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await FeaturedListing.findByIdAndUpdate(
      id,
      { $inc: { views: 1 } },
      { new: true }
    );
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Featured listing not found' });
    }
    res.json({ success: true, views: listing.views });
  } catch (error) {
    console.error('Error tracking view:', error);
    res.status(500).json({ success: false, message: 'Failed to track view' });
  }
});

// Track click
router.post('/:id/click', async (req, res) => {
  try {
    const { id } = req.params;
    const listing = await FeaturedListing.findByIdAndUpdate(
      id,
      { $inc: { clicks: 1 } },
      { new: true }
    );
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Featured listing not found' });
    }
    res.json({ success: true, clicks: listing.clicks });
  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).json({ success: false, message: 'Failed to track click' });
  }
});

module.exports = router;
