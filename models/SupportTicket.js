const mongoose = require('mongoose');

const internalNoteSchema = new mongoose.Schema({
  note: { type: String, required: true },
  added_by: { type: String },
  added_by_name: { type: String },
  added_at: { type: Date, default: Date.now }
}, { _id: false });

const activityLogSchema = new mongoose.Schema({
  action: { type: String },
  performed_by: { type: String },
  performed_by_name: { type: String },
  from_status: { type: String },
  to_status: { type: String },
  note: { type: String },
  at: { type: Date, default: Date.now }
}, { _id: false });

const supportTicketSchema = new mongoose.Schema({
  ticket_id: {
    type: String,
    unique: true,
    index: true,
    default: () => 'TK-' + Date.now().toString(36).toUpperCase()
  },

  // ─── TICKET SOURCE / TYPE ─────────────────────────────────────────────────
  ticket_type: {
    type: String,
    enum: [
      'Tenant Complaint', 'Owner Complaint', 'Booking Dispute',
      'Payment Issue', 'Property Issue', 'Move-in Issue',
      'Refund Request', 'Technical Issue', 'Other'
    ],
    required: true,
    index: true
  },

  // ─── RAISED BY ────────────────────────────────────────────────────────────
  raised_by: { type: String, required: true },
  raised_by_name: { type: String, required: true },
  raised_by_role: {
    type: String,
    enum: ['tenant', 'website_user', 'property_owner', 'system'],
    default: 'tenant'
  },
  user_email: { type: String, default: null },
  user_phone: { type: String, default: null },

  // ─── LINKED RECORDS (Roomhy ecosystem links) ──────────────────────────────
  property_id: { type: String, default: null, index: true },
  property_name: { type: String, default: null },
  booking_id: { type: String, default: null, index: true },
  chat_room_id: { type: String, default: null },
  payment_id: { type: String, default: null },
  owner_id: { type: String, default: null, index: true },
  owner_name: { type: String, default: null },
  complaint_id: { type: String, default: null }, // link to TenantComplaint / OwnerComplaint
  city: { type: String, default: null, index: true },
  area: { type: String, default: null, index: true },
  location_code: { type: String, default: null },

  // ─── TICKET DETAILS ───────────────────────────────────────────────────────
  subject: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },

  // ─── PRIORITY & STATUS ────────────────────────────────────────────────────
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Critical'],
    default: 'Medium',
    index: true
  },
  status: {
    type: String,
    enum: ['Open', 'Assigned', 'In Progress', 'Waiting For Response', 'Resolved', 'Closed'],
    default: 'Open',
    index: true
  },

  // ─── ASSIGNMENT ───────────────────────────────────────────────────────────
  assigned_admin: { type: String, default: null, index: true },
  assigned_admin_name: { type: String, default: null },
  assigned_at: { type: Date, default: null },

  // ─── SLA TRACKING ─────────────────────────────────────────────────────────
  // SLA target in hours (based on priority: Critical=4h, High=24h, Medium=48h, Low=72h)
  sla_hours: { type: Number, default: 48 },
  sla_due_at: { type: Date, default: null },
  sla_breached: { type: Boolean, default: false },

  // ─── NOTES & LOGS ─────────────────────────────────────────────────────────
  internal_notes: [internalNoteSchema],     // Admin-only notes (never shown to user)
  resolution_notes: { type: String, default: '' },
  activity_log: [activityLogSchema],

  // ─── ATTACHMENTS ──────────────────────────────────────────────────────────
  attachments: [{
    filename: String, url: String, size: Number, uploaded_at: Date
  }],

  // ─── TIMESTAMPS ───────────────────────────────────────────────────────────
  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now },
  resolved_at: { type: Date, default: null },
  closed_at: { type: Date, default: null }
});

// ─── INDEXES ─────────────────────────────────────────────────────────────────
supportTicketSchema.index({ status: 1, priority: 1 });
supportTicketSchema.index({ created_at: -1 });
supportTicketSchema.index({ sla_due_at: 1, sla_breached: 1 });

// Auto-set SLA due date based on priority before saving
supportTicketSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  if (this.isNew) {
    const SLA_MAP = { Critical: 4, High: 24, Medium: 48, Low: 72 };
    const hours = SLA_MAP[this.priority] || 48;
    this.sla_hours = hours;
    this.sla_due_at = new Date(Date.now() + hours * 60 * 60 * 1000);
  }
  // Auto-breach check
  if (this.sla_due_at && new Date() > this.sla_due_at && !['Resolved','Closed'].includes(this.status)) {
    this.sla_breached = true;
  }
  next();
});

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
