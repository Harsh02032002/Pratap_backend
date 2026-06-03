const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  toRole: { type: String, default: '' }, // e.g., 'superadmin' or specific loginId
  toLoginId: { type: String, default: '' },
  from: { type: String, required: true },
  type: { type: String, default: 'info' },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Notification', NotificationSchema);
// (previous duplicate schema removed) If you need recipient-based notifications,
// add fields like `recipient` or `toLoginId` as required by your controllers.
