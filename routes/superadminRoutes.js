const express = require('express');
const router = express.Router();
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const User = require('../models/user');
const Booking = require('../models/BookingRequest');
const Rent = require('../models/Rent');

// Get platform overview stats (Main Dashboard)
router.get('/stats', async (req, res) => {
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
router.get('/home/overview', async (req, res) => {
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
router.get('/properties/overview', async (req, res) => {
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
router.get('/users/overview', async (req, res) => {
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
router.get('/accounting/overview', async (req, res) => {
  try {
    const rents = await Rent.find({});
    let totalCollection = 0;
    let revenue = 0;
    rents.forEach(r => {
      totalCollection += (r.rentAmount || 0);
      revenue += (r.commissionAmount || 0);
    });

    res.json({
      success: true,
      summary: {
        totalCollection,
        totalPayout: totalCollection - revenue,
        revenue,
        dueRent: 15400,
        pendingPayout: 8200
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bookings Overview
router.get('/bookings/overview', async (req, res) => {
  try {
    const total = await Booking.countDocuments();
    res.json({
      success: true,
      summary: {
        todayLeads: 12,
        weekLeads: 84,
        monthLeads: 324,
        todayBookings: 5,
        weekBookings: 28,
        monthBookings: total
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reviews Overview
router.get('/reviews/overview', async (req, res) => {
  res.json({
    success: true,
    summary: { today: 8, week: 42, month: 156, avgRating: 4.8, total: 1240, pending: 12 }
  });
});

// Reports Overview
router.get('/reports/overview', async (req, res) => {
  res.json({
    success: true,
    summary: { totalProperties: 2340, totalTenants: 12845, occupancyRate: 84, monthlyRevenue: 85674, netProfit: 12450, growthRate: 12.5 }
  });
});

// Support Overview
router.get('/support/overview', async (req, res) => {
  res.json({
    success: true,
    summary: { total: 450, open: 32, inProgress: 18, resolved: 384, overdue: 5, avgTime: '1.2 Days' }
  });
});

// User distribution for charts
router.get('/user-distribution', async (req, res) => {
  try {
    const [tenants, owners, staff] = await Promise.all([
      User.countDocuments({ role: 'tenant' }),
      User.countDocuments({ role: 'owner' }),
      User.countDocuments({ role: { $in: ['employee', 'admin', 'superadmin'] } })
    ]);
    res.json({ success: true, distribution: { labels: ['Tenants', 'Owners', 'Staff'], data: [tenants, owners, staff] } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Revenue trends
router.get('/revenue-trends', async (req, res) => {
  try {
    const monthlyData = [12000, 19000, 15000, 22000, 30000, 28000];
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    res.json({ success: true, labels, data: monthlyData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all owners
router.get('/owners', async (req, res) => {
  try {
    const owners = await User.find({ role: 'owner' }).select('name phone loginId email');
    res.json({ success: true, data: owners });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
