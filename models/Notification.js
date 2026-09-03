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

const Notification = mongoose.model('Notification', NotificationSchema);

// ── Ex-tenant guard ──────────────────────────────────────────────────────────
// Wrapping create() here rather than editing the ~20 call sites keeps the
// suppression rule in one place and makes it impossible to miss a new one.
// Returns null instead of throwing so existing callers (many of which do not
// await or catch) behave exactly as before.
const _create = Notification.create.bind(Notification);
Notification.create = async function guardedCreate(docs, ...rest) {
    try {
        const { isRecipientSuppressed } = require('../services/tenantCommsGuard');
        const check = async (d) =>
            d?.toLoginId ? !(await isRecipientSuppressed({ loginId: d.toLoginId })) : true;

        if (Array.isArray(docs)) {
            const verdicts = await Promise.all(docs.map(check));
            const kept = docs.filter((_, i) => verdicts[i]);
            if (!kept.length) return [];
            return _create(kept, ...rest);
        }
        if (!(await check(docs))) return null;
    } catch (e) {
        // Fail open — a guard error must never swallow a notification.
        console.error('[Notification] comms guard skipped:', e.message);
    }
    return _create(docs, ...rest);
};

module.exports = Notification;
// (previous duplicate schema removed) If you need recipient-based notifications,
// add fields like `recipient` or `toLoginId` as required by your controllers.
