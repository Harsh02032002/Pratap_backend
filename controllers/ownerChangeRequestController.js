const OwnerChangeRequest = require('../models/OwnerChangeRequest');
const Owner = require('../models/Owner');
const User = require('../models/user');

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

        // Accept the proof under any of the three shapes the panel may send it.
        const proofUrl  = bankProofUrl  || requestedChanges?.checkinBankProof     || requestedChanges?.bankProofUrl  || '';
        const proofName = bankProofName || requestedChanges?.checkinBankProofName || requestedChanges?.bankProofName || '';

        const owner = await Owner.findOne({ loginId: ownerLoginId });
        if (!owner) {
            return res.status(404).json({ success: false, message: 'Owner not found' });
        }

        // A changed account number without proof is exactly how a payout gets
        // silently redirected — enforce this server-side too, not just in the
        // form, since this endpoint could be hit directly. Scoped to an actual
        // account-number change so editing only the IFSC/UPI isn't blocked,
        // matching what the owner Settings form enforces client-side.
        if (requestType === 'bank_details') {
            const accountNumberChanged = requestedChanges.checkinBankAccountNumber
                && requestedChanges.checkinBankAccountNumber !== owner.checkinBankAccountNumber;
            if (accountNumberChanged && !proofUrl) {
                return res.status(400).json({ success: false, message: "A passbook or cancelled cheque photo is required when changing the account number." });
            }
        }

        // Auto-reject any existing Pending request of the same type for this
        // owner — stale-duplicate guard.
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

        // Snapshot the owner's values for the reviewer's diff view. Stored under
        // both names: the superadmin page reads previousValues, the owner page
        // reads currentValues.
        const previousValues = {};
        Object.keys(requestedChanges).forEach((key) => {
            previousValues[key] = owner[key] !== undefined ? owner[key] : (owner.profile ? owner.profile[key] : undefined);
        });
        const currentValues = snapshotOwner(owner, requestType);
        const request = new OwnerChangeRequest({
            ownerLoginId,
            requestType,
            requestedChanges,
            previousValues,
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
        const { status, ownerLoginId } = req.query;
        let query = {};
        if (status && status !== 'All') {
            query.status = status;
        }
        if (ownerLoginId) {
            query.ownerLoginId = ownerLoginId;
        }

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

        // Login authenticates against the User collection, not Owner — an
        // approved contact-detail change must land here too or the owner's
        // new phone/email simply won't work for sign-in.
        const authUser = await User.findOne({ loginId: request.ownerLoginId, role: 'owner' });

        if (request.requestType === 'profile') {
            const newPhone = request.requestedChanges.phone;
            if (newPhone) {
                const phoneConflict = await User.findOne({ phone: newPhone });
                if (phoneConflict && String(phoneConflict._id) !== String(authUser?._id)) {
                    return res.status(409).json({ success: false, message: "This phone number is already in use by another account." });
                }
            }

            // Update profile
            owner.profile = { ...owner.profile, ...request.requestedChanges, updatedAt: new Date() };
            owner.name = request.requestedChanges.name || owner.name;
            owner.email = request.requestedChanges.email || owner.email;
            owner.phone = newPhone || owner.phone;
            owner.address = request.requestedChanges.address || owner.address;
            owner.city = request.requestedChanges.city || owner.city;

            if (authUser) {
                if (request.requestedChanges.name) authUser.name = request.requestedChanges.name;
                if (request.requestedChanges.email) authUser.email = request.requestedChanges.email;
                if (newPhone) authUser.phone = newPhone;
                await authUser.save();
            }
        } else if (request.requestType === 'bank_details') {
            // Update checkin bank details (which owner uses for their payouts)
            owner.checkinAccountHolderName = request.requestedChanges.checkinAccountHolderName || owner.checkinAccountHolderName;
            owner.checkinBankAccountNumber = request.requestedChanges.checkinBankAccountNumber || owner.checkinBankAccountNumber;
            owner.checkinIfscCode = request.requestedChanges.checkinIfscCode || owner.checkinIfscCode;
            owner.checkinBankName = request.requestedChanges.checkinBankName || owner.checkinBankName;
            owner.checkinBranchName = request.requestedChanges.checkinBranchName || owner.checkinBranchName;
            owner.checkinUpiId = request.requestedChanges.checkinUpiId || owner.checkinUpiId;
            // Proof document uploaded alongside an account-number change —
            // persisted on the same field the digital check-in flow already
            // reads/writes. Prefers the top-level bankProofUrl the request now
            // stores, falling back to the copy nested in requestedChanges.
            owner.checkinBankProof = request.bankProofUrl || request.requestedChanges.checkinBankProof || owner.checkinBankProof;
            owner.checkinBankProofName = request.bankProofName || request.requestedChanges.checkinBankProofName || owner.checkinBankProofName;

            // Also update profile nested object
            if(!owner.profile) owner.profile = {};
            owner.profile.bankName = request.requestedChanges.checkinBankName || owner.profile.bankName;
            owner.profile.accountNumber = request.requestedChanges.checkinBankAccountNumber || owner.profile.accountNumber;
            owner.profile.ifscCode = request.requestedChanges.checkinIfscCode || owner.profile.ifscCode;
            owner.profile.branchName = request.requestedChanges.checkinBranchName || owner.profile.branchName;
        }

        await owner.save();

        request.status     = 'Approved';
        request.reviewedBy = superadminLoginId || 'System Admin';
        request.reviewedAt = new Date();
        await request.save();

        // Any other still-Pending request from this owner of the same type is
        // now stale — the record it would have edited just changed underneath
        // it. Auto-reject them instead of leaving duplicate/outdated requests
        // sitting in the queue for a superadmin to notice by hand.
        await OwnerChangeRequest.updateMany(
            {
                _id: { $ne: request._id },
                ownerLoginId: request.ownerLoginId,
                requestType: request.requestType,
                status: 'Pending'
            },
            {
                $set: {
                    status: 'Rejected',
                    rejectionReason: 'Duplicate request — already fulfilled by another approved update.',
                    reviewedBy: superadminLoginId || 'System Admin',
                    reviewedAt: new Date()
                }
            }
        );

        res.status(200).json({ success: true, message: "Request approved and changes applied", data: request });
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
