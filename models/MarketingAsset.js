const mongoose = require('mongoose');

const marketingAssetSchema = new mongoose.Schema({
  ownerLoginId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  size: {
    type: String,
    default: 'A4 Printable PDF'
  },
  file_url: {
    type: String
  }
}, { timestamps: true });

module.exports = mongoose.model('MarketingAsset', marketingAssetSchema);
