const OwnerChangeRequest = require('../models/OwnerChangeRequest');
const Owner = require('../models/Owner');

exports.submitRequest = async (req, res) => {
    try {
        const { ownerLoginId, requestType, requestedChanges } = req.body;
        
        if (!ownerLoginId || !requestType || !requestedChanges) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        const request = new OwnerChangeRequest({
            ownerLoginId,
            requestType,
            requestedChanges
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
        const { status } = req.query;
        let query = {};
        if (status) {
            query.status = status;
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

        if (request.requestType === 'profile') {
            // Update profile
            owner.profile = { ...owner.profile, ...request.requestedChanges, updatedAt: new Date() };
            owner.name = request.requestedChanges.name || owner.name;
            owner.email = request.requestedChanges.email || owner.email;
            owner.phone = request.requestedChanges.phone || owner.phone;
            owner.address = request.requestedChanges.address || owner.address;
            owner.city = request.requestedChanges.city || owner.city;
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
