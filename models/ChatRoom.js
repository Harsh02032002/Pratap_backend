const mongoose = require('mongoose');

const chatRoomSchema = new mongoose.Schema({
  room_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
    description: 'receiver\'s loginId'
  },
  participants: [{
    loginId: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['property_owner', 'tenant', 'areamanager', 'website_user', 'superadmin'],
      required: true
    }
  }],
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('ChatRoom', chatRoomSchema);