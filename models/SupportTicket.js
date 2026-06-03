const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
  ticket_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true
  },
  room_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatRoom',
    required: true,
    index: true
  },
  user_id: {
    type: String,
    required: true,
    index: true
  },
  user_role: {
    type: String,
    enum: ['website-user', 'tenant'],
    required: true
  },
  user_name: {
    type: String,
    required: true
  },
  user_email: {
    type: String,
    default: null
  },
  user_phone: {
    type: String,
    default: null
  },
  subject: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    enum: ['technical', 'payment', 'booking', 'property', 'other'],
    default: 'other',
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
    index: true
  },
  status: {
    type: String,
    enum: ['open', 'in-progress', 'waiting-for-user', 'resolved', 'closed'],
    default: 'open',
    index: true
  },
  assigned_to: {
    type: String,
    default: null,
    index: true
  },
  assigned_to_name: {
    type: String,
    default: null
  },
  property_id: {
    type: String,
    default: null
  },
  booking_id: {
    type: String,
    default: null
  },
  attachments: [{
    filename: String,
    url: String,
    size: Number,
    uploaded_at: Date
  }],
  resolution_notes: {
    type: String,
    default: null
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  assigned_at: {
    type: Date,
    default: null
  },
  resolved_at: {
    type: Date,
    default: null
  },
  closed_at: {
    type: Date,
    default: null
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes for performance
supportTicketSchema.index({ ticket_id: 1 });
supportTicketSchema.index({ user_id: 1, status: 1 });
supportTicketSchema.index({ assigned_to: 1, status: 1 });
supportTicketSchema.index({ created_at: -1 });
supportTicketSchema.index({ category: 1, priority: 1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
