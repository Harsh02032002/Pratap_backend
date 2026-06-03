const Coupon = require('../models/Coupon');

exports.getCouponsByOwner = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const coupons = await Coupon.find({ ownerLoginId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, coupons });
  } catch (error) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.createCoupon = async (req, res) => {
  try {
    const { ownerLoginId, code, discount, validity } = req.body;
    
    if (!ownerLoginId || !code || !discount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const newCoupon = new Coupon({
      ownerLoginId,
      code,
      discount,
      validity: validity || 'Unlimited validity',
      usage: '0 Times used',
      status: 'Active'
    });

    await newCoupon.save();
    res.status(201).json({ success: true, coupon: newCoupon });
  } catch (error) {
    console.error('Error creating coupon:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.deactivateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const deactivatedCoupon = await Coupon.findByIdAndUpdate(id, { status: 'Deactivated' }, { new: true });
    
    if (!deactivatedCoupon) {
      return res.status(404).json({ success: false, message: 'Coupon not found' });
    }

    res.status(200).json({ success: true, coupon: deactivatedCoupon });
  } catch (error) {
    console.error('Error deactivating coupon:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};
