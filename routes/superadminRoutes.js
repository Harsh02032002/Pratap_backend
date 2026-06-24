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

router.get('/stats', protect, authorize('superadmin'), async (req, res) => {
  try {
    const [
      totalProperties,
      totalTenants,
      totalOwners,
      totalBookings,
      totalRents
    ] = await Promise.all([
      Property.countDocuments(),
      User.countDocuments({ role: { $in: ['tenant', 'user'] } }),
      User.countDocuments({ role: 'owner' }),
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
    const [properties, tenants, rents, pendingRents] = await Promise.all([
      Property.countDocuments(),
      User.countDocuments({ role: { $in: ['tenant', 'user'] } }),
      Rent.find({}),
      Rent.find({ paymentStatus: { $ne: 'paid' } }).limit(10).sort({ createdAt: -1 })
    ]);

    const totalAlerts = await Rent.countDocuments({ paymentStatus: { $ne: 'paid' } });
    
    let totalRevenue = 0;
    rents.forEach(rent => {
      const rentAmount = Number(rent.rentAmount || rent.totalDue || 0);
      const commission = Number(rent.commissionAmount || (rentAmount * 0.10));
      const fee = Number(rent.serviceFeeAmount || 50);
      totalRevenue += (commission + fee);
    });

    // Revenue trend (last 5 months)
    const trends = await Rent.aggregate([
      { $group: { 
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } }, 
          revenue: { $sum: { $add: [ { $ifNull: ["$commissionAmount", { $multiply: ["$rentAmount", 0.10] }] }, { $ifNull: ["$serviceFeeAmount", 50] } ] } } 
      }},
      { $sort: { "_id.year": 1, "_id.month": 1 } },
      { $limit: 5 }
    ]);

    const formattedTrends = trends.map(t => ({
      name: `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][t._id.month-1]} ${t._id.year}`,
      revenue: Math.round(t.revenue)
    }));

    res.json({
      success: true,
      summary: {
        totalProperties: properties,
        totalTenants: tenants,
        monthlyRevenue: Math.round(totalRevenue),
        alerts: totalAlerts
      },
      revenueTrend: formattedTrends.length > 0 ? formattedTrends : [
        { name: 'Jan', revenue: 0 }, { name: 'Feb', revenue: 0 }, { name: 'Mar', revenue: 0 }
      ],
      pendingAlerts: pendingRents.map(r => ({
        id: r._id,
        name: r.tenantName || 'Unknown Tenant',
        property: r.propertyName || 'Property',
        amount: r.rentAmount || 0,
        status: r.paymentStatus,
        overdue: r.createdAt ? Math.floor((Date.now() - new Date(r.createdAt)) / (1000 * 60 * 60 * 24)) : 0
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
    const [total, approved, pending, rejected] = await Promise.all([
      Property.countDocuments(),
      ApprovedProperty.countDocuments(),
      Property.countDocuments({ status: 'pending' }),
      Property.countDocuments({ status: 'rejected' })
    ]);

    res.json({
      success: true,
      summary: {
        total: total || approved + pending + rejected,
        approved,
        pending,
        rejected,
        newThisMonth: 142
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// User Management Overview
router.get('/users/overview', protect, authorize('superadmin'), async (req, res) => {
  try {
    const [total, team, owners, tenants] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: { $in: ['employee', 'admin', 'superadmin'] } }),
      User.countDocuments({ role: 'owner' }),
      User.countDocuments({ role: 'tenant' })
    ]);

    res.json({
      success: true,
      summary: { total, team, owners, tenants, activeToday: total - 8 }
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

    // 2. Unpaid rents & due rent aging
    const unpaidRents = await Rent.find({ paymentStatus: { $nin: ['paid', 'completed'] } }).lean();
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

    res.json({
      success: true,
      summary: {
        totalCollection,
        totalPayout: completedPayout,
        revenue,
        dueRent,
        pendingPayout
      },
      trends,
      ledger,
      dueRentAging: [
        { name: "0 - 30 Days", value: age30, color: "#3B82F6" },
        { name: "31 - 60 Days", value: age60, color: "#10B981" },
        { name: "61 - 90 Days", value: age90, color: "#F59E0B" },
        { name: "90+ Days", value: age90Plus, color: "#EF4444" }
      ]
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
      todayLeads,
      weekLeads,
      monthLeads,
      todayBookings,
      weekBookings,
      monthBookings,
      enquiries,
      bookingsList
    ] = await Promise.all([
      Enquiry.countDocuments({ ts: { $gte: todayStart } }),
      Enquiry.countDocuments({ ts: { $gte: weekAgo } }),
      Enquiry.countDocuments({ ts: { $gte: monthAgo } }),
      BookingRequest.countDocuments({ created_at: { $gte: todayStart } }),
      BookingRequest.countDocuments({ created_at: { $gte: weekAgo } }),
      BookingRequest.countDocuments({ created_at: { $gte: monthAgo } }),
      Enquiry.find({}).sort({ ts: -1 }).lean(),
      BookingRequest.find({}).sort({ created_at: -1 }).lean()
    ]);

    const totalLeads = enquiries.length;
    const contactedLeads = enquiries.filter(e => e.status !== 'pending').length;
    const interestedLeads = enquiries.filter(e => ['accepted', 'approved', 'confirmed'].includes(e.status)).length;
    const siteVisitLeads = enquiries.filter(e => e.visitAllowed || e.visitTime).length;
    const bookingsCount = bookingsList.length;

    // 2. Funnel Data
    const funnel = [
      { label: "Total Leads",  val: totalLeads, pct: null,     color: "#6366F1", w: 100 },
      { label: "Contacted",    val: contactedLeads, pct: totalLeads > 0 ? `${((contactedLeads/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#3B82F6", w: totalLeads > 0 ? Math.round((contactedLeads/totalLeads)*100) : 0 },
      { label: "Interested",   val: interestedLeads, pct: totalLeads > 0 ? `${((interestedLeads/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#22D3EE", w: totalLeads > 0 ? Math.round((interestedLeads/totalLeads)*100) : 0 },
      { label: "Site Visit",   val: siteVisitLeads, pct: totalLeads > 0 ? `${((siteVisitLeads/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#10B981", w: totalLeads > 0 ? Math.round((siteVisitLeads/totalLeads)*100) : 0 },
      { label: "Bookings",     val: bookingsCount, pct: totalLeads > 0 ? `${((bookingsCount/totalLeads)*100).toFixed(1)}%` : '0%',  color: "#F59E0B", w: totalLeads > 0 ? Math.round((bookingsCount/totalLeads)*100) : 0 }
    ];

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
        trendMap[label].bookings += 1;
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
      summary: {
        todayLeads,
        weekLeads,
        monthLeads,
        todayBookings,
        weekBookings,
        monthBookings
      },
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
      totalLeads,
      interestedLeads,
      viewedLeads,
      initiatedBookings,
      confirmedBookings
    ] = await Promise.all([
      Enquiry.countDocuments(),
      Enquiry.countDocuments({ status: { $in: ['accepted', 'approved', 'confirmed'] } }),
      Enquiry.countDocuments({ visitAllowed: true }),
      BookingRequest.countDocuments(),
      BookingRequest.countDocuments({ status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } })
    ]);

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

      const [mLeads, mConfirmed] = await Promise.all([
        Enquiry.countDocuments({ ts: { $gte: start, $lte: end } }),
        BookingRequest.countDocuments({ createdAt: { $gte: start, $lte: end }, status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } })
      ]);

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
      const totalPropLeads = await Enquiry.countDocuments({ propertyName: item._id });
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
      const totalLocConfirmed = await BookingRequest.countDocuments({ 
        location: item._id, 
        status: { $in: ['confirmed', 'Confirmed', 'paid', 'Paid'] } 
      });
      const rate = item.count > 0 ? Number(((totalLocConfirmed / item.count) * 100).toFixed(1)) : 0;
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
        directRate: totalLeads > 0 ? `${((await BookingRequest.countDocuments({ bookingType: 'direct', status: { $in: ['confirmed', 'Confirmed'] } }) / totalLeads) * 100).toFixed(1)}%` : "0%",
        onlineRate: totalLeads > 0 ? `${((await BookingRequest.countDocuments({ bookingType: { $ne: 'direct' }, status: { $in: ['confirmed', 'Confirmed'] } }) / totalLeads) * 100).toFixed(1)}%` : "0%",
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
    const enquiries = await Enquiry.find().sort({ ts: -1 }).lean();
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

    res.json({ success: true, leads });
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
    const { commission_percentage, updated_by } = req.body;
    
    if (commission_percentage === undefined || isNaN(Number(commission_percentage))) {
      return res.status(400).json({ success: false, message: 'Invalid commission percentage value' });
    }
    
    let settings = await SystemSettings.findOne();
    const oldPercentage = settings ? settings.commission_percentage : 10;
    if (!settings) {
      settings = new SystemSettings();
    }
    
    settings.commission_percentage = Number(commission_percentage);
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
      trendMap[label] = (trendMap[label] || 0) + (t.booking_amount || 0);
    });

    // Sort or format trend
    const trendData = Object.keys(trendMap).map(k => ({
      name: k,
      revenue: trendMap[k],
      listings: Math.round(trendMap[k] * 0.8), // simulated comparison listing value
    })).slice(-7); // Keep last 7 days/points

    if (trendData.length === 0) {
      trendData.push({ name: 'No Data', revenue: 0, listings: 0 });
    }

    res.json({
      success: true,
      stats: {
        totalRevenue,
        commissionEarned,
        ownerEarnings,
        pendingPayouts,
        paidPayouts,
        walletBalance,
        totalTransactions: txs.length
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
    
    // Format Payments table rows
    const payments = txs.map(t => ({
      id: t._id,
      razorpay_payment_id: t.razorpay_payment_id || 'N/A',
      booking_id: t.booking_id,
      tenant_name: t.tenant_name || 'N/A',
      property_name: t.property_name || 'N/A',
      amount: t.booking_amount,
      payout_status: t.payout_status,
      date: t.payment_date ? t.payment_date.toISOString().split('T')[0] : 'N/A'
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

    res.json({
      success: true,
      payments,
      commissions,
      payouts
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

    const [
      totalProperties,
      totalTenants,
      rooms,
      txs,
      employees,
      maintenanceTasksCount
    ] = await Promise.all([
      Property.countDocuments(),
      User.countDocuments({ role: { $in: ['tenant', 'user'] } }),
      Room.find({ isDeleted: { $ne: true } }).lean(),
      PaymentTransaction.find({}).lean(),
      Employee.find({ isDeleted: { $ne: true } }).limit(5).lean(),
      mongoose.modelNames().includes('MaintenanceTask') 
        ? mongoose.model('MaintenanceTask').countDocuments({ status: { $ne: 'completed' } })
        : Promise.resolve(0)
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
      val: monthlyTrendMap[l] || 0
    }));

    // Top 5 Property Performance
    const propMap = {};
    txs.forEach(t => {
      if (!t.property_id) return;
      if (!propMap[t.property_id]) {
        propMap[t.property_id] = { name: t.property_name || 'Property', rev: 0 };
      }
      propMap[t.property_id].rev += t.booking_amount || 0;
    });

    const propertyPerformance = Object.keys(propMap).map(k => ({
      name: propMap[k].name,
      loc: 'Multiple Locations', 
      occupancy: totalBeds > 0 ? `${occupancyPct}%` : 'No Data Available',
      revenue: `₹${propMap[k].rev.toLocaleString('en-IN')}`,
      img: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=100&h=100&fit=crop'
    })).sort((a,b) => b.rev - a.rev).slice(0, 5);

    // Location wise data
    const locationMap = {};
    txs.forEach(t => {
      const loc = t.property_name?.includes('Mumbai') ? 'Mumbai' : 
                  t.property_name?.includes('Bangalore') ? 'Bangalore' : 
                  t.property_name?.includes('Pune') ? 'Pune' : 'Other';
      locationMap[loc] = (locationMap[loc] || 0) + (t.booking_amount || 0);
    });

    const locationWiseData = Object.keys(locationMap).map(k => ({
      name: k,
      value: `₹${locationMap[k].toLocaleString('en-IN')}`,
      count: 'Properties'
    }));

    // Staff Performance Mapping
    const staffList = employees.map(e => ({
      name: e.name,
      role: e.role || 'Property Manager',
      managed: 0,
      leads: 0,
      perf: '0%'
    }));

    const responsePayload = {
      success: true,
      summary: {
        totalProperties,
        totalTenants,
        occupancyRate: totalBeds > 0 ? occupancyPct : 0,
        monthlyRevenue,
        netProfit: totalCommission,
        growthRate: 0
      },
      charts: {
        revenueOverviewData,
        occupancyData: totalBeds > 0 ? [
          { name: "Occupied", value: occupiedBeds, color: "#3B82F6", percent: `${occupancyPct}%` },
          { name: "Vacant", value: vacantBeds, color: "#10B981", percent: `${(100 - occupancyPct).toFixed(1)}%` },
          { name: "Maintenance", value: maintenanceTasksCount, color: "#F59E0B", percent: "0%" }
        ] : [],
        propertyPerformance,
        locationWiseData,
        staffPerformance: staffList
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
router.get('/support/tickets', protect, authorize('superadmin'), async (req, res) => {
  try {
    const SupportTicket = require('../models/SupportTicket');
    const tickets = await SupportTicket.find({}).sort({ created_at: -1 }).lean();
    res.json({ success: true, tickets });
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

// Get all owners
router.get('/owners', protect, authorize('superadmin'), async (req, res) => {
  try {
    const owners = await User.find({ role: 'owner' }).select('name phone loginId email');
    res.json({ success: true, data: owners });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
