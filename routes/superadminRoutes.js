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

router.get('/stats', protect, authorize('superadmin', 'areamanager', 'employee', 'manager'), async (req, res) => {
  try {
    const [
      totalProperties,
      totalTenants,
      totalOwners,
      totalBookings,
      totalRents
    ] = await Promise.all([
      Property.countDocuments({ isDeleted: { $ne: true } }),
      User.countDocuments({ role: { $in: ['tenant', 'user'] }, isDeleted: { $ne: true } }),
      Owner.countDocuments({ isDeleted: { $ne: true } }),
      Booking.countDocuments(),
      Rent.countDocuments()
    ]);

    const rents = await Rent.find({});
    let totalBookingAmount = 0;
    let platformCommission = 0;
    let serviceFee = 0;
    const monthBuckets = {};

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

    const netRevenue = platformCommission + serviceFee;
    const recentSignups = await User.find({ role: 'tenant' })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name email createdAt kycStatus');

    res.json({
      success: true,
      stats: {
        tenants: totalTenants,
        properties: totalProperties,
        owners: totalOwners,
        totalBookings,
        totalBookingAmount,
        platformCommission,
        serviceFee,
        netRevenue
      },
      recentSignups: recentSignups.map(user => ({
        name: user.name,
        email: user.email,
        role: 'tenant',
        moveInDate: user.createdAt?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0],
        kycStatus: user.kycStatus || 'pending'
      })),
      monthlyRevenue: monthBuckets
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats', error: error.message });
  }
});

// Home Overview Stats
router.get('/home/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const { city } = req.query;

    let propFilter = { isDeleted: { $ne: true } };
    if (city && city !== 'All Cities') {
      propFilter.city = city;
    }

    // Resolve property IDs in city
    const propertiesList = await Property.find(propFilter).select('_id status isLiveOnWebsite').lean();
    const propIds = propertiesList.map(p => p._id);

    // --- Core counts (exclude deleted) ---
    let tenantFilter = { isDeleted: { $ne: true } };
    let rentFindFilter = {};
    if (city && city !== 'All Cities') {
      tenantFilter.property = { $in: propIds };
      rentFindFilter.propertyId = { $in: propIds };
    }

    const [propertiesCount, tenantsCount, rents] = await Promise.all([
      Property.countDocuments(propFilter),
      Tenant.countDocuments(tenantFilter),
      Rent.find(rentFindFilter).lean()
    ]);

    // --- Only count pending rents for active (non-deleted) tenants ---
    let activeTenantQuery = {
      isDeleted: { $ne: true },
      status: { $nin: ['inactive', 'suspended'] }
    };
    if (city && city !== 'All Cities') {
      activeTenantQuery.property = { $in: propIds };
    }

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
    if (city && city !== 'All Cities') {
      pendingRentFilter.propertyId = { $in: propIds };
    }

    const [totalAlerts, pendingRents] = await Promise.all([
      Rent.countDocuments(pendingRentFilter),
      Rent.find(pendingRentFilter).limit(10).sort({ createdAt: -1 })
    ]);

    // --- Revenue calculation (PaymentTransaction commission + fallback to active tenant rents) ---
    const txs = await PaymentTransaction.find({}).lean();
    let txCommission = 0;
    txs.forEach(t => {
      txCommission += (t.commission_amount || 0);
    });

    const activeIdSet = new Set(activeTenantIds.map(String));
    const activeLoginSet = new Set(activeTenantLoginIds);
    let totalRevenue = 0;
    rents.forEach(rent => {
      const tid = rent.tenantId ? String(rent.tenantId) : '';
      const login = rent.tenantLoginId || '';
      if (!activeIdSet.has(tid) && !activeLoginSet.has(login)) return;
      const rentAmount = Number(rent.rentAmount || rent.totalDue || 0);
      const commission = Number(rent.commissionAmount || (rentAmount * 0.10));
      const fee = Number(rent.serviceFeeAmount || 50);
      totalRevenue += (commission + fee);
    });

    const finalRevenue = txCommission > 0 ? txCommission : totalRevenue;

    // --- Revenue trend (last 5 months) ---
    let trendMatch = {};
    if (city && city !== 'All Cities') {
      trendMatch = { propertyId: { $in: propIds } };
    }

    const trends = await Rent.aggregate([
      ...(Object.keys(trendMatch).length > 0 ? [{ $match: trendMatch }] : []),
      { $group: { 
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } }, 
          revenue: { $sum: { $add: [ { $ifNull: ["$commissionAmount", { $multiply: ["$rentAmount", 0.10] }] }, { $ifNull: ["$serviceFeeAmount", 50] } ] } } 
      }},
      { $sort: { "_id.year": -1, "_id.month": -1 } },
      { $limit: 5 }
    ]);

    const formattedTrends = trends.reverse().map(t => ({
      name: `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t._id.month-1]} ${t._id.year}`,
      revenue: Math.round(t.revenue)
    }));

    // --- Properties by Status (live on website + approval state) ---
    const statusBuckets = {
      Live: 0,
      Active: 0,
      Pending: 0,
      Inactive: 0,
      Blocked: 0
    };

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

    const totalProps = Object.values(statusBuckets).reduce((s, n) => s + n, 0) || 1;
    const propertiesByStatus = Object.entries(statusBuckets)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => {
        const mapped = statusColorMap[key];
        return {
          name: mapped.label,
          value: count,
          color: mapped.color,
          percent: `${((count / totalProps) * 100).toFixed(1)}%`
        };
      });

    // --- Tenants by Type (occupation) aggregation ---
    let occMatch = { isDeleted: { $ne: true }, status: { $nin: ['inactive', 'suspended'] } };
    if (city && city !== 'All Cities') {
      occMatch.property = { $in: propIds };
    }

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

    res.json({
      success: true,
      summary: {
        totalProperties: propertiesCount,
        totalTenants: tenantsCount,
        monthlyRevenue: Math.round(finalRevenue),
        alerts: totalAlerts
      },
      revenueTrend: formattedTrends.length > 0 ? formattedTrends : [
        { name: 'Jan', revenue: 0 }, { name: 'Feb', revenue: 0 }, { name: 'Mar', revenue: 0 }
      ],
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
router.get('/properties/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [total, approved, pending, rejected, newThisMonth] = await Promise.all([
      Property.countDocuments({ isDeleted: { $ne: true } }),
      ApprovedProperty.countDocuments(),
      Property.countDocuments({ status: 'pending', isDeleted: { $ne: true } }),
      Property.countDocuments({ status: 'rejected', isDeleted: { $ne: true } }),
      Property.countDocuments({ createdAt: { $gte: startOfMonth }, isDeleted: { $ne: true } })
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
router.get('/users/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Tenant = require('../models/Tenant');
    const Employee = require('../models/Employee');
    const [userTeamCount, empCount, owners, tenants] = await Promise.all([
      User.countDocuments({ role: { $in: ['employee', 'areamanager', 'manager', 'admin'] }, isDeleted: { $ne: true } }),
      Employee.countDocuments({ isDeleted: { $ne: true } }),
      Owner.countDocuments({ isDeleted: { $ne: true } }),
      User.countDocuments({ role: 'tenant', isDeleted: { $ne: true } })
    ]);
    const team = userTeamCount + empCount;
    const total = team + owners + tenants;

    // Fetch recent signups
    const recentSignups = await User.find({ isDeleted: { $ne: true }, role: { $ne: 'superadmin' } })
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

    // Approvals queue
    const pendingOwnersCount = await User.countDocuments({ role: 'owner', kycStatus: { $in: ['pending', 'submitted'] } });
    const pendingTenantsCount = await Tenant.countDocuments({ isDeleted: { $ne: true }, kycStatus: { $in: ['pending', 'submitted'] } });
    const pendingDocsCount = await Tenant.countDocuments({ isDeleted: { $ne: true }, kycStatus: 'submitted' });

    // KYC Status Counts
    const [verifiedOwners, verifiedTenants, pendingOwners, pendingTenants, rejectedOwners, rejectedTenants] = await Promise.all([
      User.countDocuments({ role: 'owner', kycStatus: 'verified' }),
      Tenant.countDocuments({ isDeleted: { $ne: true }, kycStatus: 'verified' }),
      User.countDocuments({ role: 'owner', kycStatus: 'pending' }),
      Tenant.countDocuments({ isDeleted: { $ne: true }, kycStatus: 'pending' }),
      User.countDocuments({ role: 'owner', kycStatus: 'rejected' }),
      Tenant.countDocuments({ isDeleted: { $ne: true }, kycStatus: 'rejected' }),
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

    // 1. Get transactions & calculate stats
    const txs = await PaymentTransaction.find({}).sort({ payment_date: -1 }).lean();
    let totalCollection = 0;
    let revenue = 0;
    let completedPayout = 0;
    let pendingPayout = 0;

    txs.forEach(t => {
      totalCollection += (t.booking_amount || 0);
      revenue += (t.commission_amount || 0);
      if (t.payout_status === 'Paid') {
        completedPayout += (t.owner_amount || 0);
      } else {
        pendingPayout += (t.owner_amount || 0);
      }
    });

    // 2. Unpaid rents & due rent aging (active tenants only)
    const Tenant = require('../models/Tenant');
    const activeTenants = await Tenant.find({
      isDeleted: { $ne: true },
      status: { $nin: ['inactive', 'suspended'] }
    }).select('_id loginId').lean();
    const activeTenantIds = activeTenants.map(t => t._id);
    const activeTenantLoginIds = activeTenants.map(t => t.loginId).filter(Boolean);

    const unpaidRents = await Rent.find({
      paymentStatus: { $nin: ['paid', 'completed'] },
      $or: [
        { tenantId: { $in: activeTenantIds } },
        { tenantLoginId: { $in: activeTenantLoginIds } }
      ]
    }).lean();
    let dueRent = 0;
    let age30 = 0;
    let age60 = 0;
    let age90 = 0;
    let age90Plus = 0;

    const now = new Date();
    unpaidRents.forEach(r => {
      const due = (r.totalDue || r.rentAmount || 0) - (r.paidAmount || 0);
      if (due > 0) {
        dueRent += due;
        const createdDate = r.createdAt || r.updatedAt || now;
        const diffDays = Math.floor((now - new Date(createdDate)) / (1000 * 60 * 60 * 24));
        if (diffDays <= 30) age30 += due;
        else if (diffDays <= 60) age60 += due;
        else if (diffDays <= 90) age90 += due;
        else age90Plus += due;
      }
    });

    // 3. Trends (payout vs collection) for past 5 months
    const monthlyTrendMap = {};
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const last5Months = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = months[d.getMonth()];
      last5Months.push(label);
      monthlyTrendMap[label] = { collection: 0, payout: 0 };
    }

    txs.forEach(t => {
      if (!t.payment_date) return;
      const mLabel = months[new Date(t.payment_date).getMonth()];
      if (monthlyTrendMap[mLabel]) {
        monthlyTrendMap[mLabel].collection += (t.booking_amount || 0);
        if (t.payout_status === 'Paid') {
          monthlyTrendMap[mLabel].payout += (t.owner_amount || 0);
        }
      }
    });

    const trends = last5Months.map(name => ({
      name,
      collection: monthlyTrendMap[name].collection,
      payout: monthlyTrendMap[name].payout
    }));

    // 4. Recent Ledger (Transactions)
    const ledger = txs.slice(0, 10).map(t => {
      const isPayout = t.payout_status === 'Paid';
      return {
        date: t.payment_date ? t.payment_date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A',
        desc: isPayout ? `Owner Payout - ${t.owner_name}` : `Rent Payment - ${t.property_name}`,
        type: isPayout ? 'Owner Payout' : 'Tenant Payment',
        amount: isPayout ? `- ₹ ${t.owner_amount.toLocaleString('en-IN')}` : `+ ₹ ${t.booking_amount.toLocaleString('en-IN')}`,
        status: isPayout ? 'Processed' : 'Success',
        color: isPayout ? 'blue' : 'green'
      };
    });

    const Owner = require('../models/Owner');
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
        overdueTenants: unpaidRents.length,
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
        rentDue: 28,
        paymentSuccess: 54,
        paymentFailure: 6,
        payoutProcessed: 18
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bookings Overview
router.get('/bookings/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');
    const PaymentTransaction = require('../models/PaymentTransaction');

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
      Enquiry.countDocuments({ ts: { $gte: todayStart } }),
      Enquiry.countDocuments({ ts: { $gte: weekAgo } }),
      Enquiry.countDocuments({ ts: { $gte: monthAgo } }),
      BookingRequest.countDocuments({ created_at: { $gte: todayStart } }),
      BookingRequest.countDocuments({ created_at: { $gte: weekAgo } }),
      BookingRequest.countDocuments({ created_at: { $gte: monthAgo } }),
      BookingRequest.countDocuments({ created_at: { $gte: todayStart }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }),
      BookingRequest.countDocuments({ created_at: { $gte: weekAgo }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }),
      BookingRequest.countDocuments({ created_at: { $gte: monthAgo }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }),
      Enquiry.find({}).sort({ ts: -1 }).lean(),
      BookingRequest.find({}).sort({ created_at: -1 }).lean()
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

    // 3. Recent Leads
    const recentLeads = enquiries.slice(0, 5).map(e => {
      let statusColor = 'bg-blue-50 text-blue-600';
      if (e.status === 'contacted') statusColor = 'bg-amber-50 text-amber-600';
      else if (['accepted', 'approved', 'confirmed'].includes(e.status)) statusColor = 'bg-purple-50 text-purple-600';
      else if (e.visitAllowed) statusColor = 'bg-emerald-50 text-emerald-600';

      return {
        name: e.studentName || 'Unknown Student',
        loc: e.location || 'Multiple Locations',
        src: e.source || 'Website',
        budget: e.budget || 'N/A',
        status: e.status || 'New',
        sc: statusColor,
        time: e.ts ? e.ts.toISOString().split('T')[0] : 'N/A'
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

    // 6. Bookings Value
    const txsList = await PaymentTransaction.find({}).lean();
    let bookingsValue = 0;
    txsList.forEach(t => {
      bookingsValue += (t.booking_amount || 0);
    });

    // 7. Top Locations
    const locationCounts = {};
    enquiries.forEach(e => {
      const loc = e.location || 'Multiple Locations';
      if (!locationCounts[loc]) {
        locationCounts[loc] = { leads: 0, bookings: 0 };
      }
      locationCounts[loc].leads += 1;
    });

    bookingsList.forEach(b => {
      const loc = b.city || 'Multiple Locations';
      if (!locationCounts[loc]) {
        locationCounts[loc] = { leads: 0, bookings: 0 };
      }
      locationCounts[loc].bookings += 1;
    });

    const topLocations = Object.keys(locationCounts).map(loc => {
      const leads = locationCounts[loc].leads;
      const bookings = locationCounts[loc].bookings;
      const rate = leads > 0 ? ((bookings / leads) * 100).toFixed(2) + '%' : '0.00%';
      return {
        loc,
        leads,
        bookings,
        rate,
        w: leads > 0 ? Math.min(Math.round((bookings/leads)*100), 100) + '%' : '0%'
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

// Reviews Overview
router.get('/reviews/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Review = require('../models/Review');
    const now = new Date();
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalVerifiedStayReviews,
      pendingReviews,
      todayCount,
      weekCount,
      monthCount,
      avgRatingResult
    ] = await Promise.all([
      Review.countDocuments({ status: 'Approved', isVerifiedStay: true }),
      Review.countDocuments({ status: 'Pending' }),
      Review.countDocuments({ status: 'Approved', isVerifiedStay: true, createdAt: { $gte: todayStart } }),
      Review.countDocuments({ status: 'Approved', isVerifiedStay: true, createdAt: { $gte: weekAgo } }),
      Review.countDocuments({ status: 'Approved', isVerifiedStay: true, createdAt: { $gte: monthAgo } }),
      Review.aggregate([
        { $match: { status: 'Approved', isVerifiedStay: true } },
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

// Booking Conversion Rate Stats
router.get('/booking/conversion-stats', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');
    const [
      totalEnquiriesCount,
      enquiryInterested,
      enquiryViewed,
      initiatedBookings,
      confirmedBookings
    ] = await Promise.all([
      Enquiry.countDocuments(),
      Enquiry.countDocuments({ status: { $in: ['accepted', 'approved', 'confirmed'] } }),
      Enquiry.countDocuments({ visitAllowed: true }),
      BookingRequest.countDocuments(),
      BookingRequest.countDocuments({ status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } })
    ]);

    const totalLeads = totalEnquiriesCount + initiatedBookings;
    const interestedLeads = enquiryInterested + initiatedBookings;
    const bookingVisits = await BookingRequest.countDocuments({ visit_status: { $in: ['scheduled', 'completed'] } });
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
        Enquiry.countDocuments({ ts: { $gte: start, $lte: end } }),
        BookingRequest.countDocuments({ createdAt: { $gte: start, $lte: end } })
      ]);
      const mLeads = mLeadsCount + mInitiated;

      const mConfirmed = await BookingRequest.countDocuments({ 
        createdAt: { $gte: start, $lte: end }, 
        status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } 
      });

      const rate = mLeads > 0 ? Number(((mConfirmed / mLeads) * 100).toFixed(1)) : 0;
      monthlyTrend.push({ m: months[d.getMonth()], conv: rate });
    }

    const propertyConvRaw = await BookingRequest.aggregate([
      { $match: { status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } } },
      { $group: { _id: '$propertyName', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const propertyConv = [];
    for (const item of propertyConvRaw) {
      if (!item._id) continue;
      const totalPropLeads = await Enquiry.countDocuments({ propertyName: item._id }) + await BookingRequest.countDocuments({ property_name: item._id });
      const rate = totalPropLeads > 0 ? Number(((item.count / totalPropLeads) * 100).toFixed(1)) : 0;
      propertyConv.push({ name: item._id, rate: rate || 0 });
    }

    const locationConvRaw = await Enquiry.aggregate([
      { $group: { _id: '$location', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const locationConv = [];
    for (const item of locationConvRaw) {
      if (!item._id) continue;
      const totalLocLeads = await Enquiry.countDocuments({ location: item._id }) + await BookingRequest.countDocuments({ city: item._id });
      const totalLocConfirmed = await BookingRequest.countDocuments({ 
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
        directRate: totalLeads > 0 ? `${((await BookingRequest.countDocuments({ request_type: 'direct', status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }) / totalLeads) * 100).toFixed(1)}%` : "0%",
        onlineRate: totalLeads > 0 ? `${((await BookingRequest.countDocuments({ request_type: { $ne: 'direct' }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } }) / totalLeads) * 100).toFixed(1)}%` : "0%",
        avgTime: "4.2 Days"
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Leads List API
router.get('/booking/leads', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');

    const [enquiries, bookingRequests] = await Promise.all([
      Enquiry.find().sort({ ts: -1 }).lean(),
      BookingRequest.find().sort({ created_at: -1 }).lean()
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

// Locations Performance API
router.get('/booking/locations', protect, authorize('superadmin'), async (req, res) => {
  try {
    const Enquiry = require('../models/Enquiry');
    const BookingRequest = require('../models/BookingRequest');
    const ApprovedProperty = require('../models/ApprovedProperty');

    const [enquiries, bookingsList, properties] = await Promise.all([
      Enquiry.find().lean(),
      BookingRequest.find().lean(),
      ApprovedProperty.find().lean()
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
    const txs = await PaymentTransaction.find({}).lean();
    
    let totalRevenue = 0;      // booking_amount
    let commissionEarned = 0;  // commission_amount
    let ownerEarnings = 0;     // owner_amount
    let pendingPayouts = 0;    // owner_amount where Pending/Processing
    let paidPayouts = 0;       // owner_amount where Paid

    txs.forEach(t => {
      totalRevenue += (t.booking_amount || 0);
      commissionEarned += (t.commission_amount || 0);
      ownerEarnings += (t.owner_amount || 0);
      
      if (t.payout_status === 'Paid') {
        paidPayouts += (t.owner_amount || 0);
      } else {
        pendingPayouts += (t.owner_amount || 0);
      }
    });

    // Wallet Balance = Total Payments Received - Completed Owner Payouts
    const walletBalance = totalRevenue - paidPayouts;

    // Monthly trends (group by day-month of payment_date)
    const trendMap = {};
    txs.forEach(t => {
      if (!t.payment_date) return;
      const date = new Date(t.payment_date);
      const label = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); // "13 Jun"
      if (!trendMap[label]) {
        trendMap[label] = { collection: 0, payout: 0 };
      }
      trendMap[label].collection += (t.booking_amount || 0);
      if (t.payout_status === 'Paid') {
        trendMap[label].payout += (t.owner_amount || 0);
      }
    });

    // Sort or format trend
    const trendData = Object.keys(trendMap).map(k => ({
      name: k,
      collection: trendMap[k].collection,
      payout: trendMap[k].payout
    })).sort((a, b) => {
      // Sort chronologically by date
      const parseDate = (dStr) => {
        const parts = dStr.split(' ');
        const day = parseInt(parts[0], 10);
        const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
        const month = months[parts[1]] || 0;
        return new Date(new Date().getFullYear(), month, day);
      };
      return parseDate(a.name) - parseDate(b.name);
    }).slice(-7); // Keep last 7 days/points

    if (trendData.length === 0) {
      trendData.push({ name: 'No Data', collection: 0, payout: 0 });
    }

    const RefundRequest = require('../models/RefundRequest');
    const RentInvoice = require('../models/RentInvoice');

    const [invoicesCount, refundsCount] = await Promise.all([
      RentInvoice.countDocuments(),
      RefundRequest.countDocuments()
    ]);

    const payoutsCount = txs.filter(t => t.payout_status === 'Paid').length;
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
        totalTransactions: txs.length,
        invoicesCount,
        payoutsCount,
        refundsCount,
        gstCollected
      },
      trend: trendData
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

    const BookingRequest = require('../models/BookingRequest');

    const [
      totalProperties,
      totalTenants,
      rooms,
      txs,
      employees,
      maintenanceTasksCount,
      totalBookingsCount,
      confirmedBookingsCount,
      totalVisitReports,
      visitDataRecords
    ] = await Promise.all([
      Property.countDocuments(),
      User.countDocuments({ role: { $in: ['tenant', 'user'] } }),
      Room.find({ isDeleted: { $ne: true } }).lean(),
      PaymentTransaction.find({}).lean(),
      Employee.find({ isDeleted: { $ne: true } }).lean(),
      mongoose.modelNames().includes('MaintenanceTask') 
        ? mongoose.model('MaintenanceTask').countDocuments({ status: { $ne: 'completed' } })
        : Promise.resolve(0),
      BookingRequest.countDocuments(),
      BookingRequest.countDocuments({ $or: [{ status: 'confirmed' }, { booking_status: 'confirmed' }, { payment_status: 'Paid' }, { payment_status: 'completed' }] }),
      mongoose.model('VisitReport').find({}).populate('areaManager', 'name role email').lean(),
      mongoose.model('VisitData').find({}).lean()
    ]);
    
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ✅ Query results: ${JSON.stringify({ 
      totalProperties, 
      totalTenants, 
      roomsCount: rooms.length, 
      txsCount: txs.length, 
      employeesCount: employees.length,
      maintenanceTasksCount
    })}\n`);

    // Calculate Occupancy
    let totalBeds = 0;
    let occupiedBeds = 0;
    rooms.forEach(r => {
      totalBeds += (r.beds || r.bedCount || 0);
      occupiedBeds += (r.bedAssignments ? r.bedAssignments.length : (r.beds - r.vacantBeds || 0));
    });
    const occupancyPct = totalBeds > 0 ? Number(((occupiedBeds / totalBeds) * 100).toFixed(1)) : 0;
    const vacantBeds = totalBeds - occupiedBeds;

    // Calculate Revenues (Total and Monthly)
    let totalRev = 0;
    let totalCommission = 0;
    
    const now = new Date();
    const currentMonthStr = now.toLocaleDateString('en-IN', { month: 'short' }); // e.g. "Jun"
    
    const monthlyTrendMap = {};
    txs.forEach(t => {
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
      rev: monthlyTrendMap[l] || 0,
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
    txs.forEach(t => {
      if (!t.property_id) return;
      const pidStr = String(t.property_id);
      if (!propMap[pidStr]) {
        propMap[pidStr] = { name: t.property_name || 'Property', rev: 0 };
      }
      propMap[pidStr].rev += t.booking_amount || 0;
    });

    const propertyPerformance = Object.keys(propMap).map(k => {
      const city = propIdToCity[k] || 'Multiple Locations';
      return {
        name: propMap[k].name,
        loc: city, 
        occ: occupancyPct > 0 ? Math.round(occupancyPct) : 85, // fallback to typical occ
        rev: propMap[k].rev,
        img: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=100&h=100&fit=crop'
      };
    }).sort((a,b) => b.rev - a.rev).slice(0, 5);

    // Location wise data
    const locationMap = {};
    txs.forEach(t => {
      const pid = String(t.property_id || '');
      const city = propIdToCity[pid] || 'Other';
      locationMap[city] = (locationMap[city] || 0) + (t.booking_amount || 0);
    });

    const maxLocationRevenue = Math.max(...Object.values(locationMap), 1);
    const locationWiseData = Object.keys(locationMap).map(k => ({
      name: k,
      revenue: locationMap[k],
      percent: Math.round((locationMap[k] / maxLocationRevenue) * 100)
    })).sort((a,b) => b.revenue - a.revenue);

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

// Support Overview
router.get('/support/overview', protect, authorize('superadmin'), async (req, res) => {
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

// GET support tickets
router.get('/support/tickets', protect, authorize('superadmin', 'owner'), async (req, res) => {
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

// GET support resolution-data
router.get('/support/resolution-data', protect, authorize('superadmin'), async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    const tickets = await SupportTicket.find({}).sort({ created_at: -1 }).lean();

    const total = tickets.length;
    const resolved = tickets.filter(t => ['Resolved', 'Closed'].includes(t.status)).length;
    const pending = tickets.filter(t => ['Open', 'Assigned', 'In Progress', 'Waiting For Response'].includes(t.status)).length;
    const escalated = tickets.filter(t => t.status === 'In Progress' || t.sla_breached).length;

    const resRate = total > 0 ? ((resolved / total) * 100).toFixed(0) : '0';

    let totalMs = 0;
    let resolvedCount = 0;
    tickets.forEach(tk => {
      if (['Resolved', 'Closed'].includes(tk.status)) {
        const end = tk.resolved_at || tk.closed_at || tk.updated_at || new Date();
        const start = tk.created_at || (tk._id ? new Date(parseInt(tk._id.toString().substring(0, 8), 16) * 1000) : new Date());
        totalMs += (new Date(end) - new Date(start));
        resolvedCount++;
      }
    });
    const avgTimeDays = resolvedCount > 0 ? ((totalMs / resolvedCount) / (1000 * 60 * 60 * 24)).toFixed(1) : 'No Data Available';
    const avgTimeStr = avgTimeDays !== 'No Data Available' ? `${avgTimeDays} Days` : 'No Data Available';

    const categoryCounts = {};
    tickets.forEach(t => {
      const type = t.ticket_type || 'Other';
      categoryCounts[type] = (categoryCounts[type] || 0) + 1;
    });

    const COLORS_MAP = ["#3B82F6", "#10B981", "#F59E0B", "#6366F1", "#EC4899", "#94A3B8"];
    const categoryData = Object.keys(categoryCounts).map((name, idx) => ({
      name,
      value: categoryCounts[name],
      color: COLORS_MAP[idx % COLORS_MAP.length]
    }));

    const typeResolutionTimes = {};
    tickets.forEach(tk => {
      if (['Resolved', 'Closed'].includes(tk.status)) {
        const type = tk.ticket_type || 'Other';
        const end = tk.resolved_at || tk.closed_at || tk.updated_at || new Date();
        const start = tk.created_at || (tk._id ? new Date(parseInt(tk._id.toString().substring(0, 8), 16) * 1000) : new Date());
        const diffDays = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
        if (!typeResolutionTimes[type]) {
          typeResolutionTimes[type] = { totalDays: 0, count: 0 };
        }
        typeResolutionTimes[type].totalDays += diffDays;
        typeResolutionTimes[type].count += 1;
      }
    });

    const resolutionTime = Object.keys(typeResolutionTimes).map(type => ({
      type,
      days: Number((typeResolutionTimes[type].totalDays / typeResolutionTimes[type].count).toFixed(1))
    }));

    const monthlyTrendMap = {};
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const last6Months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = months[d.getMonth()];
      last6Months.push(label);
      monthlyTrendMap[label] = { raised: 0, resolved: 0 };
    }

    tickets.forEach(t => {
      const start = t.created_at || (t._id ? new Date(parseInt(t._id.toString().substring(0, 8), 16) * 1000) : null);
      if (!start) return;
      const createdMonth = months[new Date(start).getMonth()];
      if (monthlyTrendMap[createdMonth]) {
        monthlyTrendMap[createdMonth].raised += 1;
      }
      if (['Resolved', 'Closed'].includes(t.status)) {
        const resolvedDate = t.resolved_at || t.closed_at || t.updated_at || new Date();
        if (resolvedDate) {
          const resolvedMonth = months[new Date(resolvedDate).getMonth()];
          if (monthlyTrendMap[resolvedMonth]) {
            monthlyTrendMap[resolvedMonth].resolved += 1;
          }
        }
      }
    });

    const resolutionTrend = last6Months.map(m => ({
      m,
      raised: monthlyTrendMap[m].raised,
      resolved: monthlyTrendMap[m].resolved
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
router.get('/user-distribution', protect, authorize('superadmin'), async (req, res) => {
  try {
    const [tenants, owners, staff] = await Promise.all([
      User.countDocuments({ role: { $in: ['tenant', 'user'] } }),
      User.countDocuments({ role: 'owner' }),
      User.countDocuments({ role: { $in: ['employee', 'admin', 'superadmin'] } })
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

// ─── Revenue Stats ──────────────────────────────────────────────────────────
router.get('/revenue/stats', protect, authorize('superadmin'), async (req, res) => {
  try {
    const txs = await PaymentTransaction.find({}).lean();
    let totalRevenue = 0, commissionEarned = 0, ownerEarnings = 0, paidPayouts = 0, pendingPayouts = 0;
    txs.forEach(t => {
      totalRevenue    += (t.booking_amount || 0);
      commissionEarned+= (t.commission_amount || 0);
      ownerEarnings   += (t.owner_amount || 0);
      if (t.payout_status === 'Paid') paidPayouts    += (t.owner_amount || 0);
      else                            pendingPayouts  += (t.owner_amount || 0);
    });
    const walletBalance = totalRevenue - paidPayouts;
    res.json({
      success: true,
      stats: {
        totalRevenue, commissionEarned, ownerEarnings,
        paidPayouts, pendingPayouts, walletBalance,
        totalTransactions: txs.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all owners
router.get('/owners', protect, authorize('superadmin'), async (req, res) => {
  try {
    const owners = await User.find({ role: 'owner' }).select('name phone loginId email');
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

// GET /api/superadmin/owner-subscriptions — all owners with trial/subscription status
router.get('/owner-subscriptions', protect, authorize('superadmin'), async (req, res) => {
  try {
    const [owners, settings] = await Promise.all([
      Owner.find({ isDeleted: { $ne: true } })
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

module.exports = router;
