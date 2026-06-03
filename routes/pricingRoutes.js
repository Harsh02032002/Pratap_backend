const express = require('express');
const router = express.Router();
const PricingPlan = require('../models/PricingPlan');

// Get all pricing plans
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    
    const plans = await PricingPlan.find(filter).sort({ price: 1 });
    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('Error fetching pricing plans:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pricing plans' });
  }
});

// Create pricing plan
router.post('/', async (req, res) => {
  try {
    const { name, description, price, billingCycle, features, maxProperties, maxPhotos, prioritySupport, analytics, customBranding, isPopular, status } = req.body;
    
    if (!name || !price) {
      return res.status(400).json({ success: false, message: 'Name and price are required' });
    }
    
    const plan = new PricingPlan({
      name,
      description: description || '',
      price,
      billingCycle: billingCycle || 'monthly',
      features: features || [],
      maxProperties: maxProperties || 1,
      maxPhotos: maxPhotos || 10,
      prioritySupport: prioritySupport || false,
      analytics: analytics || false,
      customBranding: customBranding || false,
      isPopular: isPopular || false,
      status: status || 'Active'
    });
    
    await plan.save();
    res.status(201).json({ success: true, data: plan });
  } catch (error) {
    console.error('Error creating pricing plan:', error);
    res.status(500).json({ success: false, message: 'Failed to create pricing plan' });
  }
});

// Update pricing plan
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    
    const plan = await PricingPlan.findByIdAndUpdate(id, updateData, { new: true });
    
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Pricing plan not found' });
    }
    
    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('Error updating pricing plan:', error);
    res.status(500).json({ success: false, message: 'Failed to update pricing plan' });
  }
});

// Delete pricing plan
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const plan = await PricingPlan.findByIdAndDelete(id);
    
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Pricing plan not found' });
    }
    
    res.json({ success: true, message: 'Pricing plan deleted successfully' });
  } catch (error) {
    console.error('Error deleting pricing plan:', error);
    res.status(500).json({ success: false, message: 'Failed to delete pricing plan' });
  }
});

module.exports = router;
