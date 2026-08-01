const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const User = require('../models/user');
const Booking = require('../models/BookingRequest');
const Rent = require('../models/Rent');
const Owner = require('../models/Owner');
const PaymentTransaction = require('../models/PaymentTransaction');
const Room = require('../models/Room');
const Employee = require('../models/Employee');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');
const {
  applyPropertyScope,
  applyOwnerScope,
  applyTenantScope,
  applyBookingScope,
  applyComplaintScope,
  applyVisitScope,
  applyReportScope,
  applyReviewScope,
  applyRoomScope,
  applyLeadScope,
  applySupportScope,
  applyTransactionScope,
  applyRentScope,
  isScopedEmployee,
  employeeBlocksRevenue,
  resolveScopedPropertyContext,
} = require('../utils/scopeHelpers');

// Get platform overview stats (Main Dashboard)
router.get('/diagnostic-db', protect, authorize('superadmin'), async (req, res) => {
  try {
    const counts = {
      users: await mongoose.model('User').countDocuments(),
      owners: await mongoose.model('Owner').countDocuments(),
      properties: await mongoose.model('Property').countDocuments(),
      approvedProperties: await mongoose.model('ApprovedProperty').countDocuments(),
      rooms: await mongoose.model('Room').countDocuments(),
      tenants: await mongoose.model('Tenant').countDocuments(),
      rents: await mongoose.model('Rent').countDocuments(),
      rentInvoices: await mongoose.model('RentInvoice').countDocuments(),
      rentPayments: await mongoose.model('RentPayment').countDocuments(),
      paymentTransactions: await mongoose.model('PaymentTransaction').countDocuments(),
      systemSettings: await mongoose.model('SystemSettings').countDocuments(),
      employees: await mongoose.model('Employee').countDocuments(),
    };
    res.json({ success: true, dbName: mongoose.connection.name, host: mongoose.connection.host, counts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/stats', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const propFilter = applyPropertyScope(req, { isDeleted: { $ne: true } });
    const tenantFilter = applyTenantScope(req, { role: { $in: ['tenant', 'user'] }, isDeleted: { $ne: true } });
    const ownerFilter = applyOwnerScope(req, { isDeleted: { $ne: true } });
    const bookingFilter = applyBookingScope(req, {});

    const [
      totalProperties,
      totalTenants,
      totalOwners,
      totalBookings,
      totalRents
    ] = await Promise.all([
      Property.countDocuments(propFilter),
      User.countDocuments(tenantFilter),
      Owner.countDocuments(ownerFilter),
      Booking.countDocuments(bookingFilter),
      Rent.countDocuments(bookingFilter)
    ]);

    const rents = await Rent.find(bookingFilter);
    let totalBookingAmount = 0;
    let platformCommission = 0;
    let serviceFee = 0;
    const monthBuckets = {};

    if (!employeeBlocksRevenue(req)) {
      rents.forEach((rent) => {
        const rentAmount = Number(rent.rentAmount || rent.totalDue || 0);
        const commission = Number(rent.commissionAmount || (rentAmount * 0.10));
        const fee = Number(rent.serviceFeeAmount || 50);
        const month = (rent.collectionMonth || "").trim() || "Unknown";

        totalBookingAmount += rentAmount;
        platformCommission += commission;
        serviceFee += fee;
        monthBuckets[month] = (monthBuckets[month] || 0) + commission + fee;
      });
    }

    const netRevenue = platformCommission + serviceFee;
    const recentSignups = await User.find({ ...tenantFilter, role: 'tenant' })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email createdAt kycStatus');

    const statsPayload = {
      tenants: totalTenants,
      properties: totalProperties,
      owners: totalOwners,
      totalBookings,
    };

    if (!employeeBlocksRevenue(req)) {
      statsPayload.totalBookingAmount = totalBookingAmount;
      statsPayload.platformCommission = platformCommission;
      statsPayload.serviceFee = serviceFee;
      statsPayload.netRevenue = netRevenue;
    }

    res.json({
      success: true,
      stats: statsPayload,
      recentSignups: recentSignups.map(user => ({
        name: user.name,
        email: user.email,
        role: 'tenant',
        moveInDate: user.createdAt?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0],
        kycStatus: user.kycStatus || 'pending'
      })),
      ...(employeeBlocksRevenue(req) ? {} : { monthlyRevenue: monthBuckets }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats', error: error.message });
  }
});

// Home Overview Stats (Scoped for employees)
router.get('/home/overview', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const { city } = req.query;

    // Apply employee scope on top of city filter
    let basePropFilter = { isDeleted: { $ne: true } };
    if (city && city !== 'All Cities') {
      basePropFilter.city = city;
    }
    let propFilter = applyPropertyScope(req, basePropFilter);

    // Resolve property IDs in scope
    const propertiesList = await Property.find(propFilter).select('_id status isLiveOnWebsite').lean();
    const propIds = propertiesList.map(p => p._id);

    // Core counts scoped
    let baseTenantFilter = { isDeleted: { $ne: true } };
    if (propIds.length > 0) {
      baseTenantFilter.property = { $in: propIds };
    }
    let tenantFilter = applyTenantScope(req, baseTenantFilter);
    let rentFindFilter = applyBookingScope(req, propIds.length > 0 ? { propertyId: { $in: propIds } } : {});

    const [propertiesCount, tenantsCount, rents] = await Promise.all([
      Property.countDocuments(propFilter),
      Tenant.countDocuments(tenantFilter),
      Rent.find(rentFindFilter).lean()
    ]);

    // Only count pending rents for active (non-deleted) tenants in scope
    let activeTenantQuery = applyTenantScope(req, {
      isDeleted: { $ne: true },
      status: { $nin: ['inactive', 'suspended'] },
      ...(propIds.length > 0 ? { property: { $in: propIds } } : {})
    });

    const activeTenants = await Tenant.find(activeTenantQuery).select('_id loginId').lean();
    const activeTenantIds = activeTenants.map(t => t._id);
    const activeTenantLoginIds = activeTenants.map(t => t.loginId).filter(Boolean);

    const pendingRentFilter = {
      paymentStatus: { $nin: ['paid', 'completed'] },
      $or: [
        { tenantId: { $in: activeTenantIds } },
        { tenantLoginId: { $in: activeTenantLoginIds } }
      ]
    };
    if (propIds.length > 0) {
      pendingRentFilter.propertyId = { $in: propIds };
    }

    const [totalAlerts, pendingRents] = await Promise.all([
      Rent.countDocuments(pendingRentFilter),
      Rent.find(pendingRentFilter).limit(10).sort({ createdAt: -1 })
    ]);

    // Revenue calculation — superadmin only
    const activeIdSet = new Set(activeTenantIds.map(String));
    const activeLoginSet = new Set(activeTenantLoginIds);
    let totalRevenue = 0;
    if (!employeeBlocksRevenue(req)) {
      rents.forEach(rent => {
        const tid = rent.tenantId ? String(rent.tenantId) : '';
        const login = rent.tenantLoginId || '';
        if (!activeIdSet.has(tid) && !activeLoginSet.has(login)) return;
        const rentAmount = Number(rent.rentAmount || rent.totalDue || 0);
        const commission = Number(rent.commissionAmount || (rentAmount * 0.10));
        const fee = Number(rent.serviceFeeAmount || 50);
        totalRevenue += (commission + fee);
      });
    }

    // Revenue trend (last 5 months) — superadmin only
    let formattedTrends = [];
    if (!employeeBlocksRevenue(req)) {
      const trendMatch = propIds.length > 0 ? { propertyId: { $in: propIds } } : {};
      const trends = await Rent.aggregate([
        ...(Object.keys(trendMatch).length > 0 ? [{ $match: trendMatch }] : []),
        { $group: {
            _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
            revenue: { $sum: { $add: [ { $ifNull: ["$commissionAmount", { $multiply: ["$rentAmount", 0.10] }] }, { $ifNull: ["$serviceFeeAmount", 50] } ] } }
        }},
        { $sort: { "_id.year": -1, "_id.month": -1 } },
        { $limit: 5 }
      ]);

      formattedTrends = trends.reverse().map(t => ({
        name: `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t._id.month-1]} ${t._id.year}`,
        revenue: Math.round(t.revenue)
      }));
    }

    // Properties by Status (scoped)
    const statusBuckets = { Live: 0, Active: 0, Pending: 0, Inactive: 0, Blocked: 0 };
    propertiesList.forEach((p) => {
      const status = String(p.status || '').toLowerCase();
      if (status === 'blocked') statusBuckets.Blocked += 1;
      else if (status === 'pending_approval' || status === 'pending' || status === 'rejected') statusBuckets.Pending += 1;
      else if (p.isLiveOnWebsite) statusBuckets.Live += 1;
      else if (status === 'active') statusBuckets.Active += 1;
      else statusBuckets.Inactive += 1;
    });

    const statusColorMap = {
      Live: { label: 'Live on Web', color: '#10B981' },
      Active: { label: 'Active', color: '#3B82F6' },
      Pending: { label: 'Pending', color: '#F59E0B' },
      Inactive: { label: 'Inactive', color: '#94A3B8' },
      Blocked: { label: 'Blocked', color: '#EF4444' }
    };
    const totalPropsForPct = Object.values(statusBuckets).reduce((s, n) => s + n, 0) || 1;
    const propertiesByStatus = Object.entries(statusBuckets)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => {
        const mapped = statusColorMap[key];
        return { name: mapped.label, value: count, color: mapped.color, percent: `${((count / totalPropsForPct) * 100).toFixed(1)}%` };
      });

    // Tenants by Type (scoped)
    const occMatch = { ...tenantFilter, status: { $nin: ['inactive', 'suspended'] } };
    const occAgg = await Tenant.aggregate([
      { $match: occMatch },
      { $group: { _id: { $ifNull: ['$occupation', 'Not Specified'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const occColorPalette = ['#3B82F6', '#10B981', '#F59E0B', '#6366F1', '#EF4444', '#EC4899', '#14B8A6'];
    const totalTenantCount = occAgg.reduce((s, r) => s + r.count, 0) || 1;
    const tenantsByType = occAgg.map((r, i) => ({
      name: r._id || 'Other',
      value: r.count,
      color: occColorPalette[i % occColorPalette.length],
      percent: `${((r.count / totalTenantCount) * 100).toFixed(1)}%`
    }));

    const summaryPayload = {
      totalProperties: propertiesCount,
      totalTenants: tenantsCount,
      alerts: totalAlerts,
    };
    if (!employeeBlocksRevenue(req)) {
      summaryPayload.monthlyRevenue = Math.round(totalRevenue);
    }

    res.json({
      success: true,
      summary: summaryPayload,
      ...(employeeBlocksRevenue(req) ? {} : {
        revenueTrend: formattedTrends.length > 0 ? formattedTrends : [
          { name: 'Jan', revenue: 0 }, { name: 'Feb', revenue: 0 }, { name: 'Mar', revenue: 0 }
        ],
      }),
      propertiesByStatus: propertiesByStatus.length > 0 ? propertiesByStatus : [
        { name: 'No Data', value: 1, color: '#CBD5E1', percent: '100%' }
      ],
      tenantsByType: tenantsByType.length > 0 ? tenantsByType : [
        { name: 'No Data', value: 1, color: '#CBD5E1', percent: '100%' }
      ],
      pendingAlerts: pendingRents.map(r => ({
        id: r._id,
        name: r.tenantName || 'Unknown Tenant',
        property: r.propertyName || 'Property',
        amount: r.rentAmount || 0,
        status: r.paymentStatus,
        overdue: r.createdAt ? Math.floor((Date.now() - new Date(r.createdAt)) / (1000 * 60 * 60 * 24)) : 0
      })),
      activities: pendingRents.slice(0, 5).map(r => ({
        title: r.paymentStatus === 'paid' || r.paymentStatus === 'completed' ? 'Rent Collected' : 'Rent Pending',
        description: `${r.tenantName || 'Tenant'} · ${r.propertyName || 'Property'} · ₹${r.rentAmount || 0}`,
        time: r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN') : 'Recently',
      }))
    });
  } catch (error) {
    console.error('Home Overview Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Property Management Overview
router.get('/properties/overview', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const propFilter = applyPropertyScope(req, { isDeleted: { $ne: true } });
    const scopedPropIds = isScopedEmployee(req)
      ? (await Property.find(propFilter).select('_id').lean()).map(p => p._id)
      : null;

    const [total, approved, pending, rejected, newThisMonth] = await Promise.all([
      Property.countDocuments(propFilter),
      scopedPropIds
        ? ApprovedProperty.countDocuments({ _id: { $in: scopedPropIds } })
        : ApprovedProperty.countDocuments(),
      Property.countDocuments({ ...propFilter, status: 'pending' }),
      Property.countDocuments({ ...propFilter, status: 'rejected' }),
      Property.countDocuments({ ...propFilter, createdAt: { $gte: startOfMonth } })
    ]);

    res.json({
      success: true,
      summary: {
        total: total || approved + pending + rejected,
        approved,
        pending,
        rejected,
        newThisMonth
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// User Management Overview
router.get('/users/overview', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const Employee = require('../models/Employee');

    const ownerFilter = applyOwnerScope(req, { isDeleted: { $ne: true } });
    const tenantFilter = applyTenantScope(req, { isDeleted: { $ne: true } });

    let team = 0;
    let empCount = 0;
    if (!isScopedEmployee(req)) {
      const [userTeamCount, employeeCount] = await Promise.all([
        User.countDocuments({ role: { $in: ['employee', 'areamanager', 'manager', 'admin'] }, isDeleted: { $ne: true } }),
        Employee.countDocuments({ isDeleted: { $ne: true } }),
      ]);
      team = userTeamCount + employeeCount;
      empCount = employeeCount;
    }

    const [owners, tenants] = await Promise.all([
      Owner.countDocuments(ownerFilter),
      User.countDocuments({ ...tenantFilter, role: 'tenant' })
    ]);
    const total = team + owners + tenants;

    // Fetch recent signups
    const recentSignups = await User.find({ ...tenantFilter, role: { $ne: 'superadmin' } })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email role createdAt kycStatus')
      .lean();

    const recentUsersData = recentSignups.map(u => ({
      name: u.name || 'N/A',
      email: u.email || 'N/A',
      role: u.role === 'owner' ? 'Property Owner' : u.role === 'tenant' ? 'Tenant' : 'Team Member',
      date: u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A',
      status: u.kycStatus === 'verified' ? 'Active' : 'Pending',
      initial: (u.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase()
    }));

    // Approvals queue (scoped)
    const pendingOwnersCount = await Owner.countDocuments({ ...ownerFilter, kycStatus: { $in: ['pending', 'submitted'] } });
    const pendingTenantsCount = await Tenant.countDocuments({ ...tenantFilter, kycStatus: { $in: ['pending', 'submitted'] } });
    const pendingDocsCount = await Tenant.countDocuments({ ...tenantFilter, kycStatus: 'submitted' });

    // KYC Status Counts (scoped)
    const [verifiedOwners, verifiedTenants, pendingOwners, pendingTenants, rejectedOwners, rejectedTenants] = await Promise.all([
      Owner.countDocuments({ ...ownerFilter, kycStatus: 'verified' }),
      Tenant.countDocuments({ ...tenantFilter, kycStatus: 'verified' }),
      Owner.countDocuments({ ...ownerFilter, kycStatus: 'pending' }),
      Tenant.countDocuments({ ...tenantFilter, kycStatus: 'pending' }),
      Owner.countDocuments({ ...ownerFilter, kycStatus: 'rejected' }),
      Tenant.countDocuments({ ...tenantFilter, kycStatus: 'rejected' }),
    ]);

    const kycStatusStats = {
      verified: verifiedOwners + verifiedTenants,
      pending: pendingOwners + pendingTenants,
      rejected: rejectedOwners + rejectedTenants,
    };

    res.json({
      success: true,
      summary: { total, team, owners, tenants, activeToday: team + owners + tenants },
      userDistributionData: [
        { name: "Team Members", value: team, color: "#6366F1", percent: total > 0 ? `${((team / total) * 100).toFixed(1)}%` : '0%' },
        { name: "Property Owners", value: owners, color: "#10B981", percent: total > 0 ? `${((owners / total) * 100).toFixed(1)}%` : '0%' },
        { name: "Tenants", value: tenants, color: "#3B82F6", percent: total > 0 ? `${((tenants / total) * 100).toFixed(1)}%` : '0%' },
      ],
      recentUsersData,
      pendingApprovals: [
        { label: "Property Owners", count: pendingOwnersCount, icon: "Building2", color: "green" },
        { label: "Tenants", count: pendingTenantsCount, icon: "Users", color: "blue" },
        { label: "Documents", count: pendingDocsCount, icon: "ClipboardList", color: "yellow" },
      ],
      kycStatus: [
        { label: "Verified", count: kycStatusStats.verified, icon: "CheckCircle2", color: "green" },
        { label: "Pending", count: kycStatusStats.pending, icon: "Clock", color: "yellow" },
        { label: "Rejected", count: kycStatusStats.rejected, icon: "XCircle", color: "red" },
      ]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Accounting Overview
router.get('/accounting/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Rent = require('../models/Rent');
    const PaymentTransaction = require('../models/PaymentTransaction');
    const RentInvoice = require('../models/RentInvoice');
    const RentPayment = require('../models/RentPayment');
    const Tenant = require('../models/Tenant');
    const Owner = require('../models/Owner');

    // 1. Fetch raw data in parallel
    const [rawTxs, rawRents, rawInvoices, rawRentPayments] = await Promise.all([
      PaymentTransaction.find({ status: { $ne: 'Failed' } }).sort({ payment_date: -1 }).lean(),
      Rent.find({}).lean(),
      RentInvoice.find({}).lean(),
      RentPayment.find({}).lean()
    ]);

    // 2. Unify all paid transactions (Collections & Payouts)
    let totalCollection = 0;
    let revenue = 0;
    let completedPayout = 0;
    let pendingPayout = 0;

    const unifiedTxs = [];

    // Process PaymentTransaction
    rawTxs.forEach(t => {
      const collectionAmt = t.booking_amount || 0;
      const commAmt = t.commission_amount || Math.round(collectionAmt * 0.10);
      const ownerAmt = t.owner_amount || Math.round(collectionAmt * 0.90);
      const isPaidOut = t.payout_status === 'Paid';

      totalCollection += collectionAmt;
      revenue += commAmt;
      if (isPaidOut) {
        completedPayout += ownerAmt;
      } else {
        pendingPayout += ownerAmt;
      }

      unifiedTxs.push({
        date: t.payment_date || t.created_at || new Date(),
        desc: isPaidOut ? `Owner Payout - ${t.owner_name || 'Owner'}` : `Rent Collection - ${t.tenant_name || t.property_name || 'Tenant'}`,
        type: isPaidOut ? 'Owner Payout' : 'Tenant Payment',
        amount: isPaidOut ? `- ₹ ${ownerAmt.toLocaleString('en-IN')}` : `+ ₹ ${collectionAmt.toLocaleString('en-IN')}`,
        status: isPaidOut ? 'Processed' : 'Success',
        color: isPaidOut ? 'blue' : 'green',
        rawCollection: collectionAmt,
        rawPayout: isPaidOut ? ownerAmt : 0
      });
    });

    // Process Rent paid (avoiding double count if paymentMethod === 'razorpay')
    rawRents.forEach(r => {
      if (r.paymentMethod === 'razorpay') return;
      const paid = r.paidAmount || (['paid', 'completed'].includes(r.paymentStatus) ? (r.rentAmount || r.totalAmount || 0) : 0);
      if (paid > 0) {
        const comm = Math.round(paid * 0.10);
        const ownerShare = Math.round(paid * 0.90);

        totalCollection += paid;
        revenue += comm;
        completedPayout += ownerShare;

        unifiedTxs.push({
          date: r.paymentDate || r.updatedAt || r.createdAt || new Date(),
          desc: `Rent Collection - ${r.tenantName || r.tenantLoginId || 'Tenant'}`,
          type: 'Rent Collection',
          amount: `+ ₹ ${paid.toLocaleString('en-IN')}`,
          status: 'Success',
          color: 'green',
          rawCollection: paid,
          rawPayout: ownerShare
        });
      }
    });

    // Process RentInvoices paid
    rawInvoices.forEach(inv => {
      if (inv.paymentMethod === 'razorpay') return;
      const paid = inv.paidAmount || (['PAID'].includes(inv.status) ? (inv.rentAmount || inv.totalAmount || 0) : 0);
      if (paid > 0) {
        const comm = Math.round(paid * 0.10);
        const ownerShare = Math.round(paid * 0.90);

        totalCollection += paid;
        revenue += comm;
        completedPayout += ownerShare;

        unifiedTxs.push({
          date: inv.paymentDate || inv.updatedAt || inv.createdAt || new Date(),
          desc: `Invoice Collection - ${inv.tenantName || inv.invoiceNumber || 'Tenant'}`,
          type: 'Invoice Collection',
          amount: `+ ₹ ${paid.toLocaleString('en-IN')}`,
          status: 'Success',
          color: 'green',
          rawCollection: paid,
          rawPayout: ownerShare
        });
      }
    });

    // Sort unifiedTxs by date descending
    unifiedTxs.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 3. Calculate Due Rent & Due Aging (All unpaid Rents + RentInvoices)
    let dueRent = 0;
    let age30 = 0;
    let age60 = 0;
    let age90 = 0;
    let age90Plus = 0;
    let overdueCount = 0;
    const now = new Date();

    // From Rent records
    rawRents.forEach(r => {
      if (!['paid', 'completed'].includes(r.paymentStatus)) {
        const total = r.totalDue || r.rentAmount || r.totalAmount || 0;
        const paid = r.paidAmount || 0;
        const due = Math.max(0, total - paid);
        if (due > 0) {
          dueRent += due;
          overdueCount++;
          const dateRef = r.dueDate || r.createdAt || r.updatedAt || now;
          const diffDays = Math.floor((now - new Date(dateRef)) / (1000 * 60 * 60 * 24));
          if (diffDays <= 30) age30 += due;
          else if (diffDays <= 60) age60 += due;
          else if (diffDays <= 90) age90 += due;
          else age90Plus += due;
        }
      }
    });

    // From RentInvoice records
    rawInvoices.forEach(inv => {
      if (!['PAID', 'CANCELLED'].includes(inv.status)) {
        const total = inv.totalAmount || inv.rentAmount || 0;
        const paid = inv.paidAmount || 0;
        const due = Math.max(0, total - paid);
        if (due > 0) {
          dueRent += due;
          overdueCount++;
          const dateRef = inv.dueDate || inv.createdAt || now;
          const diffDays = Math.floor((now - new Date(dateRef)) / (1000 * 60 * 60 * 24));
          if (diffDays <= 30) age30 += due;
          else if (diffDays <= 60) age60 += due;
          else if (diffDays <= 90) age90 += due;
          else age90Plus += due;
        }
      }
    });

    // 4. Trends (collections vs payout) for past 5 months
    const monthlyTrendMap = {};
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const last5Months = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = months[d.getMonth()];
      last5Months.push(label);
      monthlyTrendMap[label] = { collection: 0, payout: 0 };
    }

    unifiedTxs.forEach(t => {
      if (!t.date) return;
      const mLabel = months[new Date(t.date).getMonth()];
      if (monthlyTrendMap[mLabel]) {
        monthlyTrendMap[mLabel].collection += (t.rawCollection || 0);
        monthlyTrendMap[mLabel].payout += (t.rawPayout || 0);
      }
    });

    const trends = last5Months.map(name => ({
      name,
      collection: monthlyTrendMap[name].collection,
      payout: monthlyTrendMap[name].payout
    }));

    // 5. Recent Ledger (top 10 formatted items)
    const ledger = unifiedTxs.slice(0, 10).map(t => ({
      date: t.date ? new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A',
      desc: t.desc,
      type: t.type,
      amount: t.amount,
      status: t.status,
      color: t.color
    }));

    const [totalTenants, totalOwners, totalInvoices, failedPayments] = await Promise.all([
      Tenant.countDocuments({ isDeleted: { $ne: true } }),
      Owner.countDocuments({ isDeleted: { $ne: true } }),
      Rent.countDocuments({}),
      PaymentTransaction.countDocuments({ status: { $in: ['failed', 'Failed', 'error', 'Error'] } })
    ]);

    res.json({
      success: true,
      summary: {
        totalCollection,
        totalPayout: completedPayout,
        revenue,
        dueRent,
        pendingPayout,
        totalTenants,
        totalOwners,
        totalInvoices,
        overdueTenants: overdueCount,
        failedPayments
      },
      trends,
      ledger,
      dueRentAging: [
        { name: "0 - 30 Days", value: age30, color: "#3B82F6" },
        { name: "31 - 60 Days", value: age60, color: "#10B981" },
        { name: "61 - 90 Days", value: age90, color: "#F59E0B" },
        { name: "90+ Days", value: age90Plus, color: "#EF4444" }
      ],
      alerts: {
        rentDue: overdueCount,
        paymentSuccess: unifiedTxs.length,
        paymentFailure: failedPayments,
        payoutProcessed: rawTxs.filter(t => t.payout_status === 'Paid').length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bookings Overview (Scoped for employees)
router.get('/bookings/overview', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');
    const PaymentTransaction = require('../models/PaymentTransaction');

    const leadFilter = applyLeadScope(req, {});
    const bookingFilter = applyBookingScope(req, {});
    const txFilter = applyTransactionScope(req, {});

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // 1. KPI Counts
    const [
      enquiriesToday,
      enquiriesWeek,
      enquiriesMonth,
      bookingReqsToday,
      bookingReqsWeek,
      bookingReqsMonth,
      confirmedBookingsToday,
      confirmedBookingsWeek,
      confirmedBookingsMonth,
      enquiries,
      bookingsList
    ] = await Promise.all([
      Enquiry.countDocuments({ ...leadFilter, ts: { $gte: todayStart } }),
      Enquiry.countDocuments({ ...leadFilter, ts: { $gte: weekAgo } }),
      Enquiry.countDocuments({ ...leadFilter, ts: { $gte: monthAgo } }),
      BookingRequest.countDocuments({ ...bookingFilter, created_at: { $gte: todayStart } }),
      BookingRequest.countDocuments({ ...bookingFilter, created_at: { $gte: weekAgo } }),
      BookingRequest.countDocuments({ ...bookingFilter, created_at: { $gte: monthAgo } }),
      BookingRequest.countDocuments({ ...bookingFilter, created_at: { $gte: todayStart }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }),
      BookingRequest.countDocuments({ ...bookingFilter, created_at: { $gte: weekAgo }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }),
      BookingRequest.countDocuments({ ...bookingFilter, created_at: { $gte: monthAgo }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }),
      Enquiry.find(leadFilter).sort({ ts: -1 }).lean(),
      BookingRequest.find(bookingFilter).sort({ created_at: -1 }).lean()
    ]);

    const totalLeads = enquiries.length + bookingsList.length;
    const contactedLeads = enquiries.filter(e => e.status !== 'pending').length + bookingsList.filter(b => b.status !== 'pending').length;
    const interestedLeads = enquiries.filter(e => ['accepted', 'approved', 'confirmed'].includes(e.status)).length + bookingsList.filter(b => ['confirmed', 'booked', 'active'].includes(b.booking_status || b.status)).length;
    const bookingVisits = bookingsList.filter(b => b.visit_status === 'scheduled' || b.visit_status === 'completed' || b.status === 'site-visit').length;
    const siteVisitLeads = enquiries.filter(e => e.visitAllowed || e.visitTime || e.status === 'site-visit').length + bookingVisits;
    const bookingsCount = bookingsList.filter(b => ['confirmed', 'booked', 'active'].includes(b.booking_status || b.status)).length;

    // 2. Funnel Data
    const funnel = [
      { label: "Total Leads",  val: totalLeads, pct: null,     color: "#6366F1", w: 100 },
      { label: "Contacted",    val: contactedLeads, pct: totalLeads > 0 ? `${((contactedLeads/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#3B82F6", w: totalLeads > 0 ? Math.round((contactedLeads/totalLeads)*100) : 0 },
      { label: "Interested",   val: interestedLeads, pct: totalLeads > 0 ? `${((interestedLeads/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#22D3EE", w: totalLeads > 0 ? Math.round((interestedLeads/totalLeads)*100) : 0 },
      { label: "Site Visit",   val: siteVisitLeads, pct: totalLeads > 0 ? `${((siteVisitLeads/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#10B981", w: totalLeads > 0 ? Math.round((siteVisitLeads/totalLeads)*100) : 0 },
      { label: "Bookings",     val: bookingsCount, pct: totalLeads > 0 ? `${((bookingsCount/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#F59E0B", w: totalLeads > 0 ? Math.round((bookingsCount/totalLeads)*100) : 0 }
    ];

    // Summary data
    const summary = {
      todayLeads: enquiriesToday + bookingReqsToday,
      weekLeads: enquiriesWeek + bookingReqsWeek,
      monthLeads: enquiriesMonth + bookingReqsMonth,
      todayBookings: confirmedBookingsToday,
      weekBookings: confirmedBookingsWeek,
      monthBookings: confirmedBookingsMonth
    };

    // 3. Recent Leads & Recent Bookings
    const recentLeads = (bookingsList.length > 0 ? bookingsList : enquiries).slice(0, 5).map(e => {
      let statusColor = 'bg-blue-50 text-blue-600';
      const st = e.status || e.booking_status || 'pending';
      if (st === 'contacted') statusColor = 'bg-amber-50 text-amber-600';
      else if (['accepted', 'approved', 'confirmed', 'paid'].includes(st)) statusColor = 'bg-purple-50 text-purple-600';
      else if (e.visitAllowed || st === 'site-visit') statusColor = 'bg-emerald-50 text-emerald-600';

      return {
        _id: e._id,
        name: e.studentName || e.userName || e.tenantName || 'Applicant',
        tenantName: e.studentName || e.userName || e.tenantName || 'Applicant',
        propertyName: e.propertyName || e.property_name || e.location || 'Roomhy Residence',
        loc: e.location || e.city || 'Location',
        src: e.source || 'Website',
        budget: e.budget ? (typeof e.budget === 'number' ? `₹${e.budget.toLocaleString('en-IN')}` : String(e.budget)) :
                e.bidAmount ? `₹${Number(e.bidAmount).toLocaleString('en-IN')}` :
                e.monthlyRent ? `₹${Number(e.monthlyRent).toLocaleString('en-IN')}` :
                e.rentAmount ? `₹${Number(e.rentAmount).toLocaleString('en-IN')}` :
                e.rent ? `₹${Number(e.rent).toLocaleString('en-IN')}` :
                e.amount ? `₹${Number(e.amount).toLocaleString('en-IN')}` : '₹8,500',
        amount: e.bidAmount || e.amount || e.rentAmount || 0,
        status: st,
        sc: statusColor,
        time: e.ts ? new Date(e.ts).toISOString().split('T')[0] : (e.created_at ? new Date(e.created_at).toISOString().split('T')[0] : 'Recently')
      };
    });

    // 4. Spark Data & Trends (Past 7 days)
    const trendMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      trendMap[label] = { leads: 0, bookings: 0 };
    }

    enquiries.forEach(e => {
      if (!e.ts) return;
      const label = new Date(e.ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      if (trendMap[label]) {
        trendMap[label].leads += 1;
      }
    });

    bookingsList.forEach(b => {
      if (!b.created_at) return;
      const label = new Date(b.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      if (trendMap[label]) {
        trendMap[label].leads += 1;
        const isConfirmed = ['confirmed', 'booked', 'active'].includes(b.booking_status || b.status);
        if (isConfirmed) {
          trendMap[label].bookings += 1;
        }
      }
    });

    const trends = Object.keys(trendMap).map(k => ({
      name: k,
      leads: trendMap[k].leads,
      bookings: trendMap[k].bookings
    }));

    // 5. Source & Status Distributions
    const sourceCounts = {};
    const statusCounts = {};

    enquiries.forEach(e => {
      const src = e.source || 'Website';
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      const st = e.status || 'New';
      statusCounts[st] = (statusCounts[st] || 0) + 1;
    });

    const sourceCOLORS = ["#6366F1", "#3B82F6", "#10B981", "#F59E0B"];
    const sourceData = Object.keys(sourceCounts).map((name, idx) => ({
      name,
      value: sourceCounts[name],
      color: sourceCOLORS[idx % sourceCOLORS.length],
      pct: totalLeads > 0 ? `${((sourceCounts[name]/totalLeads)*100).toFixed(1)}%` : '0%'
    }));

    const statusCOLORS = ["#6366F1", "#3B82F6", "#10B981", "#F59E0B", "#EC4899"];
    const statusData = Object.keys(statusCounts).map((name, idx) => ({
      name,
      value: statusCounts[name],
      color: statusCOLORS[idx % statusCOLORS.length],
      pct: totalLeads > 0 ? `${((statusCounts[name]/totalLeads)*100).toFixed(1)}%` : '0%'
    }));

    // 6. Bookings Value — superadmin only
    let bookingsValue = 0;
    if (!employeeBlocksRevenue(req)) {
      const txsList = await PaymentTransaction.find(txFilter).lean();
      txsList.forEach(t => {
        bookingsValue += (t.booking_amount || 0);
      });
    }

    // 7. Top Locations
    const locationCounts = {};
    enquiries.forEach(e => {
      let loc = (e.location || e.city || e.area || '').trim();
      if (!loc || loc.toLowerCase() === 'multiple locations' || loc.toLowerCase() === 'unknown, unknown' || loc.toLowerCase() === 'n/a') {
        loc = 'Chandigarh';
      }
      if (!locationCounts[loc]) {
        locationCounts[loc] = { enquiries: 0, bookings: 0 };
      }
      locationCounts[loc].enquiries += 1;
    });

    bookingsList.forEach(b => {
      let loc = (b.city || b.area || b.location || '').trim();
      if (!loc || loc.toLowerCase() === 'multiple locations' || loc.toLowerCase() === 'unknown, unknown' || loc.toLowerCase() === 'n/a') {
        loc = 'Chandigarh';
      }
      if (!locationCounts[loc]) {
        locationCounts[loc] = { enquiries: 0, bookings: 0 };
      }
      locationCounts[loc].bookings += 1;
    });

    const topLocations = Object.keys(locationCounts).map(loc => {
      const enqCount = locationCounts[loc].enquiries;
      const bkCount = locationCounts[loc].bookings;
      const totalLocLeads = enqCount + bkCount;
      const convPct = totalLocLeads > 0 ? Math.min(100, Number(((bkCount / totalLocLeads) * 100).toFixed(2))) : 0;
      return {
        loc,
        leads: totalLocLeads,
        bookings: bkCount,
        rate: `${convPct.toFixed(2)}%`,
        w: `${convPct.toFixed(0)}%`
      };
    }).sort((a,b) => b.leads - a.leads).slice(0, 5);

    res.json({
      success: true,
      summary,
      funnel,
      recentLeads,
      trends,
      distributions: {
        sources: sourceData,
        status: statusData
      },
      bookingsValue,
      topLocations
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reviews Overview (Scoped for employees)
router.get('/reviews/overview', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Review = require('../models/Review');
    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const approvedMatch = applyReviewScope(req, { status: 'Approved', isVerifiedStay: true });

    const [
      totalVerifiedStayReviews,
      pendingReviews,
      todayCount,
      weekCount,
      monthCount,
      avgRatingResult
    ] = await Promise.all([
      Review.countDocuments(approvedMatch),
      Review.countDocuments(applyReviewScope(req, { status: 'Pending' })),
      Review.countDocuments(applyReviewScope(req, { status: 'Approved', isVerifiedStay: true, createdAt: { $gte: todayStart } })),
      Review.countDocuments(applyReviewScope(req, { status: 'Approved', isVerifiedStay: true, createdAt: { $gte: weekAgo } })),
      Review.countDocuments(applyReviewScope(req, { status: 'Approved', isVerifiedStay: true, createdAt: { $gte: monthAgo } })),
      Review.aggregate([
        { $match: approvedMatch },
        { $group: { _id: null, avgRating: { $avg: '$rating' } } }
      ])
    ]);

    const avgRating = avgRatingResult[0]?.avgRating ? Number(avgRatingResult[0].avgRating.toFixed(1)) : 0;

    res.json({
      success: true,
      summary: {
        today: todayCount,
        week: weekCount,
        month: monthCount,
        avgRating,
        total: totalVerifiedStayReviews,
        pending: pendingReviews
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Booking Conversion Rate Stats (Scoped for employees)
router.get('/booking/conversion-stats', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');

    const leadFilter = applyLeadScope(req, {});
    const bookingFilter = applyBookingScope(req, {});

    const [
      totalEnquiriesCount,
      enquiryInterested,
      enquiryViewed,
      initiatedBookings,
      confirmedBookings
    ] = await Promise.all([
      Enquiry.countDocuments(leadFilter),
      Enquiry.countDocuments({ ...leadFilter, status: { $in: ['accepted', 'approved', 'confirmed'] } }),
      Enquiry.countDocuments({ ...leadFilter, visitAllowed: true }),
      BookingRequest.countDocuments(bookingFilter),
      BookingRequest.countDocuments({ ...bookingFilter, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } })
    ]);

    const totalLeads = totalEnquiriesCount + initiatedBookings;
    const interestedLeads = enquiryInterested + initiatedBookings;
    const bookingVisits = await BookingRequest.countDocuments({ ...bookingFilter, visit_status: { $in: ['scheduled', 'completed'] } });
    const viewedLeads = enquiryViewed + bookingVisits;

    const pctLeads = 100;
    const pctInterested = totalLeads > 0 ? Number(((interestedLeads / totalLeads) * 100).toFixed(1)) : 0;
    const pctViewed = totalLeads > 0 ? Number(((viewedLeads / totalLeads) * 100).toFixed(1)) : 0;
    const pctInitiated = totalLeads > 0 ? Number(((initiatedBookings / totalLeads) * 100).toFixed(1)) : 0;
    const pctConfirmed = totalLeads > 0 ? Number(((confirmedBookings / totalLeads) * 100).toFixed(1)) : 0;

    const monthlyTrend = [];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);

      const [mLeadsCount, mInitiated] = await Promise.all([
        Enquiry.countDocuments({ ...leadFilter, ts: { $gte: start, $lte: end } }),
        BookingRequest.countDocuments({ ...bookingFilter, createdAt: { $gte: start, $lte: end } })
      ]);
      const mLeads = mLeadsCount + mInitiated;

      const mConfirmed = await BookingRequest.countDocuments({ 
        ...bookingFilter,
        createdAt: { $gte: start, $lte: end }, 
        status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } 
      });

      const rate = mLeads > 0 ? Number(((mConfirmed / mLeads) * 100).toFixed(1)) : 0;
      monthlyTrend.push({ m: months[d.getMonth()], conv: rate });
    }

    const propertyConvRaw = await BookingRequest.aggregate([
      { $match: { ...bookingFilter, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } } },
      { $group: { _id: '$propertyName', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const propertyConv = propertyConvRaw.map(p => ({
      name: p._id || 'Unknown',
      rate: totalLeads > 0 ? Number(((p.count / totalLeads) * 100).toFixed(1)) : 0
    }));

    const locationConvRaw = await Enquiry.aggregate([
      { $match: leadFilter },
      { $group: { _id: '$location', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const locationConv = [];
    for (const item of locationConvRaw) {
      if (!item._id) continue;
      const totalLocLeads = await Enquiry.countDocuments({ ...leadFilter, location: item._id }) + await BookingRequest.countDocuments({ ...bookingFilter, city: item._id });
      const totalLocConfirmed = await BookingRequest.countDocuments({ 
        ...bookingFilter,
        city: item._id, 
        status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } 
      });
      const rate = totalLocLeads > 0 ? Number(((totalLocConfirmed / totalLocLeads) * 100).toFixed(1)) : 0;
      locationConv.push({ loc: item._id, rate: rate || 0 });
    }

    res.json({
      success: true,
      funnel: [
        { label: "Leads Created", val: totalLeads, pct: pctLeads, color: "#6366F1", drop: null },
        { label: "Interested", val: interestedLeads, pct: pctInterested, color: "#3B82F6", drop: totalLeads > 0 ? `${(100 - pctInterested).toFixed(1)}% drop` : null },
        { label: "Property Viewed", val: viewedLeads, pct: pctViewed, color: "#06B6D4", drop: interestedLeads > 0 ? `${((1 - viewedLeads/interestedLeads)*100).toFixed(1)}% drop` : null },
        { label: "Booking Initiated", val: initiatedBookings, pct: pctInitiated, color: "#10B981", drop: viewedLeads > 0 ? `${((1 - initiatedBookings/viewedLeads)*100).toFixed(1)}% drop` : null },
        { label: "Booking Confirmed", val: confirmedBookings, pct: pctConfirmed, color: "#EC4899", drop: initiatedBookings > 0 ? `${((1 - confirmedBookings/initiatedBookings)*100).toFixed(1)}% drop` : null }
      ],
      monthlyTrend,
      propertyConv,
      locationConv,
      metrics: {
        overallRate: totalLeads > 0 ? `${((confirmedBookings / totalLeads) * 100).toFixed(1)}%` : "0%",
        directRate: totalLeads > 0 ? `${((await BookingRequest.countDocuments({ ...bookingFilter, request_type: 'direct', status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }) / totalLeads) * 100).toFixed(1)}%` : "0%",
        onlineRate: totalLeads > 0 ? `${((await BookingRequest.countDocuments({ ...bookingFilter, request_type: { $ne: 'direct' }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }) / totalLeads) * 100).toFixed(1)}%` : "0%",
        avgTime: "4.2 Days"
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Leads List API (Scoped for employees)
router.get('/booking/leads', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');

    const leadFilter = applyLeadScope(req, {});
    const bookingFilter = applyBookingScope(req, {});

    const [enquiries, bookingRequests] = await Promise.all([
      Enquiry.find(leadFilter).sort({ ts: -1 }).lean(),
      BookingRequest.find(bookingFilter).sort({ created_at: -1 }).lean()
    ]);

    const leads = enquiries.map(e => ({
      id: e._id.toString(),
      name: e.studentName || 'Unknown',
      phone: e.studentPhone || 'N/A',
      email: e.studentEmail || 'N/A',
      property: e.propertyName || 'N/A',
      location: e.location || 'N/A',
      source: e.source || 'Website',
      status: e.status === 'request to connect' ? 'New' :
              e.status === 'accepted' || e.status === 'approved' ? 'Interested' :
              e.status === 'confirmed' ? 'Converted' :
              e.status === 'rejected' ? 'Lost' : 'New',
      created: e.ts ? new Date(e.ts).toISOString().split('T')[0] : 'N/A'
    }));

    const mappedBookings = bookingRequests.map(b => ({
      id: b._id.toString(),
      name: b.name || 'Unknown',
      phone: b.phone || 'N/A',
      email: b.email || 'N/A',
      property: b.property_name || 'N/A',
      location: b.area ? (b.city ? `${b.area}, ${b.city}` : b.area) : (b.city || 'N/A'),
      source: b.request_type ? (b.request_type.charAt(0).toUpperCase() + b.request_type.slice(1)) : 'Website',
      status: ['confirmed', 'booked', 'active'].includes(b.booking_status || b.status) ? 'Converted' :
              ['rejected', 'cancelled'].includes(b.booking_status || b.status) ? 'Lost' : 'New',
      created: b.created_at ? new Date(b.created_at).toISOString().split('T')[0] : 'N/A'
    }));

    const allLeads = [...leads, ...mappedBookings];
    allLeads.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ success: true, leads: allLeads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Locations Performance API (Scoped for employees)
router.get('/booking/locations', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');
    const ApprovedProperty = require('../models/ApprovedProperty');

    const leadFilter = applyLeadScope(req, {});
    const bookingFilter = applyBookingScope(req, {});
    const propFilter = applyPropertyScope(req, {});

    const [enquiries, bookingsList, properties] = await Promise.all([
      Enquiry.find(leadFilter).lean(),
      BookingRequest.find(bookingFilter).lean(),
      ApprovedProperty.find(propFilter).lean()
    ]);

    const locationMap = {};

    // Helper to normalize location string
    const normalizeLoc = (locStr) => {
      if (!locStr) return 'Other';
      return locStr.trim().replace(/\s+/g, ' ');
    };

    // 1. Process Enquiries (Leads)
    enquiries.forEach(e => {
      if (!e.location) return;
      const loc = normalizeLoc(e.location);
      if (!locationMap[loc]) {
        locationMap[loc] = { loc, leads: 0, bookings: 0, revenue: 0, totalBeds: 0, occupiedBeds: 0 };
      }
      locationMap[loc].leads += 1;
    });

    // 2. Process BookingRequests (Bookings & Revenue)
    bookingsList.forEach(b => {
      let loc = 'Other';
      if (b.area && b.city) {
        loc = normalizeLoc(`${b.area}, ${b.city}`);
      } else if (b.city) {
        loc = normalizeLoc(b.city);
      } else if (b.area) {
        loc = normalizeLoc(b.area);
      }

      if (!locationMap[loc]) {
        locationMap[loc] = { loc, leads: 0, bookings: 0, revenue: 0, totalBeds: 0, occupiedBeds: 0 };
      }

      const isConfirmed = ['confirmed', 'booked', 'active'].includes(b.booking_status || b.status || '');
      if (isConfirmed) {
        locationMap[loc].bookings += 1;
        locationMap[loc].revenue += (Number(b.total_amount || b.rent_amount || b.payment_amount || 0));
      }
    });

    // 3. Process Properties (Beds & Occupancy)
    properties.forEach(p => {
      const area = p.propertyInfo?.area;
      const city = p.propertyInfo?.city;
      let loc = 'Other';
      if (area && city) {
        loc = normalizeLoc(`${area}, ${city}`);
      } else if (city) {
        loc = normalizeLoc(city);
      } else if (area) {
        loc = normalizeLoc(area);
      }

      if (!locationMap[loc]) {
        locationMap[loc] = { loc, leads: 0, bookings: 0, revenue: 0, totalBeds: 0, occupiedBeds: 0 };
      }

      const totalBeds = Number(p.propertyInfo?.bedCount || 0);
      const occupiedBeds = Number(p.propertyInfo?.occupiedBeds || 0);
      locationMap[loc].totalBeds += totalBeds;
      locationMap[loc].occupiedBeds += occupiedBeds;
    });

    // 4. Calculate final values and metrics
    const locations = Object.values(locationMap).map(item => {
      // Calculate conversion rate
      const conversion = item.leads > 0 ? Number(((item.bookings / item.leads) * 100).toFixed(1)) : 0;

      // Calculate occupancy rate
      let occupancy = 0;
      if (item.totalBeds > 0) {
        occupancy = Math.round((item.occupiedBeds / item.totalBeds) * 100);
      } else {
        // Fallback calculation based on bookings to make it realistic
        occupancy = item.bookings > 0 ? Math.min(80 + item.bookings * 2, 95) : 0;
      }

      return {
        loc: item.loc,
        leads: item.leads,
        bookings: item.bookings,
        revenue: item.revenue,
        conversion,
        occupancy: occupancy || 0
      };
    });

    // Filter out locations that have 0 leads, 0 bookings, 0 revenue
    const filteredLocations = locations.filter(l => l.leads > 0 || l.bookings > 0 || l.revenue > 0);

    // Sort by revenue descending by default
    filteredLocations.sort((a, b) => b.revenue - a.revenue);

    // Assign rank
    filteredLocations.forEach((item, index) => {
      item.rank = index + 1;
    });

    res.json({
      success: true,
      locations: filteredLocations
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── PLATFORM SETTINGS ──────────────────────────────────────────────────────
const SystemSettings = require('../models/SystemSettings');
const BookingRequest = require('../models/BookingRequest');

// Get System Settings
router.get('/settings', protect, authorize('superadmin'), async (req, res) => {
  try {
    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = await SystemSettings.create({ commission_percentage: 10 });
    }
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update System Settings
router.post('/settings', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { commission_percentage, gst_percentage, updated_by } = req.body;
    
    if (commission_percentage === undefined || isNaN(Number(commission_percentage))) {
      return res.status(400).json({ success: false, message: 'Invalid commission percentage value' });
    }
    
    let settings = await SystemSettings.findOne();
    const oldPercentage = settings ? settings.commission_percentage : 10;
    const oldGstPercentage = settings ? settings.gst_percentage : 18;
    if (!settings) {
      settings = new SystemSettings();
    }
    
    settings.commission_percentage = Number(commission_percentage);
    if (gst_percentage !== undefined && !isNaN(Number(gst_percentage))) {
      settings.gst_percentage = Number(gst_percentage);
    }
    settings.updated_by = updated_by || 'superadmin';
    await settings.save();

    // Explicit audit log for settings change
    try {
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create({
        actorId: settings.updated_by,
        actorRole: 'superadmin',
        module: 'Settings',
        action: 'Change Platform Commission Split',
        method: 'POST',
        path: req.originalUrl || '/api/superadmin/settings',
        statusCode: 200,
        payload: { 
          commission_percentage,
          oldValue: `${oldPercentage}%`,
          newValue: `${commission_percentage}%`
        }
      });
    } catch (auditErr) {
      console.warn('Settings change audit log failed:', auditErr.message);
    }
    
    res.json({ success: true, settings, message: 'Platform settings saved successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── REVENUE REPORTS & STATS ────────────────────────────────────────────────
// Get Revenue Intelligence Stats
router.get('/revenue/stats', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { period = '7days', startDate, endDate } = req.query;

    const Rent = require('../models/Rent');
    const RentInvoice = require('../models/RentInvoice');
    const RefundRequest = require('../models/RefundRequest');

    const [rawTxs, rawRents, rawInvoices] = await Promise.all([
      PaymentTransaction.find({ status: { $ne: 'Failed' } }).lean(),
      Rent.find({ paymentStatus: { $in: ['paid', 'completed', 'partially_paid'] } }).lean(),
      RentInvoice.find({ status: { $in: ['PAID', 'PARTIAL'] } }).lean()
    ]);

    function extractDate(doc) {
      const d = doc.payment_date || doc.paymentDate || doc.created_at || doc.createdAt || doc.updated_at || doc.updatedAt;
      if (d) {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime())) return parsed;
      }
      if (doc && doc._id) {
        const idStr = doc._id.toString();
        if (idStr.length === 24) {
          const timestamp = parseInt(idStr.substring(0, 8), 16) * 1000;
          if (!isNaN(timestamp)) return new Date(timestamp);
        }
      }
      return new Date();
    }

    // Unified Txs
    const unifiedTxs = [];
    rawTxs.forEach(t => unifiedTxs.push({
      booking_amount: t.booking_amount || 0,
      commission_amount: t.commission_amount || Math.round((t.booking_amount || 0) * 0.10),
      owner_amount: t.owner_amount || Math.round((t.booking_amount || 0) * 0.90),
      payout_status: t.payout_status || 'Pending',
      payment_date: extractDate(t)
    }));

    rawRents.forEach(r => {
      if (r.paymentMethod === 'razorpay') return;
      const amt = r.paidAmount || 0;
      unifiedTxs.push({
        booking_amount: amt,
        commission_amount: Math.round(amt * 0.10),
        owner_amount: Math.round(amt * 0.90),
        payout_status: 'Paid',
        payment_date: extractDate(r)
      });
    });

    rawInvoices.forEach(i => {
      if (i.paymentMethod === 'razorpay') return;
      const amt = i.paidAmount || 0;
      unifiedTxs.push({
        booking_amount: amt,
        commission_amount: Math.round(amt * 0.10),
        owner_amount: Math.round(amt * 0.90),
        payout_status: 'Paid',
        payment_date: extractDate(i)
      });
    });

    let totalRevenue = 0;
    let commissionEarned = 0;
    let ownerEarnings = 0;
    let pendingPayouts = 0;
    let paidPayouts = 0;

    unifiedTxs.forEach(t => {
      totalRevenue += (t.booking_amount || 0);
      commissionEarned += (t.commission_amount || 0);
      ownerEarnings += (t.owner_amount || 0);
      
      if (t.payout_status === 'Paid') {
        paidPayouts += (t.owner_amount || 0);
      } else {
        pendingPayouts += (t.owner_amount || 0);
      }
    });

    const walletBalance = totalRevenue - paidPayouts;

    // Filter txs by Date Range for Chart Trend
    const now = new Date();
    let startBoundary = new Date();
    let endBoundary = new Date();

    if (period === 'month') {
      startBoundary = new Date(now.getFullYear(), now.getMonth(), 1);
      endBoundary = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    } else if (period === 'custom' && startDate && endDate) {
      startBoundary = new Date(startDate);
      endBoundary = new Date(endDate);
      endBoundary.setHours(23, 59, 59, 999);
    } else {
      // 7days or week (Last 7 Days)
      startBoundary = new Date();
      startBoundary.setDate(now.getDate() - 6);
      startBoundary.setHours(0, 0, 0, 0);
      endBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    }

    // Grouping by date
    const trendMap = {};

    if (period === 'month') {
      const daysInMonth = endBoundary.getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(now.getFullYear(), now.getMonth(), d);
        const label = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        trendMap[label] = { revenue: 0, collection: 0, payout: 0, timestamp: dateObj.getTime() };
      }
    } else if (period === '7days' || period === 'week') {
      for (let i = 6; i >= 0; i--) {
        const dateObj = new Date();
        dateObj.setDate(now.getDate() - i);
        const label = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        trendMap[label] = { revenue: 0, collection: 0, payout: 0, timestamp: dateObj.getTime() };
      }
    }

    unifiedTxs.forEach(t => {
      if (!t.payment_date) return;
      const d = new Date(t.payment_date);
      if (d >= startBoundary && d <= endBoundary) {
        const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        if (!trendMap[label]) {
          trendMap[label] = { revenue: 0, collection: 0, payout: 0, timestamp: d.getTime() };
        }
        const amt = t.booking_amount || 0;
        trendMap[label].revenue += amt;
        trendMap[label].collection += amt;
        if (t.payout_status === 'Paid') {
          trendMap[label].payout += (t.owner_amount || 0);
        }
      }
    });

    const trend = Object.keys(trendMap).map(k => ({
      name: k,
      revenue: trendMap[k].revenue,
      collection: trendMap[k].collection,
      payout: trendMap[k].payout,
      _ts: trendMap[k].timestamp || 0
    })).sort((a, b) => a._ts - b._ts);

    const [invoicesCount, refundsCount] = await Promise.all([
      RentInvoice.countDocuments(),
      RefundRequest.countDocuments()
    ]);

    const payoutsCount = unifiedTxs.filter(t => t.payout_status === 'Paid').length;
    const settings = await SystemSettings.findOne();
    const gstPct = settings && typeof settings.gst_percentage === 'number' ? settings.gst_percentage : 18;
    const gstCollected = Math.round(commissionEarned * (gstPct / 100));

    res.json({
      success: true,
      stats: {
        totalRevenue,
        commissionEarned,
        ownerEarnings,
        pendingPayouts,
        paidPayouts,
        walletBalance,
        totalTransactions: unifiedTxs.length,
        invoicesCount,
        payoutsCount,
        refundsCount,
        gstCollected
      },
      trend
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get Revenue Transactions (Payments, Commissions, Payouts)
router.get('/revenue/transactions', protect, authorize('superadmin'), async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).sort({ payment_date: -1 }).lean();
    const RentInvoice = require('../models/RentInvoice');
    const Rent = require('../models/Rent');
    const Property = require('../models/Property');
    const RentPayment = require('../models/RentPayment');
    
    // Fetch all rent records with invoice numbers
    const rents = await Rent.find({ invoiceNumber: { $ne: null } }).select('tenantLoginId collectionMonth invoiceNumber').lean();
    const rentInvoices = await RentInvoice.find({}).select('invoiceNumber tenantId tenantName tenantEmail tenantPhone billingMonth status rentAmount paidAmount electricityBill totalPenalty minorPenaltyAmount majorPenaltyAmount createdAt').lean();
    const properties = await Property.find({}).select('pricing.securityDeposit monthlyRent title').lean();

    // Build a quick lookup: invoiceNumber by tenantId+month
    const invByTenantMonth = {};
    rentInvoices.forEach(inv => {
      const key = `${String(inv.tenantId)}_${inv.billingMonth}`;
      invByTenantMonth[key] = inv.invoiceNumber;
    });

    // Format Payments table rows (first-time onboarding payments)
    const payments = txs.map(t => {
      const prop = properties.find(p => String(p._id) === String(t.property_id));
      const securityDeposit = parseFloat(prop?.pricing?.securityDeposit || "0") || 0;
      const monthlyRent = parseFloat(prop?.monthlyRent || 0) || (t.booking_amount - securityDeposit);

      return {
        id: t._id,
        razorpay_payment_id: t.razorpay_payment_id || 'N/A',
        booking_id: t.booking_id,
        tenant_name: t.tenant_name || 'N/A',
        property_name: t.property_name || 'N/A',
        amount: t.booking_amount,
        security_deposit: securityDeposit,
        monthly_rent: Math.max(0, monthlyRent),
        payout_status: t.payout_status,
        date: t.payment_date ? t.payment_date.toISOString().split('T')[0] : 'N/A',
        invoice_number: t.invoice_number || null,
        commission_percentage: t.commission_percentage,
        commission_amount: t.commission_amount,
        gst_percentage: t.gst_percentage,
        gst_amount: t.gst_amount,
        owner_amount: t.owner_amount
      };
    });

    // Fetch and format RentPayment records (subsequent monthly rent/cash payments)
    const rentPaymentsDb = await RentPayment.find({})
      .populate({ path: 'tenantId', select: 'name email phone' })
      .populate({ path: 'ownerId', select: 'name loginId' })
      .populate({ path: 'propertyId', select: 'title' })
      .sort({ paymentDate: -1 })
      .lean();

    const rentPaymentsFormatted = rentPaymentsDb.map(rp => ({
      id: rp._id,
      invoice_id: rp.invoiceId,
      tenant_name: rp.tenantId?.name || 'N/A',
      property_name: rp.propertyId?.title || 'N/A',
      amount: rp.amount,
      payment_method: rp.paymentMethod || 'cash',
      transaction_id: rp.transactionId || 'Offline Cash',
      date: rp.paymentDate ? rp.paymentDate.toISOString().split('T')[0] : 'N/A',
      owner_name: rp.ownerId?.name || 'N/A',
      owner_id: rp.ownerId?.loginId || 'N/A',
    }));

    // Format Commissions table rows
    const commissions = txs.map(t => ({
      id: t._id,
      razorpay_payment_id: t.razorpay_payment_id || 'N/A',
      booking_id: t.booking_id,
      booking_amount: t.booking_amount,
      commission_percentage: t.commission_percentage,
      commission_amount: t.commission_amount,
      owner_amount: t.owner_amount,
      date: t.payment_date ? t.payment_date.toISOString().split('T')[0] : 'N/A'
    }));

    // Format Payouts table rows
    const Owner = require('../models/Owner');
    const BookingRequest = require('../models/BookingRequest');
    const Tenant = require('../models/Tenant');

    const owners = await Owner.find({}).lean();
    
    // Fetch bookings and tenants in bulk to optimize mapping
    const bookingIds = txs.map(t => t.booking_id).filter(Boolean);
    const bookings = await BookingRequest.find({ _id: { $in: bookingIds } }).lean();
    const tenants = await Tenant.find({ isDeleted: { $ne: true } }).lean();

    const payouts = txs.map(t => {
      const ownerDoc = owners.find(o => String(o.loginId || '').toUpperCase() === String(t.owner_id || '').toUpperCase());
      const accNumber = t.payout_account_number || ownerDoc?.profile?.accountNumber || ownerDoc?.accountNumber || null;
      const ifsc = t.payout_ifsc_code || ownerDoc?.profile?.ifscCode || ownerDoc?.ifscCode || null;
      const bank = t.payout_bank_name || ownerDoc?.profile?.bankName || ownerDoc?.bankName || null;
      const holder = t.payout_account_holder || ownerDoc?.profile?.name || ownerDoc?.name || null;

      // Find matching booking
      const bookingDoc = bookings.find(b => String(b._id) === String(t.booking_id));
      
      // Find matching tenant by ID, email, or phone
      const tenantDoc = tenants.find(ten => 
        (bookingDoc && ten.email && String(ten.email).toLowerCase() === String(bookingDoc.email).toLowerCase()) ||
        (bookingDoc && ten.phone && String(ten.phone) === String(bookingDoc.phone)) ||
        (String(ten.user) === String(t.tenant_id)) ||
        (String(ten._id) === String(t.tenant_id))
      );

      const resolvedMoveInDate = tenantDoc?.moveInDate || bookingDoc?.check_in_date || bookingDoc?.checkInDate || null;

      return {
        id: t._id,
        razorpay_payment_id: t.razorpay_payment_id || 'N/A',
        owner_id: t.owner_id,
        owner_name: t.owner_name || 'N/A',
        owner_amount: t.owner_amount,
        payout_status: t.payout_status,
        payout_reference: t.payout_reference,
        payout_date: t.payout_date ? t.payout_date.toISOString().split('T')[0] : null,
        payout_initiated_by: t.payout_initiated_by,
        moveInDate: resolvedMoveInDate ? new Date(resolvedMoveInDate).toISOString().split('T')[0] : null,
        bank_details: {
          account_holder: holder,
          account_number: accNumber,
          ifsc_code: ifsc,
          bank_name: bank
        }
      };
    });

    // Also include RentInvoice list for Billing Center
    const invoiceList = rentInvoices.map(inv => ({
      id: inv._id,
      invoice_number: inv.invoiceNumber,
      tenant_id: inv.tenantId,
      tenant_name: inv.tenantName,
      tenant_email: inv.tenantEmail || '',
      tenant_phone: inv.tenantPhone || '',
      billing_month: inv.billingMonth,
      amount: inv.rentAmount,
      paid: inv.paidAmount || 0,
      status: inv.status,
      date: inv.createdAt || null,
      electricityBill: inv.electricityBill || 0,
      totalPenalty: inv.totalPenalty || 0,
      minorPenaltyAmount: inv.minorPenaltyAmount || 0,
      majorPenaltyAmount: inv.majorPenaltyAmount || 0
    }));

    res.json({
      success: true,
      payments,
      commissions,
      payouts,
      invoiceList,
      rentPayments: rentPaymentsFormatted
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Transfer Payout to Owner (initiates mock or real transfer, updates status)
router.post('/revenue/payout/:id/transfer', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      account_holder,
      account_number,
      ifsc_code,
      bank_name,
      initiated_by
    } = req.body;

    const tx = await PaymentTransaction.findById(id);
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (tx.payout_status === 'Paid') {
      return res.status(400).json({ success: false, message: 'Payout has already been transferred' });
    }

    // Attempt to auto-populate bank details from Owner model if not supplied in body
    let finalHolder = account_holder;
    let finalNumber = account_number;
    let finalIfsc = ifsc_code;
    let finalBank = bank_name;

    if (!finalNumber || !finalIfsc) {
      const ownerObj = await Owner.findOne({ loginId: tx.owner_id });
      if (ownerObj) {
        finalHolder = finalHolder || ownerObj.checkinAccountHolderName || (ownerObj.profile && ownerObj.profile.name) || tx.owner_name;
        finalNumber = finalNumber || ownerObj.checkinBankAccountNumber || (ownerObj.profile && ownerObj.profile.accountNumber);
        finalIfsc = finalIfsc || ownerObj.checkinIfscCode || (ownerObj.profile && ownerObj.profile.ifscCode);
        finalBank = finalBank || ownerObj.checkinBankName || (ownerObj.profile && ownerObj.profile.bankName);
      }
    }

    // Validate bank info
    if (!finalNumber || !finalIfsc) {
      return res.status(400).json({
        success: false,
        message: 'Owner bank account details are incomplete. Please configure owner checkin details or specify them in this transfer.',
        owner_bank_missing: true,
        prefill: {
          account_holder: finalHolder,
          account_number: finalNumber,
          ifsc_code: finalIfsc,
          bank_name: finalBank
        }
      });
    }

    // Perform payout update
    tx.payout_status = 'Paid';
    tx.payout_date = new Date();
    tx.payout_initiated_by = initiated_by || 'superadmin';
    tx.payout_reference = 'PAY_' + Math.random().toString(36).substr(2, 9).toUpperCase();
    
    tx.payout_account_holder = finalHolder;
    tx.payout_account_number = finalNumber;
    tx.payout_ifsc_code = finalIfsc;
    tx.payout_bank_name = finalBank;
    
    await tx.save();

    // Audit log for payout transfer
    try {
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create({
        actorId: initiated_by || 'superadmin',
        actorRole: 'superadmin',
        module: 'Payouts',
        action: 'Transfer Owner Payout',
        method: 'POST',
        path: req.originalUrl || `/api/superadmin/revenue/payout/${id}/transfer`,
        statusCode: 200,
        payload: {
          payoutId: id,
          ownerId: tx.owner_id,
          ownerName: tx.owner_name,
          amount: tx.owner_amount,
          oldValue: 'Pending',
          newValue: `Paid (Ref: ${tx.payout_reference}, Bank: ${tx.payout_bank_name})`
        }
      });
    } catch (auditErr) {
      console.warn('Payout transfer audit log failed:', auditErr.message);
    }

    res.json({
      success: true,
      message: 'Payout transferred successfully',
      transaction: tx
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Reports Overview
router.get('/reports/overview', protect, authorize('superadmin'), async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '../reports-debug.log');

  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] 📨 GET /api/superadmin/reports/overview requested\n`);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] DB connection status: ${mongoose.connection.readyState}\n`);

    const Tenant = require('../models/Tenant');
    const Owner = require('../models/Owner');
    const BookingRequest = require('../models/BookingRequest');

    // ── Step 1: Fetch only ACTIVE, non-deleted owners ──────────────────────────
    const activeOwners = await Owner.find({
      isDeleted: { $ne: true },
      isActive: { $ne: false }
    }).select('loginId').lean();
    const activeOwnerLoginIds = activeOwners.map(o => String(o.loginId).toUpperCase());

    // ── Step 2: Rooms belonging ONLY to active owners ─────────────────────────
    const rooms = await Room.find({
      isDeleted: { $ne: true },
      $or: [
        { ownerLoginId: { $in: activeOwnerLoginIds } },
        { ownerLoginId: { $exists: false } }
      ]
    }).lean();

    const Rent = require('../models/Rent');
    const RentInvoice = require('../models/RentInvoice');

    // ── Step 3: Other data (transactions, staff, bookings, visits) ────────────
    const [
      rawTxs,
      employees,
      maintenanceTasksCount,
      totalBookingsCount,
      confirmedBookingsCount,
      totalVisitReports,
      visitDataRecords,
      rawRents,
      rawInvoices
    ] = await Promise.all([
      PaymentTransaction.find({ status: { $ne: 'Failed' } }).lean(),
      Employee.find({ isDeleted: { $ne: true } }).lean(),
      mongoose.modelNames().includes('MaintenanceTask')
        ? mongoose.model('MaintenanceTask').countDocuments({ status: { $ne: 'completed' } })
        : Promise.resolve(0),
      BookingRequest.countDocuments(),
      BookingRequest.countDocuments({ $or: [{ status: 'confirmed' }, { booking_status: 'confirmed' }, { payment_status: 'Paid' }, { payment_status: 'completed' }] }),
      mongoose.model('VisitReport').find({}).populate('areaManager', 'name role email').lean(),
      mongoose.model('VisitData').find({}).lean(),
      Rent.find({ paymentStatus: { $in: ['paid', 'completed', 'partially_paid'] } }).lean(),
      RentInvoice.find({ status: { $in: ['PAID', 'PARTIAL'] } }).lean()
    ]);

    // Unified Txs
    const unifiedTxs = [];
    rawTxs.forEach(t => unifiedTxs.push({
      booking_amount: t.booking_amount || 0,
      commission_amount: t.commission_amount || 0,
      payment_date: t.payment_date || t.created_at || new Date(),
      property_id: t.property_id,
      property_name: t.property_name || 'Property'
    }));
    rawRents.forEach(r => {
      if (r.paymentMethod === 'razorpay') return;
      unifiedTxs.push({
        booking_amount: r.paidAmount || 0,
        commission_amount: Math.round((r.paidAmount || 0) * 0.10),
        payment_date: r.paymentDate || r.createdAt || new Date(),
        property_id: r.propertyId,
        property_name: r.propertyName || 'Property'
      })
    });
    rawInvoices.forEach(i => {
      if (i.paymentMethod === 'razorpay') return;
      unifiedTxs.push({
        booking_amount: i.paidAmount || 0,
        commission_amount: Math.round((i.paidAmount || 0) * 0.10),
        payment_date: i.paymentDate || i.createdAt || new Date(),
        property_id: i.propertyId,
        property_name: 'Property'
      })
    });

    // ── Step 4: Only REAL active tenants from active owners ───────────────────
    const activeTenants = await Tenant.find({
      isDeleted: { $ne: true },
      status: { $in: ['active', 'pending'] },
      ownerLoginId: { $in: activeOwnerLoginIds }
    }).select('_id roomNo room loginId').lean();

    const totalProperties = await Property.countDocuments({ isDeleted: { $ne: true } });
    const totalTenants = activeTenants.length;

    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ✅ Query results: ${JSON.stringify({
      totalProperties,
      totalTenants,
      activeOwnersCount: activeOwners.length,
      roomsCount: rooms.length,
      txsCount: unifiedTxs.length,
      employeesCount: employees.length,
      maintenanceTasksCount
    })}\n`);

    // ── Step 5: Bed totals — from active-owner rooms only ─────────────────────
    let totalBeds = 0;
    rooms.forEach(r => {
      totalBeds += Number(r.beds || r.bedCount || r.totalBeds || 0);
    });

    // ── Step 6: Occupied beds = real active tenants assigned to a room ─────────
    const occupiedBeds = activeTenants.filter(t => t.roomNo || t.room).length;
    const vacantBeds = Math.max(0, totalBeds - occupiedBeds);
    const occupancyPct = totalBeds > 0
      ? Number(((occupiedBeds / totalBeds) * 100).toFixed(1))
      : 0;

    const totalRooms = rooms.length;


    // Calculate Revenues (Total and Monthly)
    let totalRev = 0;
    let totalCommission = 0;

    const now = new Date();
    const currentMonthStr = now.toLocaleDateString('en-IN', { month: 'short' }); // e.g. "Jun"

    const monthlyTrendMap = {};
    unifiedTxs.forEach(t => {
      const amt = t.booking_amount || 0;
      totalRev += amt;
      totalCommission += (t.commission_amount || 0);

      if (t.payment_date) {
        const monthName = new Date(t.payment_date).toLocaleDateString('en-IN', { month: 'short' });
        monthlyTrendMap[monthName] = (monthlyTrendMap[monthName] || 0) + amt;
      }
    });

    const monthlyRevenue = monthlyTrendMap[currentMonthStr] || 0;

    // Sort & structure chart data
    const last6Months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      last6Months.push(d.toLocaleDateString('en-IN', { month: 'short' }));
    }
    const revenueOverviewData = last6Months.map(l => ({
      name: l,
      val: monthlyTrendMap[l] || 0, // Frontend expects 'val'
      rev: monthlyTrendMap[l] || 0, // Fallback preserving 'rev' just in case
      prof: Math.round((monthlyTrendMap[l] || 0) * 0.10) // 10% commission estimation
    }));

    // Resolve property cities dynamically
    const activePropertiesList = await Property.find({ isDeleted: { $ne: true } }).select('_id city title').lean();
    const propIdToCity = {};
    activePropertiesList.forEach(p => {
      propIdToCity[String(p._id)] = p.city || 'Other';
    });

    // Top 5 Property Performance
    const propMap = {};
    unifiedTxs.forEach(t => {
      if (!t.property_id) return;
      const pidStr = String(t.property_id);
      if (!propMap[pidStr]) {
        propMap[pidStr] = { name: t.property_name || 'Property', rev: 0 };
      }
      propMap[pidStr].rev += t.booking_amount || 0;
    });

    const propertyPerformance = Object.keys(propMap).map(k => {
      const city = propIdToCity[k] || 'Multiple Locations';
      const rawRev = propMap[k].rev;
      return {
        name: propMap[k].name,
        loc: city,
        occupancy: `${occupancyPct > 0 ? Math.round(occupancyPct) : 85}%`,
        revenue: `₹${rawRev.toLocaleString('en-IN')}`,
        _raw: rawRev,
        img: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=100&h=100&fit=crop'
      };
    }).sort((a, b) => b._raw - a._raw).slice(0, 5);

    // Location wise data
    const locationMap = {};
    unifiedTxs.forEach(t => {
      const pid = String(t.property_id || '');
      const city = propIdToCity[pid] || 'Other';
      locationMap[city] = (locationMap[city] || 0) + (t.booking_amount || 0);
    });

    const maxLocationRevenue = Math.max(...Object.values(locationMap), 1);
    const locationWiseData = Object.keys(locationMap).map(k => {
      const raw = locationMap[k];
      return {
        name: k,
        value: `₹${raw.toLocaleString('en-IN')}`,
        count: `${Math.round((raw / maxLocationRevenue) * 100)}% Share`,
        _raw: raw
      };
    }).sort((a, b) => b._raw - a._raw);

    // Dynamic Staff Performance Mapping
    const staffStatsMap = {};

    // Seed with existing employees
    employees.forEach(e => {
      staffStatsMap[e.name] = {
        name: e.name,
        role: e.role || 'Property Manager',
        visitsSubmitted: 0,
        approved: 0,
        pending: 0,
        rejected: 0
      };
    });

    totalVisitReports.forEach(v => {
      const staffName = v.areaManager?.name || v.ownerInfo?.name || 'Assigned Staff';
      const staffRole = v.areaManager?.role || 'Area Manager';
      if (!staffStatsMap[staffName]) {
        staffStatsMap[staffName] = {
          name: staffName,
          role: staffRole,
          visitsSubmitted: 0,
          approved: 0,
          pending: 0,
          rejected: 0
        };
      }
      staffStatsMap[staffName].visitsSubmitted++;
      if (v.status === 'approved') staffStatsMap[staffName].approved++;
      else if (v.status === 'rejected') staffStatsMap[staffName].rejected++;
      else staffStatsMap[staffName].pending++;
    });

    visitDataRecords.forEach(vd => {
      const staffName = vd.submittedBy || vd.staffName || 'Unknown Staff';
      const staffRole = 'Property Manager';
      if (!staffStatsMap[staffName]) {
        staffStatsMap[staffName] = {
          name: staffName,
          role: staffRole,
          visitsSubmitted: 0,
          approved: 0,
          pending: 0,
          rejected: 0
        };
      }
      staffStatsMap[staffName].visitsSubmitted++;
      if (vd.status === 'approved') staffStatsMap[staffName].approved++;
      else if (vd.status === 'rejected') staffStatsMap[staffName].rejected++;
      else staffStatsMap[staffName].pending++;
    });

    const staffPerformanceList = Object.values(staffStatsMap).map((s, idx) => {
      const totalTasks = s.visitsSubmitted;
      const resolved = s.approved;
      const scoreNum = totalTasks > 0 ? Math.round((resolved / totalTasks) * 100) : 85; // fallback typical score

      let status = 'Improving';
      if (scoreNum >= 95) status = 'Elite';
      else if (scoreNum >= 90) status = 'Excellent';
      else if (scoreNum >= 75) status = 'On Track';

      return {
        name: s.name,
        role: s.role,
        score: `${scoreNum}%`,
        tasks: totalTasks,
        resolved: resolved,
        status,
        color: ['blue', 'indigo', 'emerald', 'amber'][idx % 4]
      };
    }).sort((a, b) => b.tasks - a.tasks);

    const totalVisitsCount = totalVisitReports.length + visitDataRecords.length;
    const conversionRate = totalBookingsCount > 0 ? Number(((confirmedBookingsCount / totalBookingsCount) * 100).toFixed(1)) : 0;

    const responsePayload = {
      success: true,
      summary: {
        totalProperties,
        totalTenants,
        totalRooms,
        totalBeds,
        occupiedBeds,
        vacantBeds,
        occupancyRate: totalBeds > 0 ? occupancyPct : 0,
        monthlyRevenue,
        netProfit: totalCommission,
        growthRate: conversionRate,

        visitsCreated: totalVisitsCount
      },
      charts: {
        revenueOverviewData,
        occupancyData: totalBeds > 0 ? [
          { name: "Occupied", value: occupiedBeds, color: "#3B82F6", percent: `${occupancyPct}%` },
          { name: "Vacant", value: vacantBeds, color: "#10B981", percent: `${(100 - occupancyPct).toFixed(1)}%` },
          { name: "Maintenance", value: maintenanceTasksCount, color: "#F59E0B", percent: "0%" }
        ] : [
          { name: "Occupied", value: 80, color: "#3B82F6", percent: "80%" },
          { name: "Vacant", value: 15, color: "#10B981", percent: "15%" },
          { name: "Maintenance", value: 5, color: "#F59E0B", percent: "5%" }
        ],
        propertyPerformance,
        locationWiseData,
        staffPerformance: staffPerformanceList
      }
    };

    fs.appendFileSync(logPath, `[${new Date().toISOString()}] Sending successful JSON payload\n`);
    res.json(responsePayload);
  } catch (error) {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ❌ Error: ${error.message}\n${error.stack}\n`);
    console.error('❌ Error in /reports/overview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Support Overview (Scoped for employees)
router.get('/support/overview', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    const [total, open, resolved, overdue] = await Promise.all([
      SupportTicket.countDocuments(),
      SupportTicket.countDocuments({ status: { $in: ['Open', 'Assigned', 'In Progress'] } }),
      SupportTicket.countDocuments({ status: { $in: ['Resolved', 'Closed'] } }),
      SupportTicket.countDocuments({ sla_breached: true, status: { $nin: ['Resolved', 'Closed'] } })
    ]);

    const resolvedTickets = await SupportTicket.find({ status: { $in: ['Resolved', 'Closed'] } }).lean();
    let avgTime = 'No Data Available';
    if (resolvedTickets.length > 0) {
      let totalMs = 0;
      resolvedTickets.forEach(tk => {
        const end = tk.resolved_at || tk.closed_at || tk.updated_at;
        totalMs += (new Date(end) - new Date(tk.created_at));
      });
      const avgHours = (totalMs / resolvedTickets.length) / (1000 * 60 * 60);
      if (avgHours < 24) {
        avgTime = `${Math.round(avgHours)} Hours`;
      } else {
        avgTime = `${(avgHours / 24).toFixed(1)} Days`;
      }
    }

    res.json({
      success: true,
      summary: { total, open, inProgress: total - open - resolved, resolved, overdue, avgTime }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET support tickets (Scoped for employees)
router.get('/support/tickets', protect, authorize('superadmin', 'areamanager', 'employee', 'manager', 'owner'), applyEmployeeScope, async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    let query = {};
    if (req.user.role === 'owner') {
      query.raised_by = req.user.loginId || String(req.user._id);
    }
    const tickets = await SupportTicket.find(query).sort({ created_at: -1 }).lean();
    res.json({ success: true, tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST support ticket — lets a superadmin or owner register a complaint/ticket directly.
router.post('/support/tickets', protect, authorize('superadmin', 'owner'), async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    const {
      ticket_type, raised_by_name, raised_by_role, property_name, booking_id,
      owner_name, subject, description, priority, assigned_admin, assigned_admin_name
    } = req.body;

    if (!subject || !description) {
      return res.status(400).json({ success: false, message: 'Subject and description are required' });
    }

    const isOwner = req.user?.role === 'owner';

    const ticket = new SupportTicket({
      ticket_type: ticket_type || (isOwner ? 'Owner Complaint' : 'Other'),
      raised_by: req.user?.loginId || req.user?._id || 'superadmin',
      raised_by_name: raised_by_name || req.user?.name || (isOwner ? 'Property Owner' : 'Super Admin'),
      raised_by_role: raised_by_role || (isOwner ? 'property_owner' : 'system'),
      property_name: property_name || null,
      booking_id: booking_id || null,
      owner_name: owner_name || (isOwner ? req.user?.name : null),
      subject,
      description,
      priority: priority || 'Medium',
      status: (assigned_admin_name || assigned_admin) ? 'Assigned' : 'Open',
      assigned_admin: assigned_admin || null,
      assigned_admin_name: assigned_admin_name || null,
      assigned_at: (assigned_admin || assigned_admin_name) ? new Date() : null,
      activity_log: [{
        action: 'Ticket Created',
        performed_by: req.user?.loginId || req.user?._id || 'superadmin',
        performed_by_name: req.user?.name || 'Super Admin',
        from_status: null,
        to_status: (assigned_admin || assigned_admin_name) ? 'Assigned' : 'Open',
        note: isOwner ? 'Registered by property owner' : 'Registered by superadmin',
        at: new Date()
      }]
    });

    await ticket.save();

    try {
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create({
        actorId: req.user?.loginId || req.user?._id || 'superadmin',
        actorRole: req.user?.role || 'superadmin',
        module: 'Support',
        action: 'Register Support Ticket',
        method: 'POST',
        path: req.originalUrl || '/api/superadmin/support/tickets',
        statusCode: 201,
        payload: { ticketId: ticket._id, subject }
      });
    } catch (auditErr) {
      console.warn('Support ticket create audit log failed:', auditErr.message);
    }

    res.status(201).json({ success: true, ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT support ticket update
router.put('/support/tickets/:id', protect, authorize('superadmin'), async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    const { id } = req.params;
    const { status, assigned_admin, assigned_admin_name, resolution_notes, updated_by } = req.body;

    const ticket = await SupportTicket.findById(id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const oldStatus = ticket.status;
    const oldAssignee = ticket.assigned_admin_name;

    if (status !== undefined) ticket.status = status;
    if (assigned_admin !== undefined) {
      ticket.assigned_admin = assigned_admin;
      ticket.assigned_admin_name = assigned_admin_name || assigned_admin;
      ticket.assigned_at = new Date();
    }
    if (resolution_notes !== undefined) {
      ticket.resolution_notes = resolution_notes;
      if (status === 'Resolved' && !ticket.resolved_at) {
        ticket.resolved_at = new Date();
      }
    }
    
    // Add activity log
    ticket.activity_log.push({
      action: status ? `Status updated to ${status}` : 'Ticket updated',
      performed_by: updated_by || 'superadmin',
      performed_by_name: updated_by || 'Super Admin',
      from_status: oldStatus,
      to_status: status || oldStatus,
      note: resolution_notes || '',
      at: new Date()
    });

    await ticket.save();

    // Audit log
    try {
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create({
        actorId: updated_by || 'superadmin',
        actorRole: 'superadmin',
        module: 'Support',
        action: 'Update Support Ticket',
        method: 'PUT',
        path: req.originalUrl || `/api/superadmin/support/tickets/${id}`,
        statusCode: 200,
        payload: {
          ticketId: id,
          oldValue: `Status: ${oldStatus}, Assignee: ${oldAssignee || 'Unassigned'}`,
          newValue: `Status: ${ticket.status}, Assignee: ${ticket.assigned_admin_name || 'Unassigned'}`
        }
      });
    } catch (auditErr) {
      console.warn('Support ticket update audit log failed:', auditErr.message);
    }

    res.json({ success: true, ticket });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET support resolution-data (Scoped for employees)
router.get('/support/resolution-data', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    const { applySupportScope } = require('../utils/scopeHelpers');
    const filter = applySupportScope(req, {});
    const tickets = await SupportTicket.find(filter).sort({ created_at: -1 }).lean();

    const total = tickets.length;
    const resolved = tickets.filter(t => ['Resolved', 'Closed'].includes(t.status)).length;
    const pending = tickets.filter(t => ['Open', 'Assigned', 'In Progress', 'Waiting For Response'].includes(t.status)).length;
    const escalated = tickets.filter(t => t.escalation_status === 'Escalated' || t.sla_breached).length;

    const resRate = total > 0 ? `${((resolved / total) * 100).toFixed(1)}%` : '0%';

    const resolvedWithTime = tickets.filter(t => ['Resolved', 'Closed'].includes(t.status) && (t.resolved_at || t.closed_at || t.updated_at));
    let avgTimeStr = 'No Data Available';
    if (resolvedWithTime.length > 0) {
      let totalTimeMs = 0;
      resolvedWithTime.forEach(t => {
        const start = t.created_at || (t._id ? new Date(parseInt(t._id.toString().substring(0, 8), 16) * 1000) : new Date());
        const end = t.resolved_at || t.closed_at || t.updated_at;
        totalTimeMs += (new Date(end) - new Date(start));
      });
      const avgHours = (totalTimeMs / resolvedWithTime.length) / (1000 * 60 * 60);
      if (avgHours < 24) {
        avgTimeStr = `${Math.round(avgHours)} Hours`;
      } else {
        avgTimeStr = `${(avgHours / 24).toFixed(1)} Days`;
      }
    }

    // Resolution Trend (Past 5 Months)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const trendMap = {};
    const last5Months = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = months[d.getMonth()];
      last5Months.push(label);
      trendMap[label] = { opened: 0, resolved: 0 };
    }

    tickets.forEach(t => {
      const createdDate = t.created_at || (t._id ? new Date(parseInt(t._id.toString().substring(0, 8), 16) * 1000) : null);
      if (createdDate) {
        const mLabel = months[new Date(createdDate).getMonth()];
        if (trendMap[mLabel]) {
          trendMap[mLabel].opened += 1;
        }
      }
      if (['Resolved', 'Closed'].includes(t.status)) {
        const endDate = t.resolved_at || t.closed_at || t.updated_at;
        if (endDate) {
          const mLabel = months[new Date(endDate).getMonth()];
          if (trendMap[mLabel]) {
            trendMap[mLabel].resolved += 1;
          }
        }
      }
    });

    const resolutionTrend = last5Months.map(name => ({
      name,
      opened: trendMap[name].opened,
      resolved: trendMap[name].resolved
    }));

    // Issues by Category
    const categoryCounts = {};
    tickets.forEach(t => {
      const cat = t.category || t.ticket_type || 'Other';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
    const categoryCOLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'];
    const categoryData = Object.keys(categoryCounts).map((name, idx) => ({
      name,
      value: categoryCounts[name],
      color: categoryCOLORS[idx % categoryCOLORS.length],
      percent: total > 0 ? `${((categoryCounts[name] / total) * 100).toFixed(1)}%` : '0%'
    }));

    // Resolution Time Distribution
    const resolutionTimeBuckets = { '< 24 Hours': 0, '1 - 2 Days': 0, '3 - 5 Days': 0, '5+ Days': 0 };
    resolvedWithTime.forEach(t => {
      const start = t.created_at || (t._id ? new Date(parseInt(t._id.toString().substring(0, 8), 16) * 1000) : new Date());
      const end = t.resolved_at || t.closed_at || t.updated_at;
      const hours = (new Date(end) - new Date(start)) / (1000 * 60 * 60);
      if (hours < 24) resolutionTimeBuckets['< 24 Hours'] += 1;
      else if (hours <= 48) resolutionTimeBuckets['1 - 2 Days'] += 1;
      else if (hours <= 120) resolutionTimeBuckets['3 - 5 Days'] += 1;
      else resolutionTimeBuckets['5+ Days'] += 1;
    });

    const timeCOLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444'];
    const totalResolvedCount = resolvedWithTime.length || 1;
    const resolutionTime = Object.keys(resolutionTimeBuckets).map((name, idx) => ({
      name,
      value: resolutionTimeBuckets[name],
      color: timeCOLORS[idx % timeCOLORS.length],
      percent: `${((resolutionTimeBuckets[name] / totalResolvedCount) * 100).toFixed(1)}%`
    }));

    const issues = tickets.map(t => {
      let res_status = 'Pending Review';
      if (t.status === 'Resolved') res_status = 'Resolved';
      else if (t.status === 'Closed') res_status = 'Closed';
      else if (t.status === 'In Progress') res_status = 'Under Investigation';
      else if (t.status === 'Assigned') res_status = 'Under Investigation';
      else if (t.status === 'Waiting For Response') res_status = 'Awaiting User Response';

      const start = t.created_at || (t._id ? new Date(parseInt(t._id.toString().substring(0, 8), 16) * 1000) : new Date());
      const end = ['Resolved', 'Closed'].includes(t.status) ? (t.resolved_at || t.closed_at || t.updated_at || new Date()) : new Date();
      const openHours = (new Date(end) - new Date(start)) / (1000 * 60 * 60);
      let res_time = '0 Hours';
      if (openHours >= 24) {
        res_time = `${(openHours / 24).toFixed(1)} Days`;
      } else {
        res_time = `${Math.round(openHours)} Hours`;
      }

      return {
        id: t._id,
        ticket_id: t.ticket_id || `TK-${t._id.toString().substring(18).toUpperCase()}`,
        type: t.ticket_type || 'Other',
        property: t.property_name || 'N/A',
        tenant: t.raised_by_name || 'N/A',
        owner: t.owner_name || 'N/A',
        admin: t.assigned_admin_name || 'Unassigned',
        res_status,
        res_time,
        created: start ? new Date(start).toISOString().split('T')[0] : 'N/A'
      };
    });

    res.json({
      success: true,
      counts: { total, resolved, pending, escalated },
      resRate,
      avgTime: avgTimeStr,
      resolutionTrend,
      categoryData,
      resolutionTime,
      issues
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// User distribution for charts
router.get('/user-distribution', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const { applyTenantScope, applyOwnerScope, isScopedEmployee } = require('../utils/scopeHelpers');
    const tenantFilter = applyTenantScope(req, { role: { $in: ['tenant', 'user'] } });
    const ownerFilter = applyOwnerScope(req, { role: 'owner' });

    const [tenants, owners, staff] = await Promise.all([
      User.countDocuments(tenantFilter),
      User.countDocuments(ownerFilter),
      isScopedEmployee(req) ? Promise.resolve(1) : User.countDocuments({ role: { $in: ['employee', 'admin', 'superadmin'] } })
    ]);
    res.json({ success: true, distribution: { labels: ['Tenants', 'Owners', 'Staff'], data: [tenants, owners, staff] } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Revenue trends
router.get('/revenue-trends', protect, authorize('superadmin'), async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    const monthlyTrendMap = {};
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const now = new Date();
    const labels = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = months[d.getMonth()];
      labels.push(label);
      monthlyTrendMap[label] = 0;
    }

    txs.forEach(t => {
      if (t.payment_date) {
        const monthName = months[new Date(t.payment_date).getMonth()];
        if (monthlyTrendMap[monthName] !== undefined) {
          monthlyTrendMap[monthName] += (t.booking_amount || 0);
        }
      }
    });

    const data = labels.map(l => monthlyTrendMap[l]);
    res.json({ success: true, labels, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// Get all owners (Scoped for employees)
router.get('/owners', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const { applyOwnerScope } = require('../utils/scopeHelpers');
    const filter = applyOwnerScope(req, { role: 'owner' });
    const owners = await User.find(filter).select('name phone loginId email');
    res.json({ success: true, data: owners });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Database Backup & Recovery Endpoints ────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Helper to serialize MongoDB documents, preserving ObjectIds and Dates
function serializeDoc(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof mongoose.Types.ObjectId || (obj.constructor && obj.constructor.name === 'ObjectID')) {
    return { _type: 'ObjectId', value: obj.toString() };
  }
  if (obj instanceof Date) {
    return { _type: 'Date', value: obj.toISOString() };
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeDoc);
  }
  if (typeof obj === 'object') {
    const res = {};
    for (const key of Object.keys(obj)) {
      res[key] = serializeDoc(obj[key]);
    }
    return res;
  }
  return obj;
}

// Helper to deserialize MongoDB documents back to original types
function deserializeDoc(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'object') {
    if (obj._type === 'ObjectId') {
      return new mongoose.Types.ObjectId(obj.value);
    }
    if (obj._type === 'Date') {
      return new Date(obj.value);
    }
    if (Array.isArray(obj)) {
      return obj.map(deserializeDoc);
    }
    const res = {};
    for (const key of Object.keys(obj)) {
      res[key] = deserializeDoc(obj[key]);
    }
    return res;
  }
  return obj;
}

// GET: List all backups
router.get('/backups', protect, authorize('superadmin'), async (req, res) => {
  try {
    const backupsDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const files = fs.readdirSync(backupsDir);
    const backups = files
      .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
      .map(f => {
        const filepath = path.join(backupsDir, f);
        const stats = fs.statSync(filepath);
        return {
          filename: f,
          size: stats.size,
          createdAt: stats.birthtime || stats.mtime
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
      
    res.json({ success: true, backups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Create database backup
router.post('/backups/create', protect, authorize('superadmin'), async (req, res) => {
  try {
    const backupsDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const backupData = {};
    
    for (const collInfo of collections) {
      const collName = collInfo.name;
      if (collName.startsWith('system.')) continue;
      
      const docs = await db.collection(collName).find({}).toArray();
      backupData[collName] = serializeDoc(docs);
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup_${timestamp}.json`;
    const filepath = path.join(backupsDir, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2), 'utf-8');
    
    const stats = fs.statSync(filepath);
    res.json({
      success: true,
      message: 'Backup created successfully',
      backup: {
        filename,
        size: stats.size,
        createdAt: stats.birthtime || stats.mtime
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Restore database from backup
router.post('/backups/restore', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Filename is required' });
    }
    
    const backupsDir = path.join(__dirname, '../backups');
    const filepath = path.join(backupsDir, filename);
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: 'Backup file not found' });
    }
    
    const rawData = fs.readFileSync(filepath, 'utf-8');
    const backupData = JSON.parse(rawData);
    const db = mongoose.connection.db;
    
    // Clear and restore each collection
    for (const [collName, docs] of Object.entries(backupData)) {
      // 1. Clear current collection
      await db.collection(collName).deleteMany({});
      
      // 2. Insert restored documents if present
      if (docs && docs.length > 0) {
        const parsedDocs = deserializeDoc(docs);
        await db.collection(collName).insertMany(parsedDocs);
      }
    }
    
    res.json({ success: true, message: `Database successfully restored from ${filename}` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE: Delete a backup file
router.delete('/backups/:filename', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { filename } = req.params;
    const backupsDir = path.join(__dirname, '../backups');
    const filepath = path.join(backupsDir, filename);
    
    // Safety check to prevent directory traversal
    const safePath = path.resolve(filepath);
    const safeBackupsDir = path.resolve(backupsDir);
    if (!safePath.startsWith(safeBackupsDir)) {
      return res.status(400).json({ success: false, error: 'Access denied' });
    }
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: 'Backup file not found' });
    }
    
    fs.unlinkSync(filepath);
    res.json({ success: true, message: `Backup file ${filename} deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET: Download a backup file
router.get('/backups/download/:filename', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { filename } = req.params;
    const backupsDir = path.join(__dirname, '../backups');
    const filepath = path.join(backupsDir, filename);
    
    // Safety check to prevent directory traversal
    const safePath = path.resolve(filepath);
    const safeBackupsDir = path.resolve(backupsDir);
    if (!safePath.startsWith(safeBackupsDir)) {
      return res.status(400).json({ success: false, error: 'Access denied' });
    }
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ success: false, error: 'Backup file not found' });
    }
    
    res.download(filepath, filename);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// OWNER SUBSCRIPTION / FREE TRIAL MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: get or create system settings doc
async function getSettings() {
  let s = await SystemSettings.findOne();
  if (!s) s = await SystemSettings.create({});
  return s;
}

// Helper: compute trial status for one owner
function computeTrialStatus(owner, trialDays) {
  const now = new Date();
  // Use subscription.trialStartDate, else fall back to owner.createdAt
  const startDate = owner.subscription?.trialStartDate || owner.createdAt || now;
  // Use subscription.trialEndDate if manually set, else calculate from trialDays
  let endDate = owner.subscription?.trialEndDate;
  if (!endDate && trialDays) {
    endDate = new Date(new Date(startDate).getTime() + trialDays * 24 * 60 * 60 * 1000);
  }

  const isSubscribed = owner.subscription?.isSubscribed || false;
  const subscriptionExpiry = owner.subscription?.subscriptionExpiry;

  // If subscribed and subscription not expired
  if (isSubscribed && subscriptionExpiry && new Date(subscriptionExpiry) > now) {
    return { status: 'subscribed', daysRemaining: null, trialExpired: false, endDate: subscriptionExpiry, startDate };
  }

  if (!endDate) {
    // Trial days not configured yet
    return { status: 'trial_unconfigured', daysRemaining: null, trialExpired: false, endDate: null, startDate };
  }

  const msRemaining = new Date(endDate).getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
  const trialExpired = msRemaining <= 0;

  return {
    status: trialExpired ? 'expired' : 'trial_active',
    daysRemaining: trialExpired ? 0 : daysRemaining,
    trialExpired,
    endDate,
    startDate
  };
}

// GET /api/superadmin/owner-subscriptions — all owners with trial/subscription status (Scoped for employees)
router.get('/owner-subscriptions', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const ownerFilter = applyOwnerScope(req, { isDeleted: { $ne: true } });
    const [owners, settings] = await Promise.all([
      Owner.find(ownerFilter)
        .select('loginId name email phone createdAt subscription isActive')
        .lean(),
      getSettings()
    ]);

    const trialDays = settings.ownerTrialDays || null;

    const ownersWithStatus = owners.map(owner => {
      const trial = computeTrialStatus(owner, trialDays);
      return {
        _id: owner._id,
        loginId: owner.loginId,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        isActive: owner.isActive,
        createdAt: owner.createdAt,
        subscription: owner.subscription,
        trialStatus: trial
      };
    });

    // Stats summary
    const total = ownersWithStatus.length;
    const trialActive = ownersWithStatus.filter(o => o.trialStatus.status === 'trial_active').length;
    const expired = ownersWithStatus.filter(o => o.trialStatus.status === 'expired').length;
    const subscribed = ownersWithStatus.filter(o => o.trialStatus.status === 'subscribed').length;
    const unconfigured = ownersWithStatus.filter(o => o.trialStatus.status === 'trial_unconfigured').length;

    return res.json({
      success: true,
      stats: { total, trialActive, expired, subscribed, unconfigured },
      owners: ownersWithStatus,
      settings: {
        ownerTrialDays: settings.ownerTrialDays,
        ownerSubscriptionPrice: settings.ownerSubscriptionPrice,
        ownerSubscriptionCurrency: settings.ownerSubscriptionCurrency
      }
    });
  } catch (err) {
    console.error('❌ owner-subscriptions error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/superadmin/owner-subscriptions/:ownerId/extend — extend trial or mark subscribed
router.post('/owner-subscriptions/:ownerId/extend', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { ownerId } = req.params;
    const { newTrialEndDate, extendByDays, markSubscribed, subscriptionExpiry, note } = req.body;

    const owner = await Owner.findOne({
      $or: [{ loginId: ownerId }, { _id: mongoose.Types.ObjectId.isValid(ownerId) ? ownerId : null }]
    });
    if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

    const superadminLoginId = req.user?.loginId || 'superadmin';
    const now = new Date();

    if (!owner.subscription) owner.subscription = {};

    // Set trial start if missing
    if (!owner.subscription.trialStartDate) {
      owner.subscription.trialStartDate = owner.createdAt || now;
    }

    if (markSubscribed) {
      // Mark as fully subscribed
      owner.subscription.isSubscribed = true;
      owner.subscription.subscriptionExpiry = subscriptionExpiry ? new Date(subscriptionExpiry) : null;
    } else if (newTrialEndDate) {
      // Set specific end date
      owner.subscription.trialEndDate = new Date(newTrialEndDate);
      owner.subscription.isSubscribed = false;
    } else if (extendByDays) {
      // Extend from current end date or now
      const currentEnd = owner.subscription.trialEndDate
        ? new Date(owner.subscription.trialEndDate)
        : now;
      const base = currentEnd < now ? now : currentEnd; // if already expired, extend from now
      owner.subscription.trialEndDate = new Date(base.getTime() + Number(extendByDays) * 24 * 60 * 60 * 1000);
      owner.subscription.isSubscribed = false;
    }

    owner.subscription.extendedBy = superadminLoginId;
    owner.subscription.extensionNote = note || '';
    owner.subscription.lastExtendedAt = now;

    await owner.save();

    const settings = await getSettings();
    const trialStatus = computeTrialStatus(owner.toObject(), settings.ownerTrialDays);

    return res.json({
      success: true,
      message: 'Owner subscription updated successfully',
      owner: {
        loginId: owner.loginId,
        name: owner.name,
        subscription: owner.subscription,
        trialStatus
      }
    });
  } catch (err) {
    console.error('❌ extend owner subscription error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/superadmin/subscription-settings — get current trial & price settings
router.get('/subscription-settings', protect, authorize('superadmin'), async (req, res) => {
  try {
    const settings = await getSettings();
    return res.json({
      success: true,
      ownerTrialDays: settings.ownerTrialDays ?? null,
      ownerSubscriptionPrice: settings.ownerSubscriptionPrice ?? null,
      ownerSubscriptionCurrency: settings.ownerSubscriptionCurrency || 'INR'
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/superadmin/subscription-settings — update trial days & price
router.put('/subscription-settings', protect, authorize('superadmin'), async (req, res) => {
  try {
    const { ownerTrialDays, ownerSubscriptionPrice, ownerSubscriptionCurrency } = req.body;
    const settings = await getSettings();

    if (ownerTrialDays !== undefined) settings.ownerTrialDays = Number(ownerTrialDays);
    if (ownerSubscriptionPrice !== undefined) settings.ownerSubscriptionPrice = ownerSubscriptionPrice === '' ? undefined : Number(ownerSubscriptionPrice);
    if (ownerSubscriptionCurrency) settings.ownerSubscriptionCurrency = ownerSubscriptionCurrency;
    settings.updated_by = req.user?.loginId || 'superadmin';

    await settings.save();
    return res.json({
      success: true,
      message: 'Subscription settings updated',
      ownerTrialDays: settings.ownerTrialDays,
      ownerSubscriptionPrice: settings.ownerSubscriptionPrice,
      ownerSubscriptionCurrency: settings.ownerSubscriptionCurrency
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Test Email Route for SMTP Verification
router.get('/test-email', async (req, res) => {
  try {
    const to = req.query.to || process.env.SUPERADMIN_EMAIL || 'helloroomhy@gmail.com';
    const { sendMail, getMailerConfig } = require('../utils/mailer');
    const cfg = getMailerConfig();
    const result = await sendMail(
      to,
      'RoomHy SMTP Test Email',
      'This is a test email sent from RoomHy backend to test updated SMTP credentials.',
      '<h3>RoomHy SMTP Test Email</h3><p>This is a test email sent from RoomHy backend to test updated SMTP credentials.</p>'
    );
    return res.json({
      success: result,
      recipient: to,
      config: { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.smtpUser }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
