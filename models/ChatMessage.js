const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  room_id: {
    type: String,
    required: true,
    index: true,
    description: 'receiver\'s loginId'
  },
  sender_login_id: {
    type: String,
    required: true,
    description: 'sender\'s loginId'
  },
  sender_name: String,
  sender_role: {
    type: String,
    enum: ['property_owner', 'tenant', 'areamanager', 'website_user', 'superadmin']
  },
  message: {
    type: String,
    required: true
  },
  message_type: {
    type: String,
    enum: ['text', 'image', 'file'],
    default: 'text'
  },
  file_url: String,
  is_read: {
    type: Boolean,
    default: false
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Auto-create index for queries
chatMessageSchema.index({ room_id: 1, created_at: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
