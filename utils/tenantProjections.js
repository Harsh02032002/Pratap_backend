// Field-level security projections shared across tenant-returning controllers.
// Defence-in-depth: sensitive PII is stripped at the database query layer so it
// can never appear in a response even if a future auth check is accidentally
// skipped or bypassed upstream.
//
// ALWAYS_EXCLUDED — never sent to any caller regardless of role
const ALWAYS_EXCLUDED_PROJECTION =
    '-tempPassword' +
    ' -kyc.aadhaarNumber' +
    ' -kyc.aadhar' +
    ' -kyc.aadhaarLinkedPhone' +
    ' -kyc.aadharFile' +
    ' -kyc.aadhaarFront' +
    ' -kyc.aadhaarBack' +
    ' -kyc.idProofFile' +
    ' -kyc.addressProofFile' +
    ' -kyc.otpVerified' +
    ' -kyc.otpVerifiedAt' +
    ' -digitalCheckin.kyc' +
    ' -digitalCheckin.agreement.signatureDataUrl' +
    ' -agreementExtensions.tenantSignatureDataUrl' +
    ' -agreementRequestId' +
    ' -agreementESignName';

// The same list as paths, for documents that were loaded WITHOUT the
// projection (write routes load the full tenant in order to modify it) and are
// then sent back in the response.
const ALWAYS_EXCLUDED_PATHS = ALWAYS_EXCLUDED_PROJECTION.trim().split(/\s+/).map((p) => p.replace(/^-/, ''));

function removePath(node, parts) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((item) => removePath(item, parts));
        return;
    }
    const [head, ...rest] = parts;
    if (!(head in node)) return;
    if (rest.length === 0) delete node[head];
    else removePath(node[head], rest);
}

// Aadhaar-bearing paths that ALWAYS_EXCLUDED_PROJECTION does NOT cover. The
// first stays readable on the owner's tenant list (the owner panel's tenant
// table shows the Aadhaar the owner entered), so it cannot simply be added to
// the projection — but a write route has no reason to echo any of them.
// kyc.mismatchReasons is not in the schema, but older code wrote full numbers
// into it and a lean read returns whatever is stored.
const WRITE_RESPONSE_EXTRA_PATHS = ['kycVerificationData.adminEnteredAadhaar', 'kyc.aadhaarData', 'kyc.mismatchReasons'];

/**
 * Plain-object copy of a tenant safe to return from a WRITE route: every
 * ALWAYS_EXCLUDED path plus WRITE_RESPONSE_EXTRA_PATHS removed. Write routes
 * load the full document to modify it, so without this they echoed the
 * Aadhaar number, card images and signatures. Accepts a mongoose document or
 * a lean object; never mutates its input.
 */
function stripTenantSecrets(tenant) {
    if (!tenant || typeof tenant !== 'object') return tenant;
    const plain = typeof tenant.toObject === 'function' ? tenant.toObject() : tenant;
    const copy = JSON.parse(JSON.stringify(plain));
    for (const path of [...ALWAYS_EXCLUDED_PATHS, ...WRITE_RESPONSE_EXTRA_PATHS]) removePath(copy, path.split('.'));
    return copy;
}

module.exports = { ALWAYS_EXCLUDED_PROJECTION, ALWAYS_EXCLUDED_PATHS, stripTenantSecrets };
