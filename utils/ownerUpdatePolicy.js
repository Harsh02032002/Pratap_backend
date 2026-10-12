'use strict';

/**
 * ownerUpdatePolicy.js — which fields of an Owner record a given caller may
 * change through PATCH /api/owners/:loginId.
 *
 * That route does `$set: { ...req.body }`, and is reachable by the owner,
 * platform admins, and "delegates": the owner's own staff, platform employees
 * and area managers in scope (see canAccessOwner). Delegates legitimately edit
 * profile fields — the superadmin "edit owner" form is auto-mirrored to
 * /employee/owner — but must not be able to take the account over or redirect
 * its money. Three tiers:
 *
 *   SYSTEM     platform admin only; silently dropped for everyone else
 *              (status/role flags and verification state an owner must not
 *              self-certify).
 *   PROTECTED  the owner themself or a platform admin; a delegate CHANGING one
 *              is refused with 403:
 *                credentials  — the login password
 *                bank         — every payout/bank field
 *                recovery     — email and phone. Owner password-reset OTPs go
 *                               to profile.email/email (and WhatsApp to the
 *                               phone), so changing these is a password reset
 *                               by another name.
 *   anything else              allowed for every caller who reached the route.
 *
 * "Changing" matters: the edit form re-sends every field on every save, so a
 * delegate who edits only the address also sends the current bank details. A
 * protected value identical to what is stored is not a change and is allowed.
 * A password value is always a change — it cannot be compared to a hash.
 */

// Fields the route already refused to non-admins, plus verification state.
const SYSTEM_FIELDS = [
    'role', 'status', 'isDeleted', 'subscription', 'isActive', 'loginId', '_id',
    'kyc',                                   // includes kyc.status = 'verified'
    'bankDetails.isVerified', 'bankDetails.verifiedAt', 'bankDetails.cf_beneficiary_id',
    'bankLockedByVisit',
];

// Leaf paths. A payload can reach one either directly ('profile.email') or by
// setting an ancestor object ({ profile: {...} }), which under $set REPLACES
// the whole object — so omitting the leaf from that object erases it.
const PROTECTED_FIELDS = {
    credentials: ['credentials.password', 'credentials.firstTime', 'password', 'checkinPassword', 'passwordSet'],
    bank: [
        'bankName', 'accountNumber', 'ifscCode', 'branchName',
        'profile.bankName', 'profile.accountNumber', 'profile.ifscCode', 'profile.branchName',
        'checkinAccountHolderName', 'checkinUpiId', 'checkinBankAccountNumber',
        'checkinIfscCode', 'checkinBankName', 'checkinBranchName',
        'checkinBankProof', 'checkinBankProofName', 'checkinBankProofType',
        'bankDetails.accountHolderName', 'bankDetails.accountNumber', 'bankDetails.ifsc',
        'bankDetails.bankName', 'bankDetails.upiId',
    ],
    recovery: ['email', 'phone', 'profile.email', 'profile.phone', 'checkinEmail', 'checkinPhone'],
};

// Stored as hashes, so a submitted value cannot be compared with them: writing
// one at all — including blanking it — counts as a change.
const SECRET_FIELDS = ['credentials.password', 'password', 'checkinPassword'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** { 'a.b': leaf, … } for a payload that may mix nested objects and dotted keys. */
function flattenPaths(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj || {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (isPlainObject(value) && Object.keys(value).length > 0) flattenPaths(value, path, out);
        else out[path] = value;
    }
    return out;
}

/** Does writing `path` write to (or over) `field`? */
const touches = (path, field) => path === field || path.startsWith(`${field}.`) || field.startsWith(`${path}.`);

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const same = (a, b) => {
    const norm = (v) => (v === null || v === undefined ? '' : String(v).trim());
    return norm(a) === norm(b);
};

/** Removes `path` (dotted or nested) from a payload object in place. */
function stripPath(payload, path) {
    if (Object.prototype.hasOwnProperty.call(payload, path)) delete payload[path];
    const parts = path.split('.');
    let node = payload;
    for (let i = 0; i < parts.length - 1; i += 1) {
        node = node && isPlainObject(node[parts[i]]) ? node[parts[i]] : null;
        if (!node) return;
    }
    if (node) delete node[parts[parts.length - 1]];
}

/**
 * @param {object} body           the request body (not mutated)
 * @param {object} currentOwner   the stored owner (lean), for change detection
 * @param {{ isPlatformAdmin: boolean, isSelf: boolean }} caller
 * @returns {{ update: object, stripped: string[], denied: string[] }}
 *   denied lists the CATEGORY names (credentials/bank/recovery) a delegate
 *   tried to change — never the submitted values.
 */
function evaluateOwnerUpdate(body, currentOwner, { isPlatformAdmin = false, isSelf = false } = {}) {
    const update = isPlainObject(body) ? JSON.parse(JSON.stringify(body)) : {};
    if (isPlatformAdmin) return { update, stripped: [], denied: [] };

    // Remove system fields outright. A top-level one goes as a whole key — with
    // its dotted forms — because stripping only its leaves would leave e.g.
    // `kyc: {}`, which $set would write over the stored KYC.
    const stripped = [];
    for (const field of SYSTEM_FIELDS) {
        const present = Object.keys(flattenPaths(update)).some((p) => touches(p, field));
        if (!present) continue;
        stripped.push(field);
        if (!field.includes('.')) {
            for (const key of Object.keys(update)) {
                if (key === field || key.startsWith(`${field}.`)) delete update[key];
            }
        } else {
            stripPath(update, field);
        }
    }

    if (isSelf) return { update, stripped, denied: [] };

    const denied = new Set();
    for (const [category, fields] of Object.entries(PROTECTED_FIELDS)) {
        for (const field of fields) {
            const effect = effectiveSetValue(update, field);
            if (!effect.touched) continue;
            const changed = SECRET_FIELDS.includes(field)
                ? true
                : !same(effect.value, getPath(currentOwner, field));
            if (changed) denied.add(category);
        }
    }
    return { update, stripped, denied: [...denied] };
}

/**
 * What `{ $set: update }` would store at `field`, mirroring MongoDB: the
 * longest key in `update` that is `field` or an ancestor of it wins, and the
 * leaf is read from inside that key's value (undefined = erased).
 * @returns {{ touched: boolean, value?: any }}
 */
function effectiveSetValue(update, field) {
    const parts = field.split('.');
    for (let i = parts.length; i >= 1; i -= 1) {
        const key = parts.slice(0, i).join('.');
        if (Object.prototype.hasOwnProperty.call(update, key)) {
            const rest = parts.slice(i);
            const value = rest.length ? getPath(update[key], rest.join('.')) : update[key];
            return { touched: true, value };
        }
    }
    return { touched: false };
}

/** Owner document safe to send back: never a password hash. */
function ownerResponse(owner) {
    if (!owner) return owner;
    const out = typeof owner.toObject === 'function' ? owner.toObject() : JSON.parse(JSON.stringify(owner));
    if (out.credentials) delete out.credentials.password;
    delete out.checkinPassword;
    delete out.password;
    return out;
}

module.exports = { evaluateOwnerUpdate, ownerResponse, PROTECTED_FIELDS, SYSTEM_FIELDS };
