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
const VisitData           = require('../models/VisitData');

const ownerController = require('../controllers/ownercontroller');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');
const { applyPropertyScope, applyVisitScope, applyComplaintScope, applyBookingScope } = require('../utils/scopeHelpers');
const { MODULE_KEYS } = require('../utils/permissionKeys');
const { normalizeLoginId } = require('../utils/normalizeId');
const { sumPaymentTransactions, sumRentPayments } = require('../services/paymentTotalsService');
const { withReadDeadline } = require('../utils/queryDeadline');
const { fetchOwnerBookingLeads } = require('../services/ownerLeads');
const { TENANT_LIST_LITE_EXCLUDE, OWNER_DASHBOARD_EXCLUDE } = require('../utils/listProjections');

// GET /:ownerId below is the Owner Dashboard's data source and is Owner/Admin-only
// by requirement — staff have their own separate /employee endpoint above with
// area-scoped stats and no revenue. This route is called unauthenticated by design
// (resolves the owner from the URL), so we can't just gate it behind `protect`;
// instead decode the Bearer token if present and reject outright when it belongs
// to an Employee (any staff role), regardless of that staff member's permissions.
async function isStaffRequest(req) {
    try {
        // Staff-panel guard: if protect() already resolved a staff identity,
        // block straight away without re-verifying the token.
        if (req.user) {
            if (['employee', 'manager', 'staff'].includes(req.user.role) || req.user.isStaff) return true;
        }
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) return false;
        const jwt = require('jsonwebtoken');
        if (!process.env.JWT_SECRET) return false;
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        const Employee = require('../models/Employee');
        const emp = await Employee.findById(decoded.id).select('_id').lean();
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

/**
 * Rent total = accepted/approved/active enquiry deposits
 *            + online booking payouts to the owner (PaymentTransaction)
 *            + manually recorded rent payments (RentPayment)
 *
 * `enquiries` is summed in JS on purpose: those documents are already fetched
 * for the dashboard response (capped at the 100 newest), and this total has
 * always been scoped to that same capped set. Summing them server-side over
 * every enquiry would silently change the figure the dashboard reports.
 *
 * The two money totals arrive pre-aggregated from MongoDB — see
 * sumPaymentTransactions/sumRentPayments below.
 */
function sumRent(enquiries, txTotal, rentPaymentsTotal) {
    const enquiriesTotal = enquiries
        .filter(e => ['accepted', 'approved', 'active'].includes(String(e.status || '').toLowerCase()))
        .reduce((sum, e) => sum + (e.paidAmount || 0), 0);

    return enquiriesTotal + txTotal + rentPaymentsTotal;
}

router.get('/:ownerId', protect, authorize('owner', 'superadmin'), async (req, res) => {
    if (await isStaffRequest(req)) {
        return res.status(403).json({ success: false, message: 'Forbidden: the Owner Dashboard is not available to staff accounts' });
    }

    const labelId = `dashboard:${req.params.ownerId}:${Date.now()}`;
    // Per-request timing only when debugging — otherwise one log line per
    // dashboard load per owner.
    const timeLogs = process.env.DEBUG_REQUESTS === 'true';
    if (timeLogs) console.time(labelId);

    try {
        const loginId = normalizeLoginId(String(req.params.ownerId || ''));
        if (!loginId) {
            return res.status(400).json({ success: false, message: 'ownerId is required' });
        }
        // Optional property scope — same query-param contract as the other
        // owner-scoped endpoints (complaints, rooms, tenants).
        const propertyId = req.query.propertyId && req.query.propertyId !== 'all'
            ? String(req.query.propertyId)
            : null;

        // ── PHASE 1: (removed) ────────────────────────────────────────────────────
        // Owner↔property link repair used to be fired from here. Even
        // fire-and-forget it competed with this request's own queries for the
        // connection pool and the event loop. It now runs in the scheduled job
        // (jobs/ownerPropertyHealJob.js), off the request path entirely.

        // ── PHASE 2: Parallel fetches ─────────────────────────────────────────────
        // `loginId` is already normalized (trim + uppercase) above, which is the
        // canonical form every identifier is generated in. Matching by equality
        // lets each query use its existing index — the previous
        // `new RegExp('^' + loginId + '$', 'i')` could not, because a
        // case-insensitive regex is never index-eligible, so all six queries
        // below ran as full collection scans.
        const [
            ownerDoc,
            properties,
            enquiries,
            notifications,
            complaints,
            txTotal,
            websiteLeads,
        ] = await Promise.all([
            // 1. Owner details (lean, no populate needed for dashboard). KYC scans
            //    excluded — admin.jsx (the only consumer) never renders them.
            withReadDeadline(Owner.findOne({ loginId }).select(OWNER_DASHBOARD_EXCLUDE)).lean(),

            // 2. Properties (needed to derive property IDs for rooms/tenants/rent)
            withReadDeadline(Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } })
                .select('_id title locationCode roomCount bedCount vacantRooms vacantBeds occupiedRooms occupiedBeds status isPublished'))
                .lean(),

            // 3. Enquiries — limit to 100 newest for dashboard.
            //    Panel-created leads only; website bookings are collected
            //    separately below, since they live in BookingRequest.
            withReadDeadline(Enquiry.find({ ownerLoginId: loginId, ...(propertyId ? { propertyId } : {}) })
                .sort({ ts: -1 })
                .limit(100))
                .lean(),

            // 4. Notifications — limit to 50 newest
            withReadDeadline(Notification.find({ toLoginId: loginId })
                .sort({ createdAt: -1 })
                .limit(50))
                .lean(),

            // 5. Complaints — exact match (index hit), limit 50
            withReadDeadline(Complaint.find({ ownerLoginId: loginId, ...(propertyId ? { propertyId } : {}) })
                .sort({ createdAt: -1 })
                .limit(50))
                .lean(),

            // 6. PaymentTransaction total — summed in MongoDB. Only the scalar
            //    crosses the wire; the documents themselves were never used.
            sumPaymentTransactions({ owner_id: loginId, ...(propertyId ? { property_id: propertyId } : {}) }),

            // 7. Website leads — direct bookings and bids, which live in
            //    BookingRequest rather than Enquiry. Without these the dashboard's
            //    Recent Leads stayed empty no matter how many bookings came in
            //    from the site. Returned as their own field, never merged into
            //    `enquiries`: that array feeds sumRent(), and folding booking
            //    amounts into it would silently move the reported rent total.
            fetchOwnerBookingLeads({
                ownerIdCandidates: [...new Set([loginId, String(req.params.ownerId || '')].filter(Boolean))],
                normalizedOwnerId: loginId,
                propertyId,
                limit: 100,
                wrap: withReadDeadline,
            }).catch(() => []),
        ]);

        // Scope to the single selected property when provided (still validated
        // against this owner's own properties list, never trusts the query param
        // directly).
        const scopedProperties = propertyId
            ? properties.filter(p => String(p._id) === propertyId)
            : properties;
        const propertyIds = scopedProperties.map(p => p._id);

        // ── PHASE 3: Derive IDs then run remaining parallel fetches ───────────────
        const [rooms, tenants, ownerDoc2, rentPaymentsForOwner] = await Promise.all([
            // 7. Rooms for all owner properties — limit to 200 for dashboard
            withReadDeadline(Room.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } })
                .populate('property', 'title ownerLoginId')
                .limit(200))
                .lean(),

            // 8. Tenants for all owner properties or matching ownerLoginId.
            //    Image blobs dropped: the dashboard reads rent/moveIn/property only.
            withReadDeadline(Tenant.find({
                $or: [
                    { property: { $in: propertyIds } },
                    { ownerLoginId: loginId }
                ],
                isDeleted: { $ne: true }
            }).select(TENANT_LIST_LITE_EXCLUDE))
                .lean(),

            // RentPayments require owner _id — re-use ownerDoc if available
            ownerDoc ? Promise.resolve(ownerDoc) : Owner.findOne({ loginId }).select(OWNER_DASHBOARD_EXCLUDE).lean(),

            // Also fetch complaint fallback via tenants
            Promise.resolve(null),
        ]);

        // RentPayment total — needs the owner _id, so it runs after Phase 3.
        // Summed in MongoDB for the same reason as the transactions above.
        let rentPaymentsTotal = 0;
        const resolvedOwner = ownerDoc2 || ownerDoc;
        // Defense in depth: this object is serialized straight into the dashboard
        // response below — never let a raw password reach the client.
        if (resolvedOwner) {
            if (resolvedOwner.credentials) delete resolvedOwner.credentials.password;
            delete resolvedOwner.checkinPassword;
            delete resolvedOwner.password;
        }
        if (resolvedOwner?._id) {
            rentPaymentsTotal = await sumRentPayments({
                ownerId: resolvedOwner._id,
                ...(propertyId ? { propertyId } : {}),
            });
        }

        // ── PHASE 4: Derive computed values ───────────────────────────────────────
        const totalRent = sumRent(enquiries, txTotal, rentPaymentsTotal);

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
                    // Only the fields the summary below reads.
                    .select('room_id sender_login_id sender_name message created_at is_read')
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

        if (timeLogs) console.timeEnd(labelId);

        return res.json({
            success: true,
            owner: resolvedOwner,
            properties,
            rooms,
            propertyTotals,
            tenants,
            rent: { totalRent },
            enquiries,
            websiteLeads,
            notifications,
            chats,
            complaints: allComplaints,
        });
    } catch (err) {
        if (timeLogs) console.timeEnd(labelId);
        console.error(`[dashboard] Error for ${req.params.ownerId}:`, err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
