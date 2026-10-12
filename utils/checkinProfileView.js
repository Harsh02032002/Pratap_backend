'use strict';

/**
 * checkinProfileView.js — what GET /api/checkin/tenant/profile/:loginId may
 * return.
 *
 * That endpoint is deliberately reachable WITHOUT a login: tenants open it
 * from an emailed check-in link (?loginId=…) before they have any session. A
 * loginId is guessable, so whatever this returns in "public" mode is
 * effectively public. It used to return the whole tenant document, re-surfacing
 * the Aadhaar number under several aliases plus the Aadhaar card photos.
 *
 * Two views:
 *   public    — no Aadhaar number, no card images, no signatures. Only
 *               `aadhaarMasked` ("XXXX XXXX 1234") and `aadhaarLast4`.
 *   sensitive — the caller presented a valid check-in access proof (issued by
 *               a successful KYC OTP — services/checkinAccessService.js). Adds
 *               `kycDocuments` (the tenant's own uploaded card images) so a
 *               returning tenant can view/replace them. Still NO full number:
 *               the flow never needs it, and the KYC page refills it from the
 *               card image by OCR.
 *
 * Pure function over a plain (lean) object so it can be tested without a DB.
 */

const { firstAadhaar, maskAadhaar, aadhaarLast4 } = require('./aadhaarMask');

// Every path that can hold an Aadhaar number, an Aadhaar card image, a
// signature, or an OTP/credential internal. `.lean()` returns whatever is
// stored in Mongo — including legacy top-level fields the current schema no
// longer declares — so those are listed too.
const REMOVED_PATHS = [
    'tempPassword',
    // legacy / alias top-level fields
    'aadhaarNumber', 'aadhar', 'aadhaar', 'idProofNumber', 'idProof',
    'idProofFile', 'aadhaarFront', 'aadhaarBack',
    // kyc sub-document
    'kyc.aadhar', 'kyc.aadhaarNumber', 'kyc.aadhaarLinkedPhone', 'kyc.aadharFile',
    'kyc.aadhaarFront', 'kyc.aadhaarBack', 'kyc.idProofFile', 'kyc.alternateProofFile',
    'kyc.addressProofFile', 'kyc.aadhaarData', 'kyc.otpVerified', 'kyc.otpVerifiedAt',
    'kyc.mismatchReasons',
    // owner-entered expected values used for the KYC comparison
    'kycVerificationData.adminEnteredAadhaar',
    // check-in copies
    'digitalCheckin.kyc', 'digitalCheckin.documents',
    'digitalCheckin.agreement.signatureDataUrl',
    'agreementExtensions.tenantSignatureDataUrl',
    'agreementRequestId', 'agreementESignName',
];

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Deletes `path` from `obj`, walking into arrays element by element. */
function removePath(obj, parts) {
    if (obj == null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        obj.forEach((item) => removePath(item, parts));
        return;
    }
    const [head, ...rest] = parts;
    if (!(head in obj)) return;
    if (rest.length === 0) delete obj[head];
    else removePath(obj[head], rest);
}

/**
 * The owner-set / previously-submitted number, in the same precedence the old
 * handler used to build its `idProofNumber` / `aadhaarNumber` aliases, so the
 * KYC page's comparison keeps meaning the same thing.
 */
function onFileAadhaar(t) {
    return firstAadhaar(
        t.idProofNumber,
        get(t, 'idProof.number'),
        t.aadhaarNumber,
        t.aadhar,
        get(t, 'kyc.aadhaarNumber'),
        get(t, 'kyc.aadhar'),
        get(t, 'digitalCheckin.kyc.aadhaarNumber'),
        get(t, 'kycVerificationData.adminEnteredAadhaar'),
    );
}

function uploadedCardImages(t) {
    const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? '';
    return {
        aadhaarFront: pick(get(t, 'digitalCheckin.documents.aadhaarFrontUrl'), get(t, 'kyc.aadhaarFront'), get(t, 'digitalCheckin.kyc.aadhaarFront')),
        aadhaarBack: pick(get(t, 'digitalCheckin.documents.aadhaarBackUrl'), get(t, 'kyc.aadhaarBack'), get(t, 'digitalCheckin.kyc.aadhaarBack')),
    };
}

/**
 * @param {object} tenant           lean tenant document (already enriched with
 *                                  ownerName / deposit fallbacks by the route)
 * @param {object} [opts]
 * @param {boolean} [opts.sensitive] true only after verifyCheckinAccess() passed
 */
function buildCheckinProfileView(tenant, { sensitive = false } = {}) {
    if (!tenant || typeof tenant !== 'object') return {};

    // Same transformation res.json() would apply (ObjectId → hex, Date → ISO),
    // and a deep copy so the caller's object is never mutated.
    const source = JSON.parse(JSON.stringify(tenant));
    const view = JSON.parse(JSON.stringify(tenant));

    const onFile = onFileAadhaar(source);
    const images = sensitive ? uploadedCardImages(source) : null;

    for (const path of REMOVED_PATHS) removePath(view, path.split('.'));

    view.aadhaarOnFile = Boolean(onFile);
    view.aadhaarMasked = maskAadhaar(onFile);
    view.aadhaarLast4 = aadhaarLast4(onFile);
    view.sensitiveAccess = Boolean(sensitive);
    if (sensitive) view.kycDocuments = images;

    return view;
}

module.exports = { buildCheckinProfileView, REMOVED_PATHS };
