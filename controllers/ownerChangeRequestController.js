const OwnerChangeRequest = require('../models/OwnerChangeRequest');
const Owner = require('../models/Owner');
const User = require('../models/user');

exports.submitRequest = async (req, res) => {
    try {
        const { ownerLoginId, requestType, requestedChanges } = req.body;
        
        if (!ownerLoginId || !requestType || !requestedChanges) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        // Snapshot the current values for only the fields being changed, so
        // the reviewer can see a "previous vs requested" diff later.
        const owner = await Owner.findOne({ loginId: ownerLoginId });
        const previousValues = {};
        if (owner) {
            Object.keys(requestedChanges).forEach((key) => {
                previousValues[key] = owner[key] !== undefined ? owner[key] : (owner.profile ? owner.profile[key] : undefined);
            });
        }

        const request = new OwnerChangeRequest({
            ownerLoginId,
            requestType,
            requestedChanges,
            previousValues
        });

        await request.save();
        
        // Return success message
        res.status(201).json({ success: true, message: "Change request submitted successfully for approval", data: request });
    } catch (error) {
        console.error("Error submitting change request:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};

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
        console.error("Error fetching change requests:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.approveRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { superadminLoginId } = req.body;

        const request = await OwnerChangeRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        if (request.status !== 'Pending') {
            return res.status(400).json({ success: false, message: "Request already processed" });
        }

        // Apply changes to Owner
        const owner = await Owner.findOne({ loginId: request.ownerLoginId });
        if (!owner) {
            return res.status(404).json({ success: false, message: "Owner not found" });
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
            owner.checkinUpiId = request.requestedChanges.checkinUpiId || owner.checkinUpiId;
            
            // Also update profile nested object
            if(!owner.profile) owner.profile = {};
            owner.profile.bankName = request.requestedChanges.checkinBankName || owner.profile.bankName;
            owner.profile.accountNumber = request.requestedChanges.checkinBankAccountNumber || owner.profile.accountNumber;
            owner.profile.ifscCode = request.requestedChanges.checkinIfscCode || owner.profile.ifscCode;
        }

        await owner.save();

        request.status = 'Approved';
        request.reviewedBy = superadminLoginId || 'System Admin';
        request.reviewedAt = new Date();
        await request.save();

        res.status(200).json({ success: true, message: "Request approved and changes applied", data: request });
    } catch (error) {
        console.error("Error approving change request:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.rejectRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { superadminLoginId, reason } = req.body;

        const request = await OwnerChangeRequest.findById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: "Request not found" });
        }

        if (request.status !== 'Pending') {
            return res.status(400).json({ success: false, message: "Request already processed" });
        }

        request.status = 'Rejected';
        request.reviewedBy = superadminLoginId || 'System Admin';
        request.rejectionReason = reason;
        request.reviewedAt = new Date();
        await request.save();

        res.status(200).json({ success: true, message: "Request rejected", data: request });
    } catch (error) {
        console.error("Error rejecting change request:", error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
};
