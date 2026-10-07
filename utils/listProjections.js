'use strict';

/**
 * Projections that drop image/blob fields from list responses.
 *
 * Tenant and Owner documents store KYC scans, photos and e-signatures inline
 * (data URLs in Mixed/String fields). A list of N tenants therefore carried N
 * sets of images even to screens that only show names, rooms and rent — the
 * single biggest source of payload weight in the owner panel.
 *
 * Only blob fields are listed. Numbers, statuses and flags (e.g. kyc.aadhaarNumber,
 * kycStatus, agreementSigned) stay, so "has KYC" style checks keep working.
 * Use these ONLY where the consumer is known not to render the images.
 */

const TENANT_LIST_LITE_EXCLUDE = [
    '-photo',
    '-kyc.aadharFile',
    '-kyc.aadhaarFront',
    '-kyc.aadhaarBack',
    '-kyc.idProofFile',
    '-digitalCheckin.kyc.aadhaarFront',
    '-digitalCheckin.kyc.aadhaarBack',
    '-digitalCheckin.agreement.signatureDataUrl',
].join(' ');

// Owner KYC document scans. Profile photo fields (photo, photoDataUrl,
// profilePic, avatar) are deliberately kept — the panel header shows them.
const OWNER_DASHBOARD_EXCLUDE = [
    '-checkinAadhaarImage',
    '-checkinAadhaarFront',
    '-checkinAadhaarBack',
    '-checkinBankProof',
    '-checkinCancelledCheque',
    '-documentImage',
].join(' ');

module.exports = { TENANT_LIST_LITE_EXCLUDE, OWNER_DASHBOARD_EXCLUDE };
