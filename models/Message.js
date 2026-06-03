const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  participant: { type: String, required: true, index: true }, // e.g., employee loginId
  messages: [
    {
      from: { type: String, required: true }, // sender id
      text: { type: String }, // optional for non-text messages
      time: { type: String },
      type: { type: String, default: 'text' }, // 'text' | 'call' | 'video' | 'meeting' | 'system'
      meta: { type: mongoose.Schema.Types.Mixed }, // arbitrary metadata (meetingId, recordingUrl, etc.)
      createdAt: { type: Date, default: Date.now }
    }
  ],
  updatedAt: { type: Date, default: Date.now },
  headOnly: { type: Boolean, default: false } // when true, only superadmin can reply
});

module.exports = mongoose.model('Message', messageSchema);
