const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  toRole: { type: String, default: '' }, // e.g., 'superadmin' or specific loginId
  toLoginId: { type: String, default: '' },
  from: { type: String, required: true },
  type: { type: String, default: 'info' },
  // Optional severity, used by filtering/sorting in the paginated API. Older
  // documents without this field are treated as 'normal'.
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

NotificationSchema.index({ toLoginId: 1, createdAt: -1 });
NotificationSchema.index({ toRole: 1, createdAt: -1 });
NotificationSchema.index({ read: 1 });
// Composite index for the hot recipient query: scope by recipient, optionally
// filter by read state, ordered newest-first. Serves both
// `{ toLoginId }` + sort and `{ toLoginId, read }` + sort without a full scan.
NotificationSchema.index({ toLoginId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);
// (previous duplicate schema removed) If you need recipient-based notifications,
// add fields like `recipient` or `toLoginId` as required by your controllers.
