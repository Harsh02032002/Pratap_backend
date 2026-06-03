const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  ownerLoginId: {
    type: String,
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  priority: {
    type: String,
    enum: ['Normal', 'Important'],
    default: 'Normal'
  },
  date: {
    type: String
  }
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
