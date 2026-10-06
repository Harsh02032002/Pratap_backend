/**
 * Shared, short-lived directory of the people chat inboxes need to put a name
 * to.
 *
 * WHY THIS EXISTS
 * getInbox turns raw chat ids (ROOMHY1234, roomhyweb541955, an email) into a
 * name / phone / email / property by checking four collections in a fixed
 * order: WebsiteEnquiry, Owner, BookingRequest, User. One of the match rules
 * compares the *email hash* (roomhywebXXXXXX) — and that hash is not stored
 * anywhere, so it cannot be turned into a database query. That is why the
 * handler loaded all four collections in full.
 *
 * It did so on every call, sequentially, with every field of every document,
 * and the inbox is polled by several components. This module keeps the
 * matching logic exactly where it was (in the controller) and only changes
 * where the data comes from:
 *
 *   - one projected load of the four collections, shared by every request,
 *     refreshed at most once per TTL (default 60s);
 *   - concurrent callers during a refresh await the same promise instead of
 *     each starting their own load;
 *   - the email hash is computed once per document (`_hash`) instead of once
 *     per document per conversation per request.
 *
 * The documents are shared between requests, so callers must treat them as
 * read-only.
 *
 * Trade-off: a record created in the last TTL window may not be in the
 * directory yet, so its inbox row shows the name carried on the message
 * (sender_name) or the raw id until the next refresh.
 */
const WebsiteEnquiry = require('../models/WebsiteEnquiry');
const Owner = require('../models/Owner');
const User = require('../models/user');
const BookingRequest = require('../models/BookingRequest');
const { generateWebsiteUserIdFromEmail } = require('./chatIdentity');

const TTL_MS = Number(process.env.CHAT_DIRECTORY_TTL_MS) || 60 * 1000;

// Every field getInbox reads from each source — nothing else is loaded.
// Keep these in sync with the matching block in controllers/chatController.js.
const FIELDS = {
    websiteEnquiries: 'owner_email owner_name owner_phone property_name city name email phone',
    owners: 'loginId name owner_name email owner_email phone owner_phone property_name city',
    bookings: 'email user_id name phone property_name city',
    users: 'email loginId fullName name firstName lastName phone'
};

let cached = null;
let cachedAt = 0;
let inflight = null;

const attachEmailHash = (docs, emailField) => {
    for (const doc of docs) {
        const email = doc[emailField];
        doc._hash = email ? generateWebsiteUserIdFromEmail(email) : '';
    }
    return docs;
};

async function loadDirectory() {
    const [websiteEnquiries, owners, bookings, users] = await Promise.all([
        WebsiteEnquiry.find({}).select(FIELDS.websiteEnquiries).lean(),
        Owner.find({}).select(FIELDS.owners).lean(),
        BookingRequest.find({}).select(FIELDS.bookings).lean(),
        User.find({}).select(FIELDS.users).lean()
    ]);

    return {
        websiteEnquiries: attachEmailHash(websiteEnquiries, 'owner_email'),
        owners,
        bookings: attachEmailHash(bookings, 'email'),
        users: attachEmailHash(users, 'email')
    };
}

/**
 * @returns {Promise<{websiteEnquiries: object[], owners: object[], bookings: object[], users: object[]}>}
 */
async function getChatDirectory() {
    if (cached && Date.now() - cachedAt < TTL_MS) return cached;
    if (inflight) return inflight;

    inflight = loadDirectory()
        .then((directory) => {
            cached = directory;
            cachedAt = Date.now();
            return directory;
        })
        .catch((err) => {
            // A failed refresh should not take the inbox down when a previous
            // copy is available — names a minute old beat a 500.
            if (cached) {
                console.warn('chatDirectoryCache refresh failed, serving previous copy:', err.message);
                return cached;
            }
            throw err;
        })
        .finally(() => {
            inflight = null;
        });

    return inflight;
}

/** Drop the cached copy so the next call reloads. */
function invalidateChatDirectory() {
    cached = null;
    cachedAt = 0;
}

module.exports = { getChatDirectory, invalidateChatDirectory };
