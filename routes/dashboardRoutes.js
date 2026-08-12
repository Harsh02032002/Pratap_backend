/**
 * Dashboard Aggregation Routes
 *
 * GET /api/dashboard/employee  — Secure employee dashboard (area-scoped, no revenue)
 * GET /api/dashboard/:ownerId  — Owner dashboard (unchanged)
 */

const express = require('express');
const router = express.Router();

const Owner               = require('../models/Owner');
const Property            = require('../models/Property');
const Room                = require('../models/Room');
const Tenant              = require('../models/Tenant');
const Enquiry             = require('../models/Enquiry');
const Notification        = require('../models/Notification');
const Complaint           = require('../models/Complaint');
const PaymentTransaction  = require('../models/PaymentTransaction');
const RentPayment         = require('../models/RentPayment');
const VisitData           = require('../models/VisitData');

const ownerController = require('../controllers/ownercontroller');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');
const { applyPropertyScope, applyVisitScope, applyComplaintScope, applyBookingScope } = require('../utils/scopeHelpers');
const { MODULE_KEYS } = require('../utils/permissionKeys');

// GET /:ownerId below is the Owner Dashboard's data source and is Owner/Admin-only
// by requirement — staff have their own separate /employee endpoint above with
// area-scoped stats and no revenue. This route is called unauthenticated by design
// (resolves the owner from the URL), so we can't just gate it behind `protect`;
// instead decode the Bearer token if present and reject outright when it belongs
// to an Employee (any staff role), regardless of that staff member's permissions.
async function isStaffRequest(req) {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) return false;
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || 'roomhy_default_jwt_secret_key_2026');
        const Employee = require('../models/Employee');
        const emp = await Employee.findById(decoded.id).select('_id');
        return !!emp;
    } catch (_) {
        return false; // not a staff token (owner/website token, or none) — allow
    }
}

// ─── Employee Dashboard ───────────────────────────────────────────────────────
/**
 * GET /api/dashboard/employee
 * Returns only area-scoped operational stats for the logged-in employee.
 * NEVER includes revenue, company analytics, or platform-wide figures.
 */
router.get('/employee', protect, authorize('superadmin', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const scope = req.employeeScope;

    // If superadmin accidentally hits this route, redirect to full stats
    if (!scope || !scope.isEmployee) {
      return res.json({ success: true, message: 'Use /api/admin/stats for superadmin dashboard', isEmployee: false });
    }

    const today      = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow   = new Date(today); tomorrow.setDate(today.getDate() + 1);

    const propFilter      = applyPropertyScope(req, {});
    const visitFilter     = applyVisitScope(req, {});
    const complaintFilter = applyComplaintScope(req, {});

    const assignedPropIds = scope.assignedProperties || [];
    const bookingFilter   = applyBookingScope(req, {});

    const [
      assignedPropertiesCount,
      assignedOwnersCount,
      pendingVisitsCount,
      todayTasksCount,
      assignedBookingsCount,
      assignedLeadsCount,
      assignedComplaintsCount,
      recentNotifications,
    ] = await Promise.allSettled([
      // 1. Assigned Properties (active, not deleted)
      Property.countDocuments({ ...propFilter }),

      // 2. Assigned Owners
      scope.assignedOwners?.length > 0
        ? Owner.countDocuments({ _id: { $in: scope.assignedOwners } })
        : Promise.resolve(0),

      // 3. Pending Visits for this employee
      VisitData.countDocuments({ ...visitFilter, status: { $in: ['pending', 'submitted', 'assigned'] } }),

      // 4. Today's Tasks for this employee
      require('../models/Task').countDocuments({
        assignedTo: scope.employeeId,
        dueDate: { $gte: today, $lt: tomorrow },
        status: { $ne: 'completed' }
      }),

      // 5. Bookings in assigned properties / area
      require('../models/BookingRequest').countDocuments({
        ...bookingFilter,
        status: { $in: ['pending', 'confirmed', 'new'] }
      }),

      // 6. Leads in assigned properties / area
      require('../models/Enquiry').countDocuments({
        ...(assignedPropIds.length > 0
          ? { propertyId: { $in: assignedPropIds.map(String) } }
          : { city: scope.city }),
        status: { $nin: ['closed', 'rejected', 'converted'] }
      }),

      // 7. Complaints assigned to this employee or in their properties
      Complaint.countDocuments({ ...complaintFilter, status: { $nin: ['Resolved', 'Closed'] } }),

      // 8. Recent notifications for this employee only
      Notification.find({
        $or: [
          { toLoginId: scope.loginId },
          { toEmployeeId: scope.employeeId },
        ]
      }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

    const safe = (result) => (result.status === 'fulfilled' ? result.value : 0);

    return res.json({
      success: true,
      isEmployee: true,
      employeeType: scope.employeeType,
      // ── Operational Stats (safe for employee view) ──────────────────────
      assignedPropertiesCount: safe(assignedPropertiesCount),
      assignedOwnersCount:     safe(assignedOwnersCount),
      pendingVisitsCount:      safe(pendingVisitsCount),
      todayTasksCount:         safe(todayTasksCount),
      assignedBookingsCount:   safe(assignedBookingsCount),
      assignedLeadsCount:      safe(assignedLeadsCount),
      assignedComplaintsCount: safe(assignedComplaintsCount),
      recentNotifications:     recentNotifications.status === 'fulfilled' ? recentNotifications.value : [],
      // ── Revenue / Platform Analytics → explicitly NOT included ──────────
      // totalRevenue: BLOCKED
      // companyAnalytics: BLOCKED
      // globalOwnerCount: BLOCKED
      // globalPropertyCount: BLOCKED
    });

  } catch (err) {
    console.error('[employee dashboard] error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Helper: compute rent totals from already-fetched data (no extra DB queries)
function sumRent(enquiries, transactions, rentPayments) {
    const enquiriesTotal = enquiries
        .filter(e => ['accepted', 'approved', 'active'].includes(String(e.status || '').toLowerCase()))
        .reduce((sum, e) => sum + (e.paidAmount || 0), 0);

    const txTotal = transactions.reduce((sum, t) => sum + (t.owner_amount || 0), 0);
    const rentPaymentsTotal = rentPayments.reduce((sum, r) => sum + (r.amount || 0), 0);

    return enquiriesTotal + txTotal + rentPaymentsTotal;
}

router.get('/:ownerId', async (req, res) => {
    if (await isStaffRequest(req)) {
        return res.status(403).json({ success: false, message: 'Forbidden: the Owner Dashboard is not available to staff accounts' });
    }

    const labelId = `dashboard:${req.params.ownerId}:${Date.now()}`;
    console.time(labelId);

    try {
        const loginId = String(req.params.ownerId || '').trim().toUpperCase();
        if (!loginId) {
            return res.status(400).json({ success: false, message: 'ownerId is required' });
        }

        // ── PHASE 1: Run heal ONCE (fire-and-forget — never blocks the response) ──
        ownerController.healOwnerProperties(loginId).catch(err =>
            console.error(`[dashboard] healOwnerProperties error for ${loginId}:`, err.message)
        );

        // ── PHASE 2: Parallel fetches ─────────────────────────────────────────────
        const loginRegex = new RegExp('^' + loginId + '$', 'i');
        const [
            ownerDoc,
            properties,
            enquiries,
            notifications,
            complaints,
            transactions,
        ] = await Promise.all([
            // 1. Owner details (lean, no populate needed for dashboard)
            Owner.findOne({ loginId: loginRegex }).lean(),

            // 2. Properties (needed to derive property IDs for rooms/tenants/rent)
            Property.find({ ownerLoginId: loginRegex, isDeleted: { $ne: true } })
                .select('_id title locationCode roomCount bedCount vacantRooms vacantBeds occupiedRooms occupiedBeds status isPublished')
                .lean(),

            // 3. Enquiries — limit to 100 newest for dashboard
            Enquiry.find({ ownerLoginId: loginRegex })
                .sort({ ts: -1 })
                .limit(100)
                .lean(),

            // 4. Notifications — limit to 50 newest
            Notification.find({ toLoginId: loginRegex })
                .sort({ createdAt: -1 })
                .limit(50)
                .lean(),

            // 5. Complaints — exact match (index hit), limit 50
            Complaint.find({ ownerLoginId: loginRegex })
                .sort({ createdAt: -1 })
                .limit(50)
                .lean(),

            // 6. PaymentTransactions for rent calculation
            PaymentTransaction.find({ owner_id: loginRegex })
                .select('owner_amount')
                .lean(),
        ]);

        const propertyIds = properties.map(p => p._id);

        // ── PHASE 3: Derive IDs then run remaining parallel fetches ───────────────
        const [rooms, tenants, ownerDoc2, rentPaymentsForOwner] = await Promise.all([
            // 7. Rooms for all owner properties — limit to 200 for dashboard
            Room.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } })
                .populate('property', 'title ownerLoginId')
                .limit(200)
                .lean(),

            // 8. Tenants for all owner properties or matching ownerLoginId
            Tenant.find({
                $or: [
                    { property: { $in: propertyIds } },
                    { ownerLoginId: loginRegex }
                ],
                isDeleted: { $ne: true }
            })
                .lean(),

            // RentPayments require owner _id — re-use ownerDoc if available
            ownerDoc ? Promise.resolve(ownerDoc) : Owner.findOne({ loginId: loginRegex }).lean(),

            // Also fetch complaint fallback via tenants
            Promise.resolve(null),
        ]);

        // RentPayments — need owner _id
        let rentPayments = [];
        const resolvedOwner = ownerDoc2 || ownerDoc;
        if (resolvedOwner?._id) {
            rentPayments = await RentPayment.find({ ownerId: resolvedOwner._id })
                .select('amount')
                .lean();
        }

        // ── PHASE 4: Derive computed values ───────────────────────────────────────
        const totalRent = sumRent(enquiries, transactions, rentPayments);

        // Fetch complaint fallback via tenant IDs (same logic as complaintController)
        // Only do this if there are tenant IDs — and skip if we already have enough complaints
        let allComplaints = complaints;
        if (tenants.length > 0 && complaints.length < 50) {
            const tenantIds = tenants.map(t => String(t._id));
            const fallbackComplaints = await Complaint.find({
                tenantId: { $in: tenantIds },
                $or: [{ ownerLoginId: { $exists: false } }, { ownerLoginId: '' }, { ownerLoginId: null }]
            })
                .sort({ createdAt: -1 })
                .limit(50)
                .lean();

            if (fallbackComplaints.length > 0) {
                const seen = new Set(complaints.map(c => String(c._id)));
                const extra = fallbackComplaints.filter(c => !seen.has(String(c._id)));
                allComplaints = [...complaints, ...extra].sort((a, b) =>
                    new Date(b.createdAt) - new Date(a.createdAt)
                );
            }
        }

        // Inbox chats — minimal fetch (last 20 room_ids for this owner)
        let chats = null;
        try {
            const ChatMessage = require('../models/ChatMessage');
            if (ChatMessage) {
                const loginVariants = [loginId, loginId.toLowerCase()];
                const recentMsgs = await ChatMessage.find({
                    $or: [
                        { room_id: { $in: loginVariants } },
                        { sender_login_id: { $in: loginVariants } }
                    ]
                })
                    .sort({ created_at: -1 })
                    .limit(200)
                    .lean();

                const summaryMap = new Map();
                for (const msg of recentMsgs) {
                    const sender = String(msg.sender_login_id || '').toUpperCase();
                    const receiver = String(msg.room_id || '').toUpperCase();
                    const isOutgoing = loginVariants.map(v => v.toUpperCase()).includes(sender);
                    const partnerId = isOutgoing ? receiver : sender;
                    if (!partnerId || partnerId === 'SYSTEM') continue;
                    if (!summaryMap.has(partnerId)) {
                        summaryMap.set(partnerId, {
                            participant_login_id: partnerId,
                            participant_name: (!isOutgoing && msg.sender_name) ? msg.sender_name : partnerId,
                            last_message: msg.message || '',
                            last_message_at: msg.created_at,
                            last_sender_login_id: sender,
                            unread_count: (!isOutgoing && !msg.is_read) ? 1 : 0
                        });
                    } else {
                        const existing = summaryMap.get(partnerId);
                        if (!isOutgoing && !msg.is_read) existing.unread_count += 1;
                    }
                }
                const conversations = Array.from(summaryMap.values()).slice(0, 20);
                chats = { count: conversations.length, conversations };
            }
        } catch (chatErr) {
            console.warn(`[dashboard] chat fetch skipped: ${chatErr.message}`);
            chats = { count: 0, conversations: [] };
        }

        // Property totals map for rooms
        const propertyTotals = {};
        for (const propId of propertyIds) {
            propertyTotals[propId.toString()] = rooms.filter(
                r => String(r.property?._id || r.property) === propId.toString()
            ).length;
        }

        console.timeEnd(labelId);

        return res.json({
            success: true,
            owner: resolvedOwner,
            properties,
            rooms,
            propertyTotals,
            tenants,
            rent: { totalRent },
            enquiries,
            notifications,
            chats,
            complaints: allComplaints,
        });
    } catch (err) {
        console.timeEnd(labelId);
        console.error(`[dashboard] Error for ${req.params.ownerId}:`, err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
