'use strict';

/**
 * sessionRevocation.js — makes "deactivate" actually end existing sessions.
 *
 * WHY A SCHEMA PLUGIN AND NOT ~20 CALL-SITE EDITS
 * -----------------------------------------------
 * Account state is written from a very large number of places: the explicit
 * deactivate/reactivate endpoints, the soft-delete endpoints, the property
 * cascade delete, move-out completion, chat moderation (block, strike-2 and the
 * async moderation worker), and several crons. Incrementing a token generation
 * at each of those sites would mean editing every one of them and would silently
 * regress the moment somebody adds the twenty-first.
 *
 * So the increment lives in the model layer instead: any write that puts an
 * account INTO a revoked state also bumps `tokenVersion` in the very same
 * update document, which makes it atomic and therefore safe under concurrent
 * writers, and visible to every application instance as soon as it commits.
 *
 * WHAT IT GIVES, AND WHAT IT DOES NOT
 * -----------------------------------
 * `tokenVersion` is NOT what blocks a deactivated account on the next request —
 * utils/accountState.js reading the live document does that, for every write
 * path, with no bookkeeping. What `tokenVersion` adds is the thing a status
 * check cannot do on its own:
 *
 *   - Reactivation safety. The codebase reactivates accounts automatically in
 *     several places (login auto-heal, the chat-moderation heal loop, the demo
 *     reset cron, onboarding-payment finalisation). Without a generation
 *     counter, every one of those would hand a revoked token its access back,
 *     because the status check would simply start passing again.
 *   - Force logout of a still-active account, which has no other mechanism.
 *
 * Reactivation deliberately does NOT decrement, so a token minted before a
 * deactivation stays dead forever.
 *
 * Not covered, by design: Model.bulkWrite() bypasses Mongoose middleware
 * entirely. The only bulkWrite on an account model in this repo
 * (utils/moderationHelper.js) un-blocks rather than blocks, so it needs no
 * bump. A future bulkWrite that REVOKES must call revokeSessions() itself.
 */

const { REVOKED_STATUSES } = require('../../utils/accountState');

const UPDATE_HOOKS = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'];

/** Does this $set/$setOnInsert/top-level payload move the account into a revoked state? */
function writesRevokedState(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.isActive === false) return true;
    if (payload.isDeleted === true) return true;
    const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
    return !!status && REVOKED_STATUSES.has(status);
}

module.exports = function sessionRevocation(schema) {
    schema.add({
        // Bumped on every revoking write. Tokens carry it as the `tv` claim.
        tokenVersion: { type: Number, default: 0 },
        // Set when the account is put into a revoked state. Distinguishes a
        // DELIBERATE deactivation from the historical User/Owner mirror drift
        // that the login handler auto-heals, so that auto-heal can refuse to
        // resurrect an account an administrator actually switched off.
        deactivatedAt: { type: Date, default: null },
    });

    schema.pre(UPDATE_HOOKS, function bumpOnRevokingUpdate() {
        const update = this.getUpdate();
        if (!update || Array.isArray(update)) return; // aggregation-pipeline update: not handled

        const revoking = writesRevokedState(update.$set)
            || writesRevokedState(update.$setOnInsert)
            || writesRevokedState(update);

        if (!revoking) return;

        this.setUpdate({
            ...update,
            $inc: { ...(update.$inc || {}), tokenVersion: 1 },
            $set: { ...(update.$set || {}), deactivatedAt: new Date() },
        });
    });

    schema.pre('save', function bumpOnRevokingSave(next) {
        // On insert there is no session to revoke; starting at 0 keeps brand-new
        // accounts on the "legacy token" path rather than one version ahead.
        if (this.isNew) return next();

        const touched = this.isModified('isActive') || this.isModified('isDeleted') || this.isModified('status');
        if (touched && writesRevokedState(this)) {
            this.tokenVersion = (Number.isFinite(this.tokenVersion) ? this.tokenVersion : 0) + 1;
            this.deactivatedAt = new Date();
        }
        return next();
    });

    /**
     * Force logout: end every existing session for this account without
     * changing whether it is allowed to log back in.
     */
    schema.statics.revokeSessions = function revokeSessions(filter) {
        return this.updateOne(filter, { $inc: { tokenVersion: 1 } });
    };
};

module.exports.writesRevokedState = writesRevokedState;
