const TenantKycRequest = require('../models/TenantKycRequest');
const Tenant = require('../models/Tenant');
const { completeTenantAgreementAndNotify } = require('../services/tenantOnboardingService');

exports.getRequests = async (req, res) => {
    try {
        const { status, ownerLoginId } = req.query;
        let query = {};
        if (status && status !== 'All') {
            query.status = status;
        }
        if (ownerLoginId) {
            query.ownerLoginId = String(ownerLoginId).toUpperCase();
        }

        // Populate the full tenant record the owner filled in at Add Tenant time,
        // so the superadmin can cross-check every detail against the proof photo
        // instead of just seeing the document in isolation.
        const requests = await TenantKycRequest.find(query)
            .populate('tenantId', 'name phone email dob gender roomNo building floor bedNo moveInDate agreedRent securityDepositTotal occupation company emergencyContact permanentAddress propertyTitle kyc.fatherName')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: requests });
    } catch (error) {
        console.error("Error fetching tenant KYC requests:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.approveRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { superadminLoginId } = req.body;

        const request = await TenantKycRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        if (request.status !== 'Pending') {
            return res.status(400).json({ success: false, message: "Request already processed" });
        }

        const tenant = await Tenant.findById(request.tenantId);
        if (!tenant) {
            return res.status(404).json({ success: false, message: "Tenant not found" });
        }

        tenant.kycStatus = 'verified';
        tenant.kyc = tenant.kyc || {};
        tenant.kyc.alternateProofApproved = true;
        tenant.updatedAt = new Date();
        await tenant.save();

        // The agreement/payment-link pipeline touches Cloudinary, SMTP and
        // WhatsApp — any of which can fail transiently. The identity decision
        // the superadmin just made is the durable part, so it is still recorded
        // as Approved and the failure is surfaced in the response instead, so a
        // superadmin knows the agreement email needs a manual resend rather
        // than the request being stuck Pending on an already-verified tenant.
        let notifyError = null;
        try {
            await completeTenantAgreementAndNotify(tenant.loginId, {
                requestId: '',
                provider: 'roomhy-alternate-kyc',
                callbackPayload: { source: 'tenant-kyc-request-approval', requestId: String(request._id) },
                frontendOrigin: req.get('origin') || '',
                ensureCheckinRecord: true
            });
        } catch (notifyErr) {
            notifyError = notifyErr.message;
            console.error('[TENANT KYC REQUEST] Agreement/payment-link notify failed:', notifyErr.message);
        }

        request.status = 'Approved';
        request.reviewedBy = superadminLoginId || 'System Admin';
        request.reviewedAt = new Date();
        await request.save();

        // Any other still-Pending proof request for the same tenant is now
        // redundant — this tenant is already verified.
        await TenantKycRequest.updateMany(
            {
                _id: { $ne: request._id },
                tenantId: request.tenantId,
                status: 'Pending'
            },
            {
                $set: {
                    status: 'Rejected',
                    rejectionReason: 'Duplicate request — already fulfilled by another approved verification.',
                    reviewedBy: superadminLoginId || 'System Admin',
                    reviewedAt: new Date()
                }
            }
        );

        res.status(200).json({
            success: true,
            message: notifyError
                ? "Tenant verified, but the agreement and payment link could not be sent. Please resend manually."
                : "Tenant KYC approved. Agreement and payment link sent.",
            data: request,
            notifyError
        });
    } catch (error) {
        console.error("Error approving tenant KYC request:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.rejectRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { superadminLoginId, reason } = req.body;

        const request = await TenantKycRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        if (request.status !== 'Pending') {
            return res.status(400).json({ success: false, message: "Request already processed" });
        }

        const tenant = await Tenant.findById(request.tenantId);
        if (tenant) {
            tenant.kycStatus = 'rejected';
            tenant.kyc = tenant.kyc || {};
            tenant.kyc.alternateProofApproved = false;
            tenant.updatedAt = new Date();
            await tenant.save();
        }

        request.status = 'Rejected';
        request.reviewedBy = superadminLoginId || 'System Admin';
        request.rejectionReason = reason;
        request.reviewedAt = new Date();
        await request.save();

        res.status(200).json({ success: true, message: "Request rejected", data: request });
    } catch (error) {
        console.error("Error rejecting tenant KYC request:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};
