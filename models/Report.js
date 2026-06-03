const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  ownerLoginId: {
    type: String,
    required: true,
    index: true
  },
  reportName: {
    type: String,
    required: true
  },
  generatedAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed', 'Failed'],
    default: 'Completed'
  },
  fileUrl: {
    type: String,
    default: '' // In a real system, this would be an S3 URL or similar
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

module.exports = mongoose.model('Report', reportSchema);
