const mongoose = require('mongoose');

/**
 * VisitSubmitClaim — one short-lived lock per "this exact report, just now".
 *
 * WHY A COLLECTION AND NOT AN `if`
 * ────────────────────────────────
 * The obvious duplicate guard is "look for a matching recent report, and skip
 * if one exists". That is a read followed by a write, and the gap between them
 * is a race: measured against the running server, five simultaneous submits of
 * the same report all read "nothing here yet" and all inserted, producing five
 * visit reports AND five Owner records with five different loginIds — the
 * owner's identity fragmented across all of them.
 *
 * A unique index cannot race. The first insert of a fingerprint wins, every
 * other one fails with E11000, and the losers look up the winner instead of
 * filing their own report.
 *
 * WHY IT EXPIRES
 * ──────────────
 * Uniqueness here must be bounded in TIME, not permanent. Re-listing the same
 * property months later is legitimate and must not be blocked — in the real
 * data, accidental duplicates were ~57 seconds apart while genuine re-listings
 * were ~20 days apart. The TTL index drops each claim once its window passes,
 * so the constraint applies only while a re-submit would still be an accident.
 *
 * MongoDB's TTL monitor sweeps about once a minute, so a claim can outlive
 * `expiresAt` by up to that long. Harmless: it only ever means the duplicate
 * window is slightly generous, never that a duplicate slips through.
 */
const VisitSubmitClaimSchema = new mongoose.Schema({
    /** Normalised property + owner identity. See buildVisitFingerprint(). */
    fingerprint: {
        type: String,
        required: true,
        unique: true
    },

    /** The report that won the claim, so losers can be pointed at it. */
    visitId: {
        type: String,
        required: true
    },

    /**
     * When this claim stops applying. `expireAfterSeconds: 0` means "delete the
     * document once this date passes" rather than "wait N seconds after it".
     */
    expiresAt: {
        type: Date,
        required: true,
        index: { expireAfterSeconds: 0 }
    }
}, { timestamps: true });

module.exports = mongoose.model('VisitSubmitClaim', VisitSubmitClaimSchema);
