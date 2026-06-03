const TenantLeaveRequest = require('../models/TenantLeaveRequest');

exports.getOwnerLeaveRequests = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const requests = await TenantLeaveRequest.find({ 
            ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } 
        }).sort({ createdAt: -1 });
        res.json({ success: true, requests });
    } catch (err) {
        console.error("Get Leave Requests Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.createLeaveRequest = async (req, res) => {
    try {
        const { ownerLoginId, tenantId, tenantName, roomNo, fromDate, toDate, reason } = req.body;
        const request = new TenantLeaveRequest({
            ownerLoginId: String(ownerLoginId).toUpperCase(),
            tenantId,
            tenantName,
            roomNo,
            fromDate,
            toDate,
            reason,
            status: 'Pending'
        });
        await request.save();
        res.status(201).json({ success: true, request });
    } catch (err) {
        console.error("Create Leave Request Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.updateLeaveRequestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const request = await TenantLeaveRequest.findByIdAndUpdate(
            id,
            { $set: { status } },
            { new: true }
        );
        res.json({ success: true, request });
    } catch (err) {
        console.error("Update Leave Request Status Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
