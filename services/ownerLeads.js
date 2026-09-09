const BookingRequest = require('../models/BookingRequest');
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const Tenant = require('../models/Tenant');

// ─────────────────────────────────────────────────────────────────────────────
// Owner leads
//
// A lead reaches an owner through two collections: Enquiry (created inside the
// panel) and BookingRequest (created by the website — direct bookings and bids).
// Anything showing "leads" has to read both, and has to accept that a property
// is identified three different ways depending on who wrote the record:
//
//   _id           the owner panel's id for the property
//   visitId       what the website carries, since its listings come from visits
//   property_name the tier-decorated display name ("ROOMHYPROP CREST Foo"),
//                 which contains but does not equal the panel's plain title
//
// The owner enquiries endpoint had all of this inline. The dashboard had none of
// it — it read Enquiry alone, so website bookings never reached Recent Leads.
// Both now come through here so the two can no longer disagree.
// ─────────────────────────────────────────────────────────────────────────────

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every id and name the owner's properties are known by, across both collections. */
async function resolveOwnerPropertyIdentity(ownerIdCandidates, normalizedOwnerId) {
    try {
        const [regularProps, approvedProps] = await Promise.all([
            Property.find({
                $or: [
                    { ownerLoginId: { $in: ownerIdCandidates } },
                    { owner_id: { $in: ownerIdCandidates } }
                ]
            }).select('_id visitId title propertyName city locality').lean(),
            ApprovedProperty.find({
                $or: [
                    { ownerLoginId: { $in: ownerIdCandidates } },
                    { 'generatedCredentials.loginId': { $in: ownerIdCandidates } },
                    { 'propertyInfo.ownerLoginId': { $in: ownerIdCandidates } },
                    { owner_id: { $in: ownerIdCandidates } },
                    { owner: { $in: ownerIdCandidates } }
                ]
            }).select('_id visitId propertyName title propertyInfo.name').lean()
        ]);

        const allProps = [...regularProps, ...approvedProps];
        return {
            propIds: allProps.map(p => String(p._id)),
            propVisitIds: allProps.map(p => p.visitId).filter(Boolean),
            propNames: allProps.map(p => p.propertyName || p.title || p.propertyInfo?.name).filter(Boolean),
            ownerCities: allProps.map(p => p.city || p.propertyInfo?.city).filter(Boolean).map(c => String(c).toLowerCase().trim())
        };
    } catch (_) {
        return { propIds: [], propVisitIds: [], propNames: [], ownerCities: [] };
    }
}

/** The ids and names one specific property is known by — used to scope the dashboard. */
async function resolvePropertyIdentity(propertyId) {
    const id = String(propertyId || '').trim();
    if (!id) return null;

    let doc = null;
    try {
        doc = await Property.findById(id).select('_id visitId title propertyName').lean();
        if (!doc) doc = await ApprovedProperty.findById(id).select('_id visitId title propertyName propertyInfo.name').lean();
    } catch (_) {
        // A non-ObjectId scope value simply has no document to widen from.
    }

    const ids = [id];
    const names = [];
    if (doc) {
        if (doc.visitId) ids.push(String(doc.visitId));
        [doc.propertyName, doc.title, doc.propertyInfo?.name].forEach(n => { if (n) names.push(String(n)); });
    }
    return { ids: [...new Set(ids)], names: [...new Set(names)] };
}

/** Mongo query selecting every BookingRequest that belongs to this owner. */
function buildOwnerBookingQuery({ ownerIdCandidates, normalizedOwnerId, identity }) {
    const { propIds, propVisitIds, propNames, ownerCities } = identity;

    const query = {
        $or: [
            { owner_id: { $in: ownerIdCandidates } },
            { owner_ids: { $in: ownerIdCandidates } }
        ]
    };

    const ownerIdPattern = normalizedOwnerId
        ? new RegExp(`^${escapeRegex(normalizedOwnerId)}$`, 'i')
        : null;
    if (ownerIdPattern) {
        query.$or.push({ owner_id: ownerIdPattern }, { owner_ids: ownerIdPattern });
    }

    if (propIds.length > 0) query.$or.push({ property_id: { $in: propIds } });
    if (propVisitIds.length > 0) query.$or.push({ property_id: { $in: propVisitIds } });
    // Containment, not equality — the website stores the tier-decorated name.
    propNames.forEach(name => {
        if (name) query.$or.push({ property_name: new RegExp(escapeRegex(name), 'i') });
    });

    // Open city bids, but only when they are not assigned to a different owner.
    ownerCities.forEach(city => {
        query.$or.push({
            $and: [
                { request_type: 'bid' },
                { $or: [{ city: new RegExp(escapeRegex(city), 'i') }, { 'filter_criteria.city': new RegExp(escapeRegex(city), 'i') }] },
                {
                    $or: [
                        { property_id: { $in: propIds } },
                        { property_id: { $exists: false } },
                        { property_id: null },
                        { property_id: '' },
                        { owner_id: { $in: ownerIdCandidates } }
                    ]
                }
            ]
        });
    });

    return query;
}

/** Narrow already-fetched bookings to one property, tolerating all three id/name forms. */
function scopeBookingsToProperty(bookings, propertyIdentity) {
    if (!propertyIdentity) return bookings;
    const { ids, names } = propertyIdentity;
    const idSet = new Set(ids.map(v => String(v).trim().toLowerCase()));
    const namePatterns = names.map(n => new RegExp(escapeRegex(n), 'i'));

    return bookings.filter(b => {
        const bId = String(b.property_id || '').trim().toLowerCase();
        if (bId && idSet.has(bId)) return true;
        const bName = String(b.property_name || '');
        return Boolean(bName) && namePatterns.some(re => re.test(bName));
    });
}

function dedupeBookingLeads(bookings = []) {
    const seenKeys = new Set();
    const result = [];
    const sorted = [...bookings].sort((a, b) => new Date(b.created_at || b.createdAt || b.updatedAt || 0) - new Date(a.created_at || a.createdAt || a.updatedAt || 0));

    for (const booking of sorted) {
        const idKey = String(booking._id || '');
        const phone = String(booking.phone || booking.studentPhone || '').replace(/\D/g, '');
        const email = String(booking.email || booking.studentEmail || '').toLowerCase().trim();
        const propKey = String(booking.property_id || booking.property_name || 'all').toLowerCase().trim();

        const phoneKey = phone ? `phone_${phone}_${propKey}` : null;
        const emailKey = email ? `email_${email}_${propKey}` : null;

        if (idKey && seenKeys.has(`id_${idKey}`)) continue;
        if (phoneKey && seenKeys.has(phoneKey)) continue;
        if (emailKey && seenKeys.has(emailKey)) continue;

        if (idKey) seenKeys.add(`id_${idKey}`);
        if (phoneKey) seenKeys.add(phoneKey);
        if (emailKey) seenKeys.add(emailKey);

        result.push(booking);
    }
    return result;
}

/** Phone/email of everyone who already moved in, so their lead reads "confirmed". */
async function loadMovedInIndex(ownerIdCandidates) {
    try {
        const tenants = await Tenant.find({
            ownerLoginId: { $in: ownerIdCandidates },
            isDeleted: { $ne: true }
        }).select('phone email').lean();

        return {
            phones: new Set(tenants.map(t => String(t.phone || '').replace(/\D/g, '')).filter(Boolean)),
            emails: new Set(tenants.map(t => String(t.email || '').toLowerCase().trim()).filter(Boolean))
        };
    } catch (_) {
        return { phones: new Set(), emails: new Set() };
    }
}

/** BookingRequest -> the Enquiry-shaped lead every owner surface renders. */
function mapBookingToLead(b, movedIn = { phones: new Set(), emails: new Set() }) {
    const cleanPhone = String(b.phone || '').replace(/\D/g, '');
    const cleanEmail = String(b.email || '').toLowerCase().trim();
    const isMovedIn = (cleanPhone && movedIn.phones.has(cleanPhone)) || (cleanEmail && movedIn.emails.has(cleanEmail));
    const typeLabel = b.request_type ? (b.request_type.charAt(0).toUpperCase() + b.request_type.slice(1)) : 'Website';
    const bidAmount = (b.bid_amount && b.bid_amount > 0 ? b.bid_amount : b.bid_max) || 0;

    return {
        _id: b._id,
        ownerLoginId: b.owner_id,
        propertyId: b.property_id,
        propertyName: b.property_name,
        studentId: b.user_id,
        studentName: b.name,
        studentEmail: b.email,
        studentPhone: b.phone,
        city: b.city || b.filter_criteria?.city || '',
        area: b.area || b.filter_criteria?.area || b.filter_criteria?.location || '',
        notes: b.message || (b.request_type === 'direct'
            ? 'Direct booking request from website'
            : (bidAmount > 0
                ? `Tenant Max Budget: ₹${bidAmount.toLocaleString('en-IN')}. If you can offer this property for ₹${bidAmount.toLocaleString('en-IN')}/month, please accept the bid.`
                : 'Tenant Bid: Open for Bid / Negotiable. Please accept to connect.')),
        preferredCity: b.city || b.filter_criteria?.city || '',
        preferredArea: b.area || b.filter_criteria?.area || b.filter_criteria?.location || '',
        location: b.area ? (b.city ? `${b.area}, ${b.city}` : b.area) : (b.city || ''),
        status: isMovedIn ? 'confirmed' : (b.booking_status || b.status || 'pending'),
        paidAmount: b.payment_amount || b.rent_amount || b.total_amount || 0,
        ts: b.updatedAt || b.updated_at || b.created_at || b.createdAt || new Date(),
        source: typeLabel,
        type: typeLabel,
        interest: typeLabel,
        bidAmount: b.bid_amount || b.bid_max || null,
        isBid: b.request_type === 'bid',
        budget: (() => {
            if (b.request_type === 'bid') {
                if (b.message) {
                    const match = String(b.message).match(/₹([\d,]+)/);
                    if (match && match[1]) {
                        const val = parseInt(match[1].replace(/,/g, ''), 10);
                        if (val > 0) return `₹${val.toLocaleString('en-IN')}`;
                    }
                }
                if (b.bid_amount && b.bid_amount > 0) return `₹${b.bid_amount.toLocaleString('en-IN')}`;
                if (b.bid_max && b.bid_max > 0) return `₹${b.bid_max.toLocaleString('en-IN')}`;
                if (b.filter_criteria?.max_price) return `₹${Number(b.filter_criteria.max_price).toLocaleString('en-IN')}`;
                return 'Flexible / Negotiable';
            }
            return b.rent_amount ? `₹${Number(b.rent_amount).toLocaleString('en-IN')}` : 'N/A';
        })(),
        isBookingRequest: true
    };
}

/**
 * Website leads for one owner, already shaped like Enquiry documents.
 *
 * @param {object}   opts
 * @param {string[]} opts.ownerIdCandidates  normalized + literal login id
 * @param {string}   opts.normalizedOwnerId
 * @param {string}   [opts.propertyId]       narrow to one property
 * @param {number}   [opts.limit]
 * @param {Function} [opts.wrap]             query wrapper, e.g. withReadDeadline
 */
async function fetchOwnerBookingLeads({ ownerIdCandidates, normalizedOwnerId, propertyId = null, limit = 100, wrap = (q) => q }) {
    const identity = await resolveOwnerPropertyIdentity(ownerIdCandidates, normalizedOwnerId);
    const [bookings, movedIn, propertyIdentity] = await Promise.all([
        wrap(BookingRequest.find(buildOwnerBookingQuery({ ownerIdCandidates, normalizedOwnerId, identity })).sort({ created_at: -1 }).limit(limit)).lean(),
        loadMovedInIndex(ownerIdCandidates),
        propertyId ? resolvePropertyIdentity(propertyId) : Promise.resolve(null)
    ]);

    return dedupeBookingLeads(scopeBookingsToProperty(bookings, propertyIdentity)).map(b => mapBookingToLead(b, movedIn));
}

module.exports = {
    escapeRegex,
    resolveOwnerPropertyIdentity,
    resolvePropertyIdentity,
    buildOwnerBookingQuery,
    scopeBookingsToProperty,
    loadMovedInIndex,
    mapBookingToLead,
    dedupeBookingLeads,
    fetchOwnerBookingLeads
};
