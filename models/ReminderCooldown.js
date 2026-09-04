'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Throttle record for the owner's "Send reminders" bulk action.
 *
 * Persisted rather than held in memory or in the browser for two reasons the
 * client asked for explicitly: the countdown must survive a backend restart,
 * and it must not be bypassable by clearing localStorage or opening another
 * browser. The server is the only authority on when the next send is allowed.
 *
 * Scoped per owner AND per property, because the Rent Collection page is
 * filtered by the active property — reminding one property must not lock the
 * owner out of reminding another. `propertyId` is null for the "All properties"
 * view; MongoDB treats null as a value in a unique index, so that is its own
 * distinct slot rather than a wildcard.
 */
const reminderCooldownSchema = new Schema({
  // The owner's User._id — the same identity every rent-collection route uses.
  ownerId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', default: null },

  lastSentAt: { type: Date, required: true },
  sentCount:  { type: Number, default: 0 },
}, {
  timestamps: true,
  collection: 'reminder_cooldowns',
});

// One slot per owner+property. The unique constraint is what makes the atomic
// claim in the controller race-safe against double-clicks and two open tabs.
reminderCooldownSchema.index({ ownerId: 1, propertyId: 1 }, { unique: true });

module.exports = mongoose.models.ReminderCooldown
  || mongoose.model('ReminderCooldown', reminderCooldownSchema);
