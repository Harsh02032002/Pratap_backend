const VisitorLog = require('../models/VisitorLog');
const TenantLeaveRequest = require('../models/TenantLeaveRequest');
const Tenant = require('../models/Tenant');

exports.createVisitorPass = async (req, res) => {
  try {
    const { tenantId, guestName, guestPhone, expectedDate } = req.body;
    const tenant = await Tenant.findById(tenantId).populate('property');
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    const ownerId = tenant.ownerLoginId || (tenant.property && tenant.property.ownerLoginId) || 'SYSTEM';

    const visitor = new VisitorLog({
      ownerLoginId: ownerId,
      name: guestName,
      phone: guestPhone,
      hostName: tenant.name,
      hostRoom: tenant.roomNo || '-',
      purpose: 'Guest Visitor',
      status: 'Pre-approved',
      entryTime: null
    });
    
    await visitor.save();
    res.status(201).json({ 
      success: true, 
      message: 'Visitor Pass generated', 
      pass: { passCode: `PASS-${visitor._id.toString().substring(visitor._id.toString().length-4).toUpperCase()}` } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.getVisitorPasses = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenant = await Tenant.findById(tenantId);
    if(!tenant) return res.status(404).json({success: false, message: "Tenant not found"});
    const passes = await VisitorLog.find({ hostName: tenant.name, ownerLoginId: tenant.ownerLoginId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, passes });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.createLeaveRequest = async (req, res) => {
  try {
    const { tenantId, departureDate, returnDate, reason } = req.body;
    const tenant = await Tenant.findById(tenantId).populate('property');
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

    const ownerId = tenant.ownerLoginId || (tenant.property && tenant.property.ownerLoginId) || 'SYSTEM';

    const request = new TenantLeaveRequest({
      ownerLoginId: ownerId,
      tenantId: tenant._id,
      tenantName: tenant.name,
      roomNo: tenant.roomNo || '-',
      fromDate: departureDate,
      toDate: returnDate,
      reason: reason,
      status: 'Pending'
    });
    
    await request.save();
    res.status(201).json({ success: true, message: 'Leave Request submitted', request });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.getLeaveRequests = async (req, res) => {
  try {
    const { tenantId } = req.params;
    const requests = await TenantLeaveRequest.find({ tenantId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};
