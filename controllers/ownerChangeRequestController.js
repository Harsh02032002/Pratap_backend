const OwnerChangeRequest = require('../models/OwnerChangeRequest');
const Owner = require('../models/Owner');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fields we snapshot for the diff view when requestType === 'bank_details' */
const BANK_SNAPSHOT_KEYS = [
    'checkinAccountHolderName',
    'checkinBankName',
    'checkinBranchName',
    'checkinBankAccountNumber',
    'checkinIfscCode',
    'checkinUpiId',
    'checkinBankProof',
    'checkinBankProofName',
];

/** Fields we snapshot for the diff view when requestType === 'profile' */
const PROFILE_SNAPSHOT_KEYS = [
    'name',
    'email',
    'phone',
    'address',
    'city',
];

function snapshotOwner(owner, requestType) {
    const keys = requestType === 'bank_details' ? BANK_SNAPSHOT_KEYS : PROFILE_SNAPSHOT_KEYS;
    const snap = {};
    for (const k of keys) {
        const val = owner[k] ?? owner.profile?.[k] ?? '';
        if (val !== undefined && val !== null) snap[k] = val;
    }
    return snap;
}

// ─── Submit ──────────────────────────────────────────────────────────────────

exports.submitRequest = async (req, res) => {
    try {
        const { ownerLoginId, requestType, requestedChanges, bankProofUrl, bankProofName } = req.body;

        if (!ownerLoginId || !requestType || !requestedChanges) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const proofUrl  = bankProofUrl  || requestedChanges?.checkinBankProof     || requestedChanges?.bankProofUrl  || '';
        const proofName = bankProofName || requestedChanges?.checkinBankProofName || requestedChanges?.bankProofName || '';

        // Validate: bank_details change request MUST include a bank proof document
        if (requestType === 'bank_details' && !proofUrl) {
            return res.status(400).json({
                success: false,
                message: 'A bank proof document is required when updating bank details. Please upload one first.'
            });
        }

        const owner = await Owner.findOne({ loginId: ownerLoginId });
        if (!owner) {
            return res.status(404).json({ success: false, message: 'Owner not found' });
        }

        // Auto-reject any existing Pending request of the same type for this owner
        // (stale-duplicate guard — "auto-reject stale duplicate requests")
        const stale = await OwnerChangeRequest.find({
            ownerLoginId,
            requestType,
            status: 'Pending',
        });
        if (stale.length > 0) {
            await OwnerChangeRequest.updateMany(
                { ownerLoginId, requestType, status: 'Pending' },
                {
                    $set: {
                        status: 'Rejected',
                        rejectionReason: 'Superseded by a newer request from the same owner.',
                        reviewedBy: 'System',
                        reviewedAt: new Date(),
                    }
                }
            );
        }

        // Snapshot the owner's current values for the superadmin diff view
        const currentValues = snapshotOwner(owner, requestType);

        const request = new OwnerChangeRequest({
            ownerLoginId,
            requestType,
            requestedChanges,
            currentValues,
            bankProofUrl:  proofUrl,
            bankProofName: proofName,
        });

        await request.save();

        res.status(201).json({
            success: true,
            message: 'Change request submitted successfully for approval',
            data: request,
        });
    } catch (error) {
        console.error('Error submitting change request:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── List ────────────────────────────────────────────────────────────────────

exports.getRequests = async (req, res) => {
    try {
        const { status } = req.query;
        const query = {};
        if (status) query.status = status;

        const requests = await OwnerChangeRequest.find(query).sort({ createdAt: -1 });
        res.status(200).json({ success: true, data: requests });
    } catch (error) {
        console.error('Error fetching change requests:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── Approve ─────────────────────────────────────────────────────────────────

exports.approveRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { superadminLoginId } = req.body;

        const request = await OwnerChangeRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }
        if (request.status !== 'Pending') {
            return res.status(400).json({ success: false, message: 'Request already processed' });
        }

        const owner = await Owner.findOne({ loginId: request.ownerLoginId });
        if (!owner) {
            return res.status(404).json({ success: false, message: 'Owner not found' });
        }

        if (request.requestType === 'profile') {
            owner.profile = { ...owner.profile, ...request.requestedChanges, updatedAt: new Date() };
            owner.name    = request.requestedChanges.name    || owner.name;
            owner.email   = request.requestedChanges.email   || owner.email;
            owner.phone   = request.requestedChanges.phone   || owner.phone;
            owner.address = request.requestedChanges.address || owner.address;
            owner.city    = request.requestedChanges.city    || owner.city;

        } else if (request.requestType === 'bank_details') {
            const ch = request.requestedChanges;
            owner.checkinAccountHolderName  = ch.checkinAccountHolderName  || owner.checkinAccountHolderName;
            owner.checkinBankAccountNumber  = ch.checkinBankAccountNumber  || owner.checkinBankAccountNumber;
            owner.checkinIfscCode           = ch.checkinIfscCode           || owner.checkinIfscCode;
            owner.checkinBankName           = ch.checkinBankName           || owner.checkinBankName;
            owner.checkinBranchName         = ch.checkinBranchName         || owner.checkinBranchName;
            owner.checkinUpiId              = ch.checkinUpiId              || owner.checkinUpiId;

            // Sync the bank-proof URL from the change-request onto the owner record
            if (request.bankProofUrl) {
                owner.checkinBankProof     = request.bankProofUrl;
                owner.checkinBankProofName = request.bankProofName || '';
            }

            // Also keep nested profile object in sync
            if (!owner.profile) owner.profile = {};
            owner.profile.bankName      = ch.checkinBankName           || owner.profile.bankName;
            owner.profile.accountNumber = ch.checkinBankAccountNumber  || owner.profile.accountNumber;
            owner.profile.ifscCode      = ch.checkinIfscCode           || owner.profile.ifscCode;
        }

        await owner.save();

        request.status     = 'Approved';
        request.reviewedBy = superadminLoginId || 'System Admin';
        request.reviewedAt = new Date();
        await request.save();

        res.status(200).json({
            success: true,
            message: 'Request approved and changes applied',
            data: request,
        });
    } catch (error) {
        console.error('Error approving change request:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};

// ─── Reject ──────────────────────────────────────────────────────────────────

exports.rejectRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { superadminLoginId, reason } = req.body;

        const request = await OwnerChangeRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }
        if (request.status !== 'Pending') {
            return res.status(400).json({ success: false, message: 'Request already processed' });
        }

        request.status          = 'Rejected';
        request.reviewedBy      = superadminLoginId || 'System Admin';
        request.rejectionReason = reason;
        request.reviewedAt      = new Date();
        await request.save();

        res.status(200).json({ success: true, message: 'Request rejected', data: request });
    } catch (error) {
        console.error('Error rejecting change request:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
