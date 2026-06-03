const VisitorLog = require('../models/VisitorLog');

// Get all visitor logs for an owner
exports.getOwnerVisitors = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const { status } = req.query; // optional filter by status

        let query = { ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } };
        if (status) {
            query.status = status;
        }

        const visitors = await VisitorLog.find(query).sort({ entryTime: -1 });
        res.json({ success: true, visitors });
    } catch (err) {
        console.error("Get Visitors Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Create a new visitor entry (Check-in or Pre-approved Pass)
exports.createVisitor = async (req, res) => {
    try {
        const { ownerLoginId, name, phone, hostName, hostRoom, purpose, status } = req.body;

        const visitor = new VisitorLog({
            ownerLoginId: String(ownerLoginId).toUpperCase(),
            name,
            phone,
            hostName,
            hostRoom,
            purpose,
            status: status || 'Inside',
            entryTime: status === 'Pre-approved' ? null : new Date()
        });

        await visitor.save();
        res.status(201).json({ success: true, visitor });
    } catch (err) {
        console.error("Create Visitor Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update Visitor Status (e.g. Check-out, Cancel pass, Activate pass)
exports.updateVisitorStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        let updateData = { status };
        
        // If they are checking out, record exit time
        if (status === 'Exited') {
            updateData.exitTime = new Date();
        }
        // If activating a pre-approved pass
        if (status === 'Inside') {
            updateData.entryTime = new Date();
        }

        const visitor = await VisitorLog.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true }
        );

        if (!visitor) {
            return res.status(404).json({ success: false, message: 'Visitor not found' });
        }

        res.json({ success: true, visitor });
    } catch (err) {
        console.error("Update Visitor Status Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
