const mongoose = require('mongoose');

const ChatViolationSchema = new mongoose.Schema({
  participantLoginId: { type: String, required: true },
  participantName: { type: String },
  ownerId: { type: String },
  ownerName: { type: String },
  tenantId: { type: String },
  tenantName: { type: String },
  conversationId: { type: String }, // room_id
  violationType: { 
    type: String, 
    enum: ['spam', 'abuse', 'contact_sharing', 'external_settlement', 'commission_bypass', 'other'], 
    required: true 
  },
  status: {
    type: String,
    enum: ['New', 'Reviewed', 'Warning Sent', 'Resolved'],
    default: 'New'
  },
  attemptNumber: { type: Number, default: 1 },
  messageSnippet: { type: String },
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', sparse: true },
  actionTaken: { type: String, enum: ['none', 'warned', 'blocked'], default: 'none' },
  actionHistory: [{
    action: { type: String },
    adminId: { type: String },
    reason: { type: String },
    timestamp: { type: Date, default: Date.now }
  }],
  resolvedBy: { type: String },
  aiConfidence: { type: Number },
  aiReason: { type: String },
  aiDecision: { type: mongoose.Schema.Types.Mixed },
  moderatedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date }
}, {
  timestamps: true
});

module.exports = mongoose.model('ChatViolation', ChatViolationSchema);
