const express = require('express');
const router = express.Router();

/**
 * POST /api/reports/generate
 * Generate report data with filters, store in report history
 */
router.post('/generate', async (req, res) => {
    try {
        const Report = require('../models/Report');
        const { ownerLoginId, reportName, category, format, startDate, endDate, propertyId, status, staffId, tenantId } = req.body;
        
        // Build date filter
        const dateFilter = {};
        if (startDate) dateFilter.$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.$lte = end;
        }

        let reportData = [];
        let kpis = {};

        // ===== FINANCIAL REPORTS =====
        if (category === 'Financial' || reportName?.includes('Rent') || reportName?.includes('Collection')) {
            const Rent = require('../models/Rent');
            const filter = { ownerLoginId };
            if (propertyId) filter.propertyId = propertyId;
            if (Object.keys(dateFilter).length > 0) filter.createdAt = dateFilter;
            // Status filter — map friendly labels to actual enum values
            if (status) {
                const statusMap = { 'Paid': 'paid', 'paid': 'paid', 'Pending': 'pending', 'pending': 'pending', 'Overdue': 'overdue', 'overdue': 'overdue', 'completed': 'completed' };
                filter.paymentStatus = statusMap[status] || status.toLowerCase();
            }
            const rents = await Rent.find(filter).sort({ createdAt: -1 }).limit(500);
            
            const totalCollected = rents.filter(r => r.paymentStatus === 'paid' || r.paymentStatus === 'completed').reduce((sum, r) => sum + (r.rentAmount || r.paidAmount || 0), 0);
            const totalPending = rents.filter(r => r.paymentStatus === 'pending' || r.paymentStatus === 'overdue').reduce((sum, r) => sum + (r.rentAmount || 0), 0);
            
            reportData = rents.map(r => ({
                'Tenant Name': r.tenantName || 'N/A',
                'Property': r.propertyName || 'N/A',
                'Room': r.roomNumber || 'N/A',
                'Rent Amount': r.rentAmount || 0,
                'Paid Amount': r.paidAmount || 0,
                'Payment Method': r.paymentMethod || 'N/A',
                'Status': r.paymentStatus || 'N/A',
                'Month': r.collectionMonth || 'N/A',
                'Date': r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN') : 'N/A',
            }));
            kpis = { totalCollected, totalPending, totalRecords: rents.length };
        }
        
        else if (reportName?.includes('Dues') || reportName?.includes('Outstanding')) {
            const Tenant = require('../models/Tenant');
            const filter = { ownerLoginId, status: 'active' };
            if (propertyId) filter.property = propertyId;
            const tenants = await Tenant.find(filter).sort({ createdAt: -1 }).limit(500);
            
            reportData = tenants.map(t => ({
                'Tenant Name': t.name || 'N/A',
                'Property': t.propertyName || 'N/A',
                'Room': t.roomNo || 'N/A',
                'Monthly Rent': t.rentAmount || 0,
                'Pending Amount': t.dueAmount || 0,
                'Phone': t.phone || 'N/A',
                'Move In Date': t.joiningDate ? new Date(t.joiningDate).toLocaleDateString('en-IN') : 'N/A',
            }));
            const totalDues = tenants.reduce((sum, t) => sum + (t.dueAmount || 0), 0);
            kpis = { totalDues, tenantsWithDues: tenants.filter(t => (t.dueAmount || 0) > 0).length };
        }
        
        // ===== OCCUPANCY REPORTS =====
        else if (category === 'Occupancy' || reportName?.includes('Occupancy') || reportName?.includes('Bed') || reportName?.includes('Room')) {
            const Room = require('../models/Room');
            const filter = { ownerLoginId };
            if (propertyId) filter.propertyId = propertyId;
            const rooms = await Room.find(filter).sort({ roomNo: 1 }).limit(500);
            
            const totalBeds = rooms.reduce((sum, r) => sum + (r.beds || 0), 0);
            const occupiedBeds = rooms.filter(r => !r.isAvailable).reduce((sum, r) => sum + (r.beds || 0), 0);
            
            reportData = rooms.map(r => ({
                'Property': r.propertyName || 'N/A',
                'Room': r.title || 'N/A',
                'Type': r.type || 'N/A',
                'Beds': r.beds || 0,
                'Available': r.isAvailable ? 'Yes' : 'No',
                'Price': r.price ? `₹${r.price}` : 'N/A',
                'Status': r.status || 'N/A',
            }));
            kpis = { totalBeds, occupiedBeds, vacantBeds: totalBeds - occupiedBeds, occupancyRate: totalBeds > 0 ? Math.round(occupiedBeds / totalBeds * 100) : 0 };
        }
        
        // ===== TENANT REPORTS =====
        else if (category === 'Tenant' || reportName?.includes('Tenant')) {
            const Tenant = require('../models/Tenant');
            const filter = { ownerLoginId };
            if (propertyId) filter.property = propertyId;
            if (status) filter.status = status;
            const tenants = await Tenant.find(filter).sort({ createdAt: -1 }).limit(500);
            
            reportData = tenants.map(t => ({
                'Tenant Name': t.name || 'N/A',
                'Property': t.propertyName || 'N/A',
                'Room': t.roomNo || 'N/A',
                'Phone': t.phone || 'N/A',
                'Move In Date': t.joiningDate ? new Date(t.joiningDate).toLocaleDateString('en-IN') : 'N/A',
                'Monthly Rent': t.rentAmount || 0,
                'KYC Status': t.kycStatus || 'N/A',
                'Agreement Status': t.agreementStatus || 'N/A',
                'Status': t.status || 'N/A',
            }));
            kpis = { totalTenants: tenants.length, activeTenants: tenants.filter(t => t.status === 'active').length };
        }
        
        // ===== LEAD REPORTS =====
        else if (category === 'Lead' || reportName?.includes('Lead') || reportName?.includes('Enquiry')) {
            const PropertyEnquiry = require('../models/PropertyEnquiry');
            const filter = { ownerLoginId };
            if (Object.keys(dateFilter).length > 0) filter.createdAt = dateFilter;
            if (status) filter.status = status;
            const leads = await PropertyEnquiry.find(filter).sort({ createdAt: -1 }).limit(500);
            
            const converted = leads.filter(l => l.status === 'converted' || l.status === 'booked');
            
            reportData = leads.map(l => ({
                'Lead Name': l.name || 'N/A',
                'Source': l.source || 'N/A',
                'Phone': l.phone || 'N/A',
                'Budget': l.budget || 'N/A',
                'Move In Date': l.moveInDate ? new Date(l.moveInDate).toLocaleDateString('en-IN') : 'N/A',
                'Assigned Property': l.propertyName || 'N/A',
                'Status': l.status || 'N/A',
                'Date': l.createdAt ? new Date(l.createdAt).toLocaleDateString('en-IN') : 'N/A',
            }));
            kpis = {
                totalLeads: leads.length,
                convertedLeads: converted.length,
                conversionRate: leads.length > 0 ? `${Math.round(converted.length / leads.length * 100)}%` : '0%'
            };
        }
        
        // ===== COMPLAINT REPORTS =====
        else if (category === 'Complaint' || reportName?.includes('Complaint')) {
            const Complaint = require('../models/Complaint');
            const filter = { ownerLoginId };
            if (Object.keys(dateFilter).length > 0) filter.createdAt = dateFilter;
            if (status) filter.status = status;
            const complaints = await Complaint.find(filter).sort({ createdAt: -1 }).limit(500);
            
            reportData = complaints.map(c => ({
                'Complaint ID': c._id?.toString().slice(-6).toUpperCase() || 'N/A',
                'Tenant': c.tenantName || 'N/A',
                'Property': c.propertyName || 'N/A',
                'Category': c.category || c.type || 'N/A',
                'Priority': c.priority || 'N/A',
                'Assigned Staff': c.assignedStaffName || 'N/A',
                'Status': c.status || 'N/A',
                'Created': c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-IN') : 'N/A',
            }));
            kpis = {
                totalComplaints: complaints.length,
                openComplaints: complaints.filter(c => c.status === 'Open' || c.status === 'Pending').length,
                resolvedComplaints: complaints.filter(c => c.status === 'Resolved').length
            };
        }
        
        // ===== STAFF/ATTENDANCE REPORTS =====
        else if (category === 'Attendance' || reportName?.includes('Attendance') || reportName?.includes('Staff')) {
            const StaffAttendance = require('../models/StaffAttendance');
            const Employee = require('../models/Employee');
            const filter = { ownerLoginId };
            if (staffId) filter.employeeId = staffId;
            if (Object.keys(dateFilter).length > 0) filter.date = dateFilter;
            
            const records = await StaffAttendance.find(filter)
                .populate('employeeId', 'name role')
                .sort({ date: -1 }).limit(500);
            
            reportData = records.map(r => ({
                'Staff Name': r.employeeId?.name || 'N/A',
                'Role': r.employeeId?.role || 'N/A',
                'Date': r.date ? new Date(r.date).toLocaleDateString('en-IN') : 'N/A',
                'Check In': r.checkIn || 'N/A',
                'Check Out': r.checkOut || 'N/A',
                'Status': r.status || 'N/A',
                'Notes': r.notes || '',
            }));
            kpis = { totalRecords: records.length };
        }

        // Generate CSV content
        const headers = reportData.length > 0 ? Object.keys(reportData[0]) : [];
        const csvRows = [
            headers.join(','),
            ...reportData.map(row => headers.map(h => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','))
        ];
        const csvContent = csvRows.join('\n');

        // Store in Report history (best-effort)
        try {
            await Report.create({
                ownerLoginId,
                reportName,
                format: format || 'CSV',
                generatedBy: ownerLoginId,
                filters: { startDate, endDate, propertyId, status, staffId },
                recordCount: reportData.length
            });
        } catch (_) { /* non-critical */ }

        return res.status(200).json({
            success: true,
            message: `${reportName || 'Report'} generated successfully with ${reportData.length} records`,
            data: reportData,
            kpis,
            fileContent: csvContent,
            fileName: `${(reportName || 'report').replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`
        });
    } catch (err) {
        console.error('Report generate error:', err);
        return res.status(500).json({ error: 'Failed to generate report', details: err.message });
    }
});

/**
 * GET /api/reports/history/:ownerLoginId
 */
router.get('/history/:ownerLoginId', async (req, res) => {
    try {
        const Report = require('../models/Report');
        const reports = await Report.find({ ownerLoginId: req.params.ownerLoginId }).sort({ createdAt: -1 }).limit(50);
        return res.status(200).json({ success: true, data: reports });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch report history', details: err.message });
    }
});

/**
 * GET /api/reports/summary/:ownerLoginId
 * KPI dashboard summary for reports page
 */
router.get('/summary/:ownerLoginId', async (req, res) => {
    try {
        const Tenant = require('../models/Tenant');
        const Complaint = require('../models/Complaint');
        const PropertyEnquiry = require('../models/PropertyEnquiry');
        const Rent = require('../models/Rent');
        const Room = require('../models/Room');
        const { ownerLoginId } = req.params;

        const [
            activeTenants, openComplaints, allLeads,
            recentRents, rooms
        ] = await Promise.allSettled([
            Tenant.countDocuments({ ownerLoginId, status: 'active' }),
            Complaint.countDocuments({ ownerLoginId, status: { $in: ['Open', 'Pending'] } }),
            PropertyEnquiry.countDocuments({ ownerLoginId }),
            Rent.find({ ownerLoginId, status: 'Paid' }).sort({ createdAt: -1 }).limit(100),
            Room.find({ ownerLoginId }).select('totalBeds occupiedBeds'),
        ]);

        const totalRevenue = recentRents.status === 'fulfilled'
            ? recentRents.value.reduce((s, r) => s + (r.amount || 0), 0) : 0;

        const allRooms = rooms.status === 'fulfilled' ? rooms.value : [];
        const totalBeds = allRooms.reduce((s, r) => s + (r.totalBeds || 0), 0);
        const occupiedBeds = allRooms.reduce((s, r) => s + (r.occupiedBeds || 0), 0);
        const occupancyPct = totalBeds > 0 ? Math.round(occupiedBeds / totalBeds * 100) : 0;

        return res.status(200).json({
            success: true,
            data: {
                totalRevenue,
                occupancyPct,
                activeTenants: activeTenants.status === 'fulfilled' ? activeTenants.value : 0,
                openComplaints: openComplaints.status === 'fulfilled' ? openComplaints.value : 0,
                newLeads: allLeads.status === 'fulfilled' ? allLeads.value : 0,
            }
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch report summary', details: err.message });
    }
});

/**
 * GET /api/reports/seed-test/:ownerLoginId
 * Insert test data for reports testing — uses existing server DB connection
 */
router.get('/seed-test/:ownerLoginId', async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const Rent = require('../models/Rent');
        const Tenant = require('../models/Tenant');
        const Complaint = require('../models/Complaint');
        const Room = require('../models/Room');
        const mongoose = require('mongoose');

        const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
        const PROPERTY_ID = new mongoose.Types.ObjectId();
        const PROPERTY_NAME = 'Sunshine PG';

        // Clear old seed test data first
        await Rent.deleteMany({ ownerLoginId, propertyName: { $in: [PROPERTY_NAME, 'Moonlight Hostel'] } });
        await Tenant.deleteMany({ ownerLoginId, propertyName: { $in: [PROPERTY_NAME, 'Moonlight Hostel'] } });
        await Complaint.deleteMany({ ownerLoginId, tenantId: { $in: ['SEED001','SEED002','SEED003','SEED004','SEED005'] } });
        await Room.deleteMany({ title: { $in: ['Room 101','Room 102','Room 201','Room 202'] }, propertyName: PROPERTY_NAME });

        // Rents
        const rents = await Rent.insertMany([
            { ownerLoginId, propertyName: PROPERTY_NAME, propertyId: PROPERTY_ID, tenantName: 'Rohit Sharma', roomNumber: '101', rentAmount: 8000, paidAmount: 8000, paymentStatus: 'paid', paymentMethod: 'other', collectionMonth: '2026-06', createdAt: daysAgo(2) },
            { ownerLoginId, propertyName: PROPERTY_NAME, propertyId: PROPERTY_ID, tenantName: 'Priya Verma', roomNumber: '102', rentAmount: 7500, paidAmount: 7500, paymentStatus: 'paid', paymentMethod: 'cash', collectionMonth: '2026-06', createdAt: daysAgo(5) },
            { ownerLoginId, propertyName: PROPERTY_NAME, propertyId: PROPERTY_ID, tenantName: 'Arjun Mehta', roomNumber: '103', rentAmount: 9000, paidAmount: 9000, paymentStatus: 'completed', paymentMethod: 'razorpay', collectionMonth: '2026-06', createdAt: daysAgo(8) },
            { ownerLoginId, propertyName: PROPERTY_NAME, propertyId: PROPERTY_ID, tenantName: 'Sneha Patel', roomNumber: '201', rentAmount: 8500, paidAmount: 0, paymentStatus: 'pending', paymentMethod: 'other', collectionMonth: '2026-06', createdAt: daysAgo(3) },
            { ownerLoginId, propertyName: PROPERTY_NAME, propertyId: PROPERTY_ID, tenantName: 'Karan Singh', roomNumber: '202', rentAmount: 7000, paidAmount: 7000, paymentStatus: 'paid', paymentMethod: 'other', collectionMonth: '2026-06', createdAt: daysAgo(12) },
            { ownerLoginId, propertyName: PROPERTY_NAME, propertyId: PROPERTY_ID, tenantName: 'Aman Gupta', roomNumber: '203', rentAmount: 8200, paidAmount: 0, paymentStatus: 'overdue', paymentMethod: 'other', collectionMonth: '2026-05', createdAt: daysAgo(35) },
            { ownerLoginId, propertyName: 'Moonlight Hostel', propertyId: PROPERTY_ID, tenantName: 'Divya Kumar', roomNumber: '301', rentAmount: 6500, paidAmount: 6500, paymentStatus: 'paid', paymentMethod: 'other', collectionMonth: '2026-06', createdAt: daysAgo(7) },
            { ownerLoginId, propertyName: 'Moonlight Hostel', propertyId: PROPERTY_ID, tenantName: 'Ravi Yadav', roomNumber: '302', rentAmount: 7200, paidAmount: 7200, paymentStatus: 'paid', paymentMethod: 'cash', collectionMonth: '2026-06', createdAt: daysAgo(10) },
            { ownerLoginId, propertyName: 'Moonlight Hostel', propertyId: PROPERTY_ID, tenantName: 'Pooja Nair', roomNumber: '303', rentAmount: 6800, paidAmount: 0, paymentStatus: 'pending', paymentMethod: 'other', collectionMonth: '2026-06', createdAt: daysAgo(4) },
            { ownerLoginId, propertyName: 'Moonlight Hostel', propertyId: PROPERTY_ID, tenantName: 'Harsh Agarwal', roomNumber: '304', rentAmount: 7500, paidAmount: 7500, paymentStatus: 'paid', paymentMethod: 'bank_transfer', collectionMonth: '2026-06', createdAt: daysAgo(15) },
        ]);

        // Tenants
        const tenants = await Tenant.insertMany([
            { ownerLoginId, name: 'Rohit Sharma', phone: '9812345670', property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: '101', rentAmount: 8000, dueAmount: 0, status: 'active', kycStatus: 'verified', agreementStatus: 'signed', joiningDate: daysAgo(120) },
            { ownerLoginId, name: 'Priya Verma', phone: '9823456781', property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: '102', rentAmount: 7500, dueAmount: 0, status: 'active', kycStatus: 'verified', agreementStatus: 'signed', joiningDate: daysAgo(90) },
            { ownerLoginId, name: 'Arjun Mehta', phone: '9834567892', property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: '103', rentAmount: 9000, dueAmount: 0, status: 'active', kycStatus: 'pending', agreementStatus: 'pending', joiningDate: daysAgo(45) },
            { ownerLoginId, name: 'Sneha Patel', phone: '9845678903', property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: '201', rentAmount: 8500, dueAmount: 8500, status: 'active', kycStatus: 'verified', agreementStatus: 'signed', joiningDate: daysAgo(200) },
            { ownerLoginId, name: 'Karan Singh', phone: '9856789014', property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: '202', rentAmount: 7000, dueAmount: 0, status: 'active', kycStatus: 'pending', agreementStatus: 'not signed', joiningDate: daysAgo(30) },
            { ownerLoginId, name: 'Aman Gupta', phone: '9867890125', property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: '203', rentAmount: 8200, dueAmount: 16400, status: 'active', kycStatus: 'rejected', agreementStatus: 'expired', joiningDate: daysAgo(365) },
        ]);

        // Complaints — all required fields provided
        const complaints = await Complaint.insertMany([
            { ownerLoginId, tenantId: 'SEED001', tenantName: 'Rohit Sharma', tenantPhone: '9812345670', property: String(PROPERTY_ID), propertyId: String(PROPERTY_ID), propertyName: PROPERTY_NAME, roomNo: '101', bedNo: 'B1', category: 'Maintenance', priority: 'High', assignedStaffName: 'Raju Kumar', status: 'Open', description: 'AC not working in room 101' },
            { ownerLoginId, tenantId: 'SEED002', tenantName: 'Priya Verma', tenantPhone: '9823456781', property: String(PROPERTY_ID), propertyId: String(PROPERTY_ID), propertyName: PROPERTY_NAME, roomNo: '102', bedNo: 'B1', category: 'Cleanliness', priority: 'Medium', assignedStaffName: 'Rahul Singh', status: 'In Progress', description: 'Common area not cleaned' },
            { ownerLoginId, tenantId: 'SEED003', tenantName: 'Sneha Patel', tenantPhone: '9845678903', property: String(PROPERTY_ID), propertyId: String(PROPERTY_ID), propertyName: PROPERTY_NAME, roomNo: '201', bedNo: 'B2', category: 'Water', priority: 'High', assignedStaffName: 'Raju Kumar', status: 'Taken', description: 'No water supply since morning' },
            { ownerLoginId, tenantId: 'SEED004', tenantName: 'Karan Singh', tenantPhone: '9856789014', property: String(PROPERTY_ID), propertyId: String(PROPERTY_ID), propertyName: PROPERTY_NAME, roomNo: '202', bedNo: 'B1', category: 'Electricity', priority: 'High', assignedStaffName: 'Rahul Singh', status: 'Resolved', description: 'Switchboard sparking in room 202' },
            { ownerLoginId, tenantId: 'SEED005', tenantName: 'Aman Gupta', tenantPhone: '9867890125', property: String(PROPERTY_ID), propertyId: String(PROPERTY_ID), propertyName: PROPERTY_NAME, roomNo: '203', bedNo: 'B1', category: 'Security', priority: 'Low', assignedStaffName: '', status: 'Open', description: 'CCTV camera not working' },
        ]);

        // Rooms — correct Room model fields
        const rooms = await Room.insertMany([
            { property: PROPERTY_ID, title: 'Room 101', type: 'AC', beds: 2, price: 8000, ownerLoginId, propertyName: PROPERTY_NAME, isAvailable: false, status: 'active' },
            { property: PROPERTY_ID, title: 'Room 102', type: 'AC', beds: 3, price: 7500, ownerLoginId, propertyName: PROPERTY_NAME, isAvailable: true, status: 'active' },
            { property: PROPERTY_ID, title: 'Room 201', type: 'Non-AC', beds: 4, price: 6500, ownerLoginId, propertyName: PROPERTY_NAME, isAvailable: false, status: 'active' },
            { property: PROPERTY_ID, title: 'Room 202', type: 'Non-AC', beds: 2, price: 9000, ownerLoginId, propertyName: PROPERTY_NAME, isAvailable: true, status: 'active' },
        ]);

        const totalPaid = rents.filter(r => r.paymentStatus === 'paid' || r.paymentStatus === 'completed').reduce((s, r) => s + (r.rentAmount || 0), 0);

        return res.json({
            success: true,
            message: `Test data seeded for ${ownerLoginId}`,
            inserted: {
                rents: rents.length,
                tenants: tenants.length,
                complaints: complaints.length,
                rooms: rooms.length,
                totalPaidRevenue: `₹${totalPaid.toLocaleString('en-IN')}`
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
