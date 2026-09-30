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
    ' -agreementRequestId' +
    ' -agreementESignName';

module.exports = { ALWAYS_EXCLUDED_PROJECTION };
