const mongoose = require('mongoose');

const gateSchema = new mongoose.Schema({
  ownerLoginId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['Unlocked', 'Locked'],
    default: 'Unlocked'
  }
}, { timestamps: true });

module.exports = mongoose.model('Gate', gateSchema);
