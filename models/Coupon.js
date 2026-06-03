const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  ownerLoginId: {
    type: String,
    required: true,
    index: true
  },
  code: {
    type: String,
    required: true
  },
  discount: {
    type: String,
    required: true
  },
  usage: {
    type: String,
    default: '0 Times used'
  },
  validity: {
    type: String,
    default: 'Unlimited validity'
  },
  status: {
    type: String,
    enum: ['Active', 'Deactivated'],
    default: 'Active'
  }
}, { timestamps: true });

module.exports = mongoose.model('Coupon', couponSchema);
