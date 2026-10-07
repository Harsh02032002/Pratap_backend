const express = require('express');
const router = express.Router();
const {
    fetchTenantsForReport,
    fetchRoomsForReport,
    formatTenantRow,
    formatDuesRow,
    formatOccupancyRow,
    calcOccupancyKpis,
    buildTenantFilter,
    getOwnerProperties,
} = require('../utils/reportDataHelpers');

const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');
const { requireOwnerAccess } = require('../middleware/ownerAccess');
const { cacheJsonResponse } = require('../utils/cache');
const { ownerSelfCacheKey } = require('../utils/cacheKeys');

// Owner demand analytics: the heaviest owner read (every enquiry, booking,
// review, complaint and rent for all the owner's properties). Output is
// advisory analytics that depends only on the owner, so 5 minutes of
// staleness is acceptable — invalidation is TTL-only. Cached only when an
// owner reads their own report; every other permitted caller bypasses.
const ownerDemandCache = cacheJsonResponse({
  panel: 'owner', resource: 'owner-demand', ttlSeconds: 300,
  keyFor: (req) => ownerSelfCacheKey(req, req.params.ownerLoginId, 'owner-demand'),
});

/**
 * POST /api/reports/generate
 * Generate report data with filters, store in report history
 */
router.post('/generate', protect, authorize('superadmin'), applyEmployeeScope, async (req, res) => {
    try {
        const Report = require('../models/Report');
        const { applyRentScope, applyTenantScope, applyRoomScope } = require('../utils/scopeHelpers');
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
            let filter = {};
            if (ownerLoginId) filter.ownerLoginId = ownerLoginId;
            if (propertyId) filter.propertyId = propertyId;
            if (Object.keys(dateFilter).length > 0) filter.createdAt = dateFilter;
            // Status filter — map friendly labels to actual enum values
            if (status) {
                const statusMap = { 'Paid': 'paid', 'paid': 'paid', 'Pending': 'pending', 'pending': 'pending', 'Overdue': 'overdue', 'overdue': 'overdue', 'completed': 'completed' };
                filter.paymentStatus = statusMap[status] || status.toLowerCase();
            }

            const Tenant = require('../models/Tenant');
            const activeTenants = await Tenant.find(applyTenantScope(req, { isDeleted: { $ne: true } })).select('_id loginId');
            const activeTenantIds = activeTenants.map(t => t._id);
            const activeTenantLoginIds = activeTenants.map(t => t.loginId).filter(Boolean);
            filter.$or = [
                { tenantId: { $in: activeTenantIds } },
                { tenantLoginId: { $in: activeTenantLoginIds } }
            ];

            const scopedFilter = applyRentScope(req, filter);
            const rents = await Rent.find(scopedFilter).sort({ createdAt: -1 }).limit(500);
            
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
            const { tenants, propTitleMap } = await fetchTenantsForReport(ownerLoginId, {
                propertyId,
                status: 'active',
                withDues: true,
            });

            reportData = tenants.map(t => formatDuesRow(t, propTitleMap));
            const totalDues = tenants.reduce((sum, t) => sum + (t.dueAmount || t.dues || t.balance || 0), 0);
            kpis = {
                totalDues,
                tenantsWithDues: tenants.filter(t => (t.dueAmount || t.dues || t.balance || 0) > 0).length,
            };
        }
        
        // ===== OCCUPANCY REPORTS =====
        else if (category === 'Occupancy' || reportName?.includes('Occupancy') || reportName?.includes('Bed') || reportName?.includes('Room')) {
            const { rooms, propTitleMap } = await fetchRoomsForReport(ownerLoginId, propertyId);
            reportData = rooms.map(r => formatOccupancyRow(r, propTitleMap));
            kpis = calcOccupancyKpis(rooms);
        }
        
        // ===== TENANT REPORTS =====
        else if (category === 'Tenant' || reportName?.includes('Tenant')) {
            const { tenants, propTitleMap } = await fetchTenantsForReport(ownerLoginId, {
                propertyId,
                status: status || null,
            });

            reportData = tenants.map(t => formatTenantRow(t, propTitleMap));
            kpis = {
                totalTenants: tenants.length,
                activeTenants: tenants.filter(t => t.status === 'active').length,
            };
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
router.get('/history/:ownerLoginId', ...requireOwnerAccess('ownerLoginId'), async (req, res) => {
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
router.get('/summary/:ownerLoginId', ...requireOwnerAccess('ownerLoginId'), async (req, res) => {
    try {
        const Tenant = require('../models/Tenant');
        const Complaint = require('../models/Complaint');
        const PropertyEnquiry = require('../models/PropertyEnquiry');
        const Rent = require('../models/Rent');
        const Room = require('../models/Room');
        const { ownerLoginId } = req.params;

        const properties = await getOwnerProperties(ownerLoginId);
        const propertyIds = properties.map(p => p._id);
        const tenantFilter = propertyIds.length
            ? { $or: [{ ownerLoginId }, { property: { $in: propertyIds } }], isDeleted: { $ne: true } }
            : { ownerLoginId, isDeleted: { $ne: true } };

        const [
            activeTenants, openComplaints, allLeads,
            recentRents, roomDocs
        ] = await Promise.allSettled([
            Tenant.countDocuments({ ...tenantFilter, status: 'active' }),
            Complaint.countDocuments({ ownerLoginId, status: { $in: ['Open', 'Pending'] } }),
            PropertyEnquiry.countDocuments({ ownerLoginId }),
            Rent.find({ ownerLoginId, paymentStatus: { $in: ['paid', 'completed'] } }).sort({ createdAt: -1 }).limit(100),
            propertyIds.length
                ? Room.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } }).select('beds bedAssignments isAvailable').lean()
                : Promise.resolve([]),
        ]);

        const totalRevenue = recentRents.status === 'fulfilled'
            ? recentRents.value.reduce((s, r) => s + (r.rentAmount || r.paidAmount || r.amount || 0), 0) : 0;

        const allRooms = roomDocs.status === 'fulfilled' ? roomDocs.value : [];
        const occ = calcOccupancyKpis(allRooms);
        const occupancyPct = occ.occupancyRate;

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
 * GET /api/reports/demand/:ownerLoginId
 * Fetch demand analytics and price optimization suggestions for an owner's properties
 */
router.get('/demand/:ownerLoginId', ...requireOwnerAccess('ownerLoginId'), ownerDemandCache, async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const Property = require('../models/Property');
        const Enquiry = require('../models/Enquiry');
        const BookingRequest = require('../models/BookingRequest');
        const mongoose = require('mongoose');

        // Find all active properties for the owner
        const properties = await Property.find({ ownerLoginId: String(ownerLoginId).trim().toUpperCase(), isDeleted: { $ne: true } }).lean();

        if (!properties || properties.length === 0) {
            return res.status(200).json({ success: true, properties: [] });
        }

        const propertyIds = properties.map(p => String(p._id));
        const propertyNames = properties.map(p => p.title);

        // Fetch all enquiries, bookings, reviews, complaints, and rents in parallel for these properties
        const [enquiries, bookings, reviews, complaints, rents] = await Promise.all([
            Enquiry.find({ 
                ownerLoginId: String(ownerLoginId).trim().toUpperCase(), 
                $or: [
                    { propertyId: { $in: propertyIds } },
                    { propertyName: { $in: propertyNames } }
                ]
            }).lean(),
            BookingRequest.find({
                owner_id: String(ownerLoginId).trim().toUpperCase(),
                $or: [
                    { property_id: { $in: propertyIds } },
                    { property_name: { $in: propertyNames } }
                ]
            }).lean(),
            mongoose.models.Review ? mongoose.model('Review').find({ propertyId: { $in: propertyIds } }).lean() : Promise.resolve([]),
            mongoose.models.Complaint ? mongoose.model('Complaint').find({ propertyId: { $in: propertyIds } }).lean() : Promise.resolve([]),
            mongoose.models.Rent ? mongoose.model('Rent').find({ propertyId: { $in: propertyIds } }).lean() : Promise.resolve([])
        ]);

        // Map data per property
        const demandReport = properties.map(p => {
            const pIdStr = String(p._id);
            const pName = p.title;

            // Filter data for this property
            const pEnquiries = enquiries.filter(e => String(e.propertyId) === pIdStr || e.propertyName === pName);
            const pBookings = bookings.filter(b => String(b.property_id) === pIdStr || b.property_name === pName);
            const pReviews = reviews.filter(r => String(r.propertyId) === pIdStr);
            const pComplaints = complaints.filter(c => String(c.propertyId) === pIdStr && ['Open', 'Pending'].includes(c.status));
            const pRents = rents.filter(r => String(r.propertyId) === pIdStr && r.paymentStatus === 'overdue');

            const views = p.views || 0;
            const clicks = p.clicks || 0;
            const inquiryCount = pEnquiries.length;
            const bookingCount = pBookings.length;
            
            // Occupancy
            const totalBeds = p.bedCount || p.totalRooms || 1;
            const occupiedBeds = p.occupiedBeds || 0;
            const occupancyPct = Math.round((occupiedBeds / totalBeds) * 100);

            // CTR
            const ctr = views > 0 ? Number(((clicks / views) * 100).toFixed(1)) : 0;
            // Lead Conversion (inquiries / views)
            const leadConv = views > 0 ? Number(((inquiryCount / views) * 100).toFixed(1)) : 0;
            // Booking Conversion
            const bookingConv = inquiryCount > 0 ? Number(((bookingCount / inquiryCount) * 100).toFixed(1)) : 0;

            // Calculate Property Health Grade
            const occScore = occupancyPct * 0.4;
            const avgRating = pReviews.length > 0 ? (pReviews.reduce((sum, r) => sum + (r.rating || 0), 0) / pReviews.length) : 4.0;
            const reviewScore = (avgRating / 5) * 20;
            const complaintScore = Math.max(0, 20 - (pComplaints.length * 4));
            const rentScore = Math.max(0, 20 - (pRents.length * 5));
            const totalScore = Math.round(occScore + reviewScore + complaintScore + rentScore);

            let healthGrade = 'B';
            if (totalScore >= 80) healthGrade = 'A';
            else if (totalScore >= 60) healthGrade = 'B';
            else if (totalScore >= 40) healthGrade = 'C';
            else healthGrade = 'D';

            // Revenue Forecasting
            const rentVal = p.monthlyRent || 0;
            const forecastedRevenue = occupiedBeds * rentVal;

            // Classify Demand Status & Recommendations
            let status = 'Stable';
            let recommendation = 'Pricing and metrics are balanced. Continue maintaining quality and collect reviews.';
            let actionType = 'none'; // 'optimize' | 'none'
            let suggestionValue = null;

            if (occupancyPct >= 80) {
                status = '🔥 High Demand';
                recommendation = `High occupancy (${occupancyPct}%). The property is in hot demand. You can consider a slight 5-8% increase in rent for new listings to increase yield.`;
                actionType = 'optimize';
                suggestionValue = Math.round(rentVal * 1.05); // suggest 5% increase
            } else if (occupancyPct < 50) {
                if (views > 50 && inquiryCount === 0) {
                    status = '📢 High Interest, No Leads';
                    recommendation = `Good visitor views (${views}) but zero inquiries. The pricing (₹${rentVal}) might be too high for this area or photos are unappealing. We recommend lowering the monthly rent by 5-10% to boost conversions.`;
                    actionType = 'optimize';
                    suggestionValue = Math.round(rentVal * 0.92); // suggest ~8% decrease
                } else if (views < 20) {
                    status = '⚠️ Low Visibility';
                    recommendation = `Very low views (${views}). Potential tenants are not seeing your property. Recommend promoting it as a Featured Listing or updating photos to get higher search results.`;
                    actionType = 'none';
                } else {
                    status = '⚠️ Low Demand';
                    recommendation = `Low occupancy and low inquiries. We recommend lowering the monthly rent by 5-10% to attract budget-conscious tenants.`;
                    actionType = 'optimize';
                    suggestionValue = Math.round(rentVal * 0.90); // suggest 10% decrease
                }
            } else {
                status = '🟢 Stable';
            }

            return {
                id: p._id,
                title: p.title,
                city: p.city || 'GEN',
                locality: p.locality || 'N/A',
                monthlyRent: rentVal,
                discount: p.discount || 0,
                views,
                clicks,
                inquiryCount,
                bookingCount,
                occupancyPct,
                ctr,
                leadConv,
                bookingConv,
                status,
                recommendation,
                actionType,
                suggestionValue,
                healthGrade,
                healthScore: totalScore,
                forecastedRevenue,
                featuredImage: p.featuredImage || (p.images && p.images[0]) || 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=400&h=300&fit=crop'
            };
        });

        return res.status(200).json({ success: true, properties: demandReport });
    } catch (err) {
        console.error('Error fetching demand report:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/reports/superadmin/demand
 * Fetch global property demand stats for superadmin
 */
const { checkModuleAccess, checkNotRestricted } = require('../middleware/employeeScope');
const { applyPropertyScope, applyVisitScope, applyBookingScope, applyComplaintScope, applyReportScope } = require('../utils/scopeHelpers');
const { MODULE_KEYS, RESTRICTED_KEYS } = require('../utils/permissionKeys');

/**
 * GET /api/reports/employee/performance
 * ────────────────────────────────────────────────────────────────────────
 * Area-scoped performance report for employees.
 * Blocks revenue/growth/staff/company reports BEFORE any DB query runs.
 *
 * Query param: type = occupancy | leads | visits | complaints | location
 */
router.get(
  '/employee/performance',
  protect,
  authorize('superadmin', 'employee', 'manager'),
  applyEmployeeScope,
  checkModuleAccess(MODULE_KEYS.REPORT_ANALYTICS),
  async (req, res) => {
    try {
      const { type = 'occupancy' } = req.query;

      // Map report type to its restricted key — return 403 BEFORE any query
      const typeToRestrictedKey = {
        revenue:  RESTRICTED_KEYS.RPT_REVENUE,
        growth:   RESTRICTED_KEYS.RPT_GROWTH,
        staff:    RESTRICTED_KEYS.RPT_STAFF,
        company:  RESTRICTED_KEYS.RPT_COMPANY,
      };

      const restrictedKey = typeToRestrictedKey[type] || null;
      const geoFilter = applyReportScope(req, res, restrictedKey);
      if (geoFilter === null) return; // 403 already sent by applyReportScope

      const scope = req.employeeScope;
      const Property = require('../models/Property');
      const VisitData = require('../models/VisitData');

      // Allowed employee reports: occupancy, leads, visits, complaints, location
      if (type === 'occupancy') {
        const propFilter = applyPropertyScope(req, {});
        const props = await Property.find(propFilter)
          .select('title area city bedCount occupiedBeds status')
          .limit(100)
          .lean();

        const data = props.map(p => ({
          property: p.title,
          area: p.area,
          city: p.city,
          totalBeds: p.bedCount || 0,
          occupiedBeds: p.occupiedBeds || 0,
          occupancyPct: p.bedCount > 0 ? Math.round((p.occupiedBeds || 0) / p.bedCount * 100) : 0,
        }));

        return res.json({ success: true, type, data });
      }

      if (type === 'visits') {
        const visitFilter = applyVisitScope(req, {});
        const visits = await VisitData.find(visitFilter)
          .select('status propertyInfo.name submittedAt area')
          .sort({ submittedAt: -1 })
          .limit(200)
          .lean();

        return res.json({ success: true, type, data: visits });
      }

      if (type === 'leads') {
        const Enquiry = require('../models/Enquiry');
        const assignedIds = (scope?.assignedProperties || []).map(String);
        const filter = assignedIds.length > 0
          ? { propertyId: { $in: assignedIds } }
          : { city: scope?.city || '' };

        const leads = await Enquiry.find(filter)
          .select('name phone propertyName status createdAt')
          .sort({ createdAt: -1 })
          .limit(200)
          .lean();

        return res.json({ success: true, type, data: leads });
      }

      if (type === 'complaints') {
        const Complaint = require('../models/Complaint');
        const complaintFilter = applyComplaintScope(req, {});
        const complaints = await Complaint.find(complaintFilter)
          .select('tenantName propertyName category priority status createdAt')
          .sort({ createdAt: -1 })
          .limit(200)
          .lean();

        return res.json({ success: true, type, data: complaints });
      }

      if (type === 'location') {
        const propFilter = applyPropertyScope(req, {});
        const locData = await Property.aggregate([
          { $match: propFilter },
          { $group: {
            _id: { city: '$city', area: '$area' },
            propertyCount: { $sum: 1 },
            totalBeds: { $sum: '$bedCount' },
            occupiedBeds: { $sum: '$occupiedBeds' },
          }},
          { $limit: 50 },
        ]);
        return res.json({ success: true, type, data: locData });
      }

      return res.status(400).json({ success: false, message: `Unknown report type: ${type}` });

    } catch (err) {
      console.error('[employee report] error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.get('/superadmin/demand', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
    try {
        const Property = require('../models/Property');
        const Enquiry = require('../models/Enquiry');
        const BookingRequest = require('../models/BookingRequest');

        const propFilter = applyPropertyScope(req, { isDeleted: { $ne: true } });

        // Fetch properties, enquiries, and bookings scoped to employee
        const [properties, enquiries, bookings] = await Promise.all([
            Property.find(propFilter).lean(),
            Enquiry.find().lean(),
            BookingRequest.find().lean()
        ]);

        const demandReport = properties.map(p => {
            const pIdStr = String(p._id);
            const pName = p.title;

            // Filter enquiries and bookings
            const pEnquiries = enquiries.filter(e => String(e.propertyId) === pIdStr || e.propertyName === pName);
            const pBookings = bookings.filter(b => String(b.property_id) === pIdStr || b.property_name === pName);

            const views = p.views || 0;
            const clicks = p.clicks || 0;
            const inquiryCount = pEnquiries.length;
            const bookingCount = pBookings.length;

            const totalBeds = p.bedCount || p.totalRooms || 1;
            const occupiedBeds = p.occupiedBeds || 0;
            const occupancyPct = Math.round((occupiedBeds / totalBeds) * 100);

            // Compute Grade (simplistic calculation for global report)
            let healthGrade = 'B';
            if (occupancyPct >= 80) healthGrade = 'A';
            else if (occupancyPct >= 50) healthGrade = 'B';
            else if (occupancyPct >= 30) healthGrade = 'C';
            else healthGrade = 'D';

            let status = 'Stable';
            if (occupancyPct >= 80) {
                status = '🔥 High Demand';
            } else if (occupancyPct < 50) {
                if (views > 50 && inquiryCount === 0) {
                    status = '📢 High Interest, No Leads';
                } else if (views < 20) {
                    status = '⚠️ Low Visibility';
                } else {
                    status = '⚠️ Low Demand';
                }
            } else {
                status = '🟢 Stable';
            }

            return {
                id: p._id,
                title: p.title,
                ownerLoginId: p.ownerLoginId,
                ownerName: p.ownerName,
                ownerPhone: p.ownerPhone,
                city: p.city || 'Unknown',
                locality: p.locality || 'Unknown',
                monthlyRent: p.monthlyRent || 0,
                views,
                clicks,
                inquiryCount,
                bookingCount,
                occupancyPct,
                status,
                healthGrade
            };
        });

        res.json({ success: true, properties: demandReport });
    } catch (err) {
        console.error('Error fetching global demand report:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/reports/locality-analytics
 * Fetch global locality-wise demand and metrics for Area Demand Heatmap
 */
router.get('/locality-analytics', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const Property = require('../models/Property');
        const Enquiry = require('../models/Enquiry');

        const [properties, enquiries] = await Promise.all([
            Property.find({ isDeleted: { $ne: true } }).lean(),
            Enquiry.find().lean()
        ]);

        const localityMap = {};

        properties.forEach(p => {
            const locality = p.locality || 'Other';
            const city = p.city || 'Unknown';
            const key = `${locality}, ${city}`;

            if (!localityMap[key]) {
                localityMap[key] = {
                    locality,
                    city,
                    totalProperties: 0,
                    totalBeds: 0,
                    occupiedBeds: 0,
                    totalViews: 0,
                    totalRent: 0,
                    propertyCountWithRent: 0,
                    inquiryCount: 0
                };
            }

            const locData = localityMap[key];
            locData.totalProperties++;
            locData.totalBeds += (p.bedCount || p.totalRooms || 0);
            locData.occupiedBeds += (p.occupiedBeds || 0);
            locData.totalViews += (p.views || 0);
            if (p.monthlyRent) {
                locData.totalRent += p.monthlyRent;
                locData.propertyCountWithRent++;
            }
        });

        // Add inquiry count per locality
        enquiries.forEach(e => {
            const city = e.location || 'Unknown';
            for (const key of Object.keys(localityMap)) {
                if (key.toLowerCase().includes(city.toLowerCase())) {
                    localityMap[key].inquiryCount++;
                }
            }
        });

        const report = Object.values(localityMap).map(loc => {
            const occupancyPct = loc.totalBeds > 0 ? Math.round((loc.occupiedBeds / loc.totalBeds) * 100) : 0;
            const avgRent = loc.propertyCountWithRent > 0 ? Math.round(loc.totalRent / loc.propertyCountWithRent) : 0;

            let status = 'Medium Demand';
            if (occupancyPct >= 80 || loc.inquiryCount > 10) {
                status = 'High Demand';
            } else if (occupancyPct < 40) {
                status = 'Low Demand';
            }

            return {
                locality: loc.locality,
                city: loc.city,
                totalProperties: loc.totalProperties,
                occupancyPct,
                avgRent,
                inquiryCount: loc.inquiryCount,
                views: loc.totalViews,
                status
            };
        });

        res.json({ success: true, localities: report });
    } catch (err) {
        console.error('Error generating locality analytics:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/reports/bulk-rent-update
 * Bulk update rent for selected properties (Superadmin action)
 */
router.post('/bulk-rent-update', protect, authorize('superadmin'), async (req, res) => {
    try {
        const { propertyIds, type, amount } = req.body;
        
        if (!propertyIds || !Array.isArray(propertyIds) || propertyIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or empty propertyIds array' });
        }
        if (!type || amount === undefined || isNaN(Number(amount))) {
            return res.status(400).json({ success: false, message: 'Invalid update parameters' });
        }

        const Property = require('../models/Property');
        const ApprovedProperty = require('../models/ApprovedProperty');

        const properties = await Property.find({ _id: { $in: propertyIds } });
        
        for (const p of properties) {
            let newRent = p.monthlyRent || 0;
            if (type === 'percentage') {
                newRent = Math.round(newRent * (1 + Number(amount) / 100));
            } else {
                newRent = Math.round(newRent + Number(amount));
            }
            
            p.monthlyRent = Math.max(0, newRent);
            await p.save();

            // Sync with ApprovedProperty
            try {
                // Direct update to ApprovedProperty
                await ApprovedProperty.findOneAndUpdate(
                    { propertyId: p._id.toString() },
                    { $set: { 'propertyInfo.rent': p.monthlyRent } }
                );
            } catch (_) {}
        }

        res.json({ success: true, message: `Successfully updated rent for ${properties.length} properties.` });
    } catch (err) {
        console.error('Bulk rent update error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
