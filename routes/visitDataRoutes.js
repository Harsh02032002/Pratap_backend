const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const VisitData = require('../models/VisitData');
const User = require('../models/user');
const Owner = require('../models/Owner');
const CheckinRecord = require('../models/CheckinRecord');
const Property = require('../models/Property');
const mailer = require('../utils/mailer');
const { notifySuperadmin } = require('../utils/superadminNotifier');
const { protect, authorize } = require('../middleware/authMiddleware');
const { clearCache } = require('../middleware/apiCache');
const VISITS_QUERY_TIMEOUT_MS = 12000;
const VISITS_CACHE_TTL_MS = 10000;
const visitsListCache = new Map();
const visitsListInFlight = new Map();

const APP_URL = process.env.APP_URL || process.env.APP_BASE_URL || process.env.WEB_APP_URL || 'https://app.roomhy.com';
const DIGITAL_CHECKIN_URL = process.env.DIGITAL_CHECKIN_URL || process.env.FRONTEND_URL || 'https://admin.roomhy.com';

// Helper function to convert string to boolean
function stringToBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        return value.toLowerCase() === 'yes';
    }
    return false;
}

function toNonNegativeInt(value) {
    return Math.max(0, parseInt(value, 10) || 0);
}

function normalizeOccupancyFields(source = {}) {
    const vacantRooms = toNonNegativeInt(source.vacantRooms);
    const vacantBeds = toNonNegativeInt(source.vacantBeds);
    const occupiedRooms = toNonNegativeInt(source.occupiedRooms);
    const occupiedBeds = toNonNegativeInt(source.occupiedBeds ?? source.bedCount);
    return {
        vacantRooms,
        vacantBeds,
        occupiedRooms,
        occupiedBeds,
        roomCount: vacantRooms + occupiedRooms,
        bedCount: vacantBeds + occupiedBeds
    };
}

function hasVacancy(source = {}) {
    return toNonNegativeInt(source.vacantRooms) > 0;
}

function uniqueTruthy(values = []) {
    return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

// Owner login ID format: ROOMHY + 4 digits (e.g., ROOMHY1234)
const OWNER_LOGIN_ID_REGEX = /^ROOMHY\d{4}$/i;

function buildOwnerLoginId() {
    const n = Math.floor(Math.random() * 10000); // 0-9999
    return `ROOMHY${String(n).padStart(4, '0')}`;
}

function normalizeOwnerLoginId(raw) {
    const id = (raw || '').toString().trim().toUpperCase();
    if (!OWNER_LOGIN_ID_REGEX.test(id)) return '';
    return id;
}

async function isOwnerLoginIdTaken(loginId) {
    const id = (loginId || '').toString().trim().toUpperCase();
    if (!id) return true;

    const [owner, user, visit] = await Promise.all([
        Owner.findOne({ loginId: id }).select('_id').lean(),
        User.findOne({ loginId: id }).select('_id').lean(),
        VisitData.findOne({ 'generatedCredentials.loginId': id }).select('_id').lean()
    ]);

    return !!(owner || user || visit);
}

async function generateUniqueOwnerLoginId(maxAttempts = 100) {
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = buildOwnerLoginId();
        // eslint-disable-next-line no-await-in-loop
        const taken = await isOwnerLoginIdTaken(candidate);
        if (!taken) return candidate;
    }
    throw new Error('Unable to generate unique owner login ID');
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve the owner login ID for a visit.
//
// Once a KYC link has been sent, an Owner record exists under that login ID and
// every piece of KYC the owner submits is attached to it. isOwnerLoginIdTaken()
// would then report that ID as "taken" (by this very visit) and callers used to
// mint a brand new ID — creating a second, empty Owner and orphaning the KYC the
// owner had just completed. Always reuse the ID already issued to this visit.
async function resolveVisitOwnerLoginId(visit, requestedLoginId) {
    const alreadyIssued = normalizeOwnerLoginId(visit?.generatedCredentials?.loginId);
    if (alreadyIssued) return alreadyIssued;

    const requested = normalizeOwnerLoginId(requestedLoginId);
    if (requested && !(await isOwnerLoginIdTaken(requested))) return requested;

    return generateUniqueOwnerLoginId();
}

// True when the owner behind this login ID has finished digital KYC.
// Owner stores KYC as `kyc.status` and `checkinAadhaarNumber` (see models/Owner.js) —
// there is no top-level `aadhaarNumber`/`kycStatus`, so those must not be checked.
function isOwnerKycComplete(owner) {
    if (!owner) return false;
    const status = String(owner?.kyc?.status || '').toLowerCase();
    return !!(
        owner?.checkinAadhaarNumber ||
        owner?.kyc?.aadharNumber ||
        status === 'verified' ||
        status === 'completed'
    );
}

// Reconcile VisitData.kycStatus with the owner's actual digital check-in progress.
// The owner completes KYC on the digital-checkin pages, which write to Owner — nothing
// there calls back into VisitData, so the visit's own kycStatus goes stale. Every read
// path that surfaces or acts on kycStatus must run this first, otherwise the superadmin
// Approve button stays disabled after the owner has already finished.
// Mutates the passed (lean) visit objects in place and persists any change.
async function syncVisitKycStatus(visits = []) {
    const pending = visits.filter(
        v => v && v.kycStatus !== 'completed' && v.generatedCredentials?.loginId
    );
    if (pending.length === 0) return visits;

    await Promise.all(pending.map(async (v) => {
        try {
            const owner = await Owner.findOne({ loginId: v.generatedCredentials.loginId })
                .select('kyc checkinAadhaarNumber')
                .lean();
            if (isOwnerKycComplete(owner)) {
                await VisitData.updateOne(
                    { visitId: v.visitId },
                    { kycStatus: 'completed', kycCompletedAt: new Date() }
                );
                v.kycStatus = 'completed';
            }
        } catch (err) {
            console.warn('[syncVisitKycStatus] failed for visit', v.visitId, err.message);
        }
    }));

    return visits;
}

// Issue owner credentials + email the digital-KYC link for a visit.
// Shared by the automatic send on visit submission and the manual resend endpoint.
async function sendOwnerKycLink(visit) {
    const ownerEmail = visit.ownerEmail || '';
    if (!ownerEmail) {
        const err = new Error('No owner email found on this visit');
        err.statusCode = 400;
        throw err;
    }

    const loginId = await resolveVisitOwnerLoginId(visit);
    // Keep the password already issued to this visit so a resend does not
    // invalidate credentials the owner may have started using.
    const tempPassword = visit.generatedCredentials?.tempPassword || Math.random().toString(36).slice(-8);

    const ownerName = visit.ownerName || 'Owner';
    const ownerPhone = visit.ownerPhone || visit.contactPhone || '';
    const ownerArea = visit.area || '';
    const propertyLocationCode = String(ownerArea || visit.city || loginId).trim().toUpperCase();
    const occupancy = normalizeOccupancyFields(visit);

    // Create/update Owner record so the digital-checkin page can look it up
    await Owner.findOneAndUpdate(
        { loginId },
        {
            $set: {
                loginId,
                name: ownerName,
                email: ownerEmail,
                phone: ownerPhone,
                area: ownerArea,
                locationCode: propertyLocationCode,
                profile: { name: ownerName, email: ownerEmail, phone: ownerPhone, locationCode: propertyLocationCode, updatedAt: new Date() },
                ...occupancy,
                credentials: { password: tempPassword, firstTime: true },
                checkinPassword: tempPassword,
                isActive: true
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await VisitData.findOneAndUpdate(
        { visitId: visit.visitId },
        {
            kycStatus: 'sent',
            kycSentAt: new Date(),
            ownerLoginId: loginId,
            generatedCredentials: { loginId, tempPassword }
        }
    );

    const kycLink = `${DIGITAL_CHECKIN_URL}/digital-checkin/ownerprofile?loginId=${encodeURIComponent(loginId)}&email=${encodeURIComponent(ownerEmail)}&area=${encodeURIComponent(ownerArea)}&password=${encodeURIComponent(tempPassword)}`;

    await mailer.sendKycLinkEmail(ownerEmail, ownerName, visit.propertyName || 'Property', kycLink);

    console.log(`[sendOwnerKycLink] KYC link sent to ${ownerEmail} for visit ${visit.visitId}, loginId: ${loginId}`);
    return { loginId, tempPassword };
}

async function resolveRequestUser(req) {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) return null;
        const token = authHeader.slice(7).trim();
        if (!token) return null;
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        
        if (decoded?.id) {
            const user = await User.findById(decoded.id).select('role loginId name').lean();
            if (user) return user;

            const Employee = require('../models/Employee');
            const emp = await Employee.findById(decoded.id).select('role loginId employeeId name').lean();
            if (emp) {
                return {
                    role: emp.role || 'employee',
                    loginId: emp.employeeId || emp.loginId || emp.name,
                    name: emp.name
                };
            }
        }
        if (decoded?.role) {
            return { role: decoded.role, loginId: decoded.loginId || decoded.employeeId || '' };
        }
        return null;
    } catch (_) {
        return null;
    }
}

// ============================================================
// POST: Save visit data (used by visit.html)
// ============================================================
router.post('/', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const visitData = req.body;
        console.log('?? [visits/POST] Received data visitId:', visitData._id || visitData.visitId);

        // Process the data to handle type conversions
        const processedData = { ...visitData };
        
        // Remove _id if present (MongoDB will generate it)
        delete processedData._id;

        // Convert boolean fields from strings to booleans
        processedData.visitorsAllowed = stringToBoolean(processedData.visitorsAllowed);
        processedData.cookingAllowed = stringToBoolean(processedData.cookingAllowed);
        processedData.smokingAllowed = stringToBoolean(processedData.smokingAllowed);
        processedData.petsAllowed = stringToBoolean(processedData.petsAllowed);
        Object.assign(processedData, normalizeOccupancyFields(processedData));

        // Generate visitId if not provided
        // Use _id from frontend as visitId (it comes as _id from visit.html)
        const visitId = processedData.visitId || visitData._id || ('v_' + Date.now());

        // Create new visit document - let MongoDB generate _id, use visitId for consistency
        const newVisit = new VisitData({
            ...processedData,
            visitId: visitId,  // Use visitId as custom field (not _id)
            submittedAt: new Date(),
            status: processedData.status || 'submitted'
        });

        console.log('?? [visits/POST] Saving visit with visitId:', visitId);
        console.log('?? [visits/POST] Visit fields:', Object.keys(newVisit.toObject()).slice(0, 10).join(', '));
        await newVisit.save();

        try {
            await notifySuperadmin({
                type: 'new_enquiry',
                from: 'area_manager',
                subject: `New Visit Enquiry - ${newVisit.propertyName || 'Property'}`,
                message: 'A new visit enquiry was submitted and is pending review.',
                meta: {
                    enquiryId: newVisit.visitId || String(newVisit._id || ''),
                    userName: newVisit.ownerName || newVisit.visitorName || '',
                    userEmail: newVisit.ownerEmail || newVisit.visitorEmail || '',
                    propertyName: newVisit.propertyName || '',
                    city: newVisit.city || '',
                    area: newVisit.area || ''
                }
            });
        } catch (notifyErr) {
            console.warn('visit create notification failed:', notifyErr.message);
        }

        console.log('? [visits/POST] Visit saved to MongoDB:', newVisit._id, 'visitId:', visitId);

        res.status(201).json({
            success: true,
            message: 'Visit saved successfully',
            visit: newVisit
        });

    } catch (error) {
        console.error('? [visits/POST] Error saving visit:', error.message);
        console.error('? [visits/POST] Error stack:', error.stack);
        
        // Check for duplicate visitId error
        if (error.code === 11000) {
            console.error('? [visits/POST] Duplicate key error. Field:', Object.keys(error.keyValue || {}));
            return res.status(409).json({
                success: false,
                message: 'Visit with this ID already exists',
                error: 'Duplicate visitId'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Error saving visit',
            error: error.message
        });
    }
});

// ============================================================
// GET: Root endpoint - returns all visits (alias for /all)
// Used by Area Manager / Employee dashboard
// Supports optional ?staffId / ?staffName parameters to filter by staff
// ============================================================
router.get('/', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const requester = await resolveRequestUser(req);
        const requestedStaffId = String(req.query.staffId || '').trim();
        const requestedStaffName = (req.query.staffName || '').toString().trim();

        // Employees should only see their own visit reports.
        const isEmployee = requester?.role === 'employee' || requester?.role === 'staff' || requester?.role === 'areamanager';
        const enforcedStaffId = isEmployee
            ? String(requester?.loginId || requestedStaffId || '').trim()
            : requestedStaffId;

        const staffId = enforcedStaffId;
        const staffName = isEmployee ? (requester?.name || requestedStaffName) : (staffId ? '' : requestedStaffName);
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
        const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);

        const cacheKey = JSON.stringify({ staffId, staffName, limit, skip });

        let query = {};
        let usesCaseInsensitiveMatch = false;
        if (staffId || staffName) {
            const or = [];
            if (staffId) {
                const idValues = uniqueTruthy([
                    staffId,
                    String(staffId).toUpperCase(),
                    String(staffId).toLowerCase()
                ]);
                or.push(
                    { staffId: { $in: idValues } },
                    { submittedById: { $in: idValues } },
                    { submittedByLoginId: { $in: idValues } },
                    { ownerLoginId: { $in: idValues } }
                );
            }
            if (staffName) {
                usesCaseInsensitiveMatch = true;
                const nameRegex = new RegExp(`^${escapeRegex(staffName)}$`, 'i');
                or.push(
                    { staffName: nameRegex },
                    { submittedBy: nameRegex }
                );
            }
            query = or.length ? { $or: or } : {};
            console.log('[visits/GET] Fetching visits for staff filter:', {
                staffId,
                staffName,
                enforcedByRole: isEmployee
            });
        } else {
            console.log('[visits/GET] Fetching all visits');
        }

        const fetchVisits = async () => {
            const visitsQuery = VisitData.find(query)
                .sort({ submittedAt: -1 })
                .limit(limit)
                .skip(skip)
                .maxTimeMS(VISITS_QUERY_TIMEOUT_MS)
                .lean();

            const countQuery = VisitData.countDocuments(query).maxTimeMS(VISITS_QUERY_TIMEOUT_MS);

            if (usesCaseInsensitiveMatch) {
                const collation = { locale: 'en', strength: 2 };
                visitsQuery.collation(collation);
                countQuery.collation(collation);
            }

            const [visits, totalCount] = await Promise.all([visitsQuery, countQuery]);

            // Refresh kycStatus from the owners' digital check-in progress so the
            // superadmin Approve button reflects reality on this list.
            await syncVisitKycStatus(visits);

            console.log(`? [visits/GET] Returning ${visits.length} visits from ${totalCount} total (limit: ${limit}, skip: ${skip})`);
            return {
                success: true,
                count: totalCount,
                returned: visits.length,
                visits
            };
        };

        let requestPromise = visitsListInFlight.get(cacheKey);
        if (!requestPromise) {
            requestPromise = fetchVisits();
            visitsListInFlight.set(cacheKey, requestPromise);
        }

        const payload = await requestPromise;
        visitsListInFlight.delete(cacheKey);
        visitsListCache.set(cacheKey, { timestamp: Date.now(), payload });
        res.json(payload);
    } catch (error) {
        console.error('Error fetching visits:', error);
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
        const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
        const cacheKey = JSON.stringify({
            staffId: String(req.query.staffId || '').trim(),
            staffName: (req.query.staffName || '').toString().trim(),
            limit,
            skip
        });
        visitsListInFlight.delete(cacheKey);
        const stale = visitsListCache.get(cacheKey);
        if (stale?.payload) {
            return res.status(200).json({
                ...stale.payload,
                stale: true
            });
        }
        res.status(200).json({
            success: false,
            message: error?.message?.includes('maxTimeMS') ? 'Visits query exceeded database time limit' : 'Error fetching visits',
            error: error.message,
            count: 0,
            visits: []
        });
    }
});

// ============================================================
// GET: Pending visits (for superadmin enquiry)
// ============================================================
router.get('/pending', protect, authorize('superadmin'), async (req, res) => {
    try {
        const visits = await VisitData.find({
            status: { $in: ['submitted', 'pending_review'] }
        }).sort({ submittedAt: -1 }).lean();

        // Auto-sync kycStatus from the owners' digital check-in progress
        await syncVisitKycStatus(visits);

        console.log(`[visits/pending] Returning ${visits.length} pending visits`);
        res.json({ success: true, count: visits.length, visits });
    } catch (error) {
        console.error('Error fetching pending visits:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching pending visits',
            error: error.message
        });
    }
});

// ============================================================
// POST: Approve a visit
// ============================================================
router.post('/approve', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const { visitId, status, isLiveOnWebsite, loginId, tempPassword } = req.body;
        console.log('?? [visits/approve] Received request:', { visitId, status, isLiveOnWebsite });

        if (!visitId) {
            console.error('? [visits/approve] Missing visitId in request body');
            return res.status(400).json({
                success: false,
                message: 'Missing visitId'
            });
        }

        // KYC must be completed before approval.
        // KYC is done via /digital-checkin/ownerprofile, which writes to the Owner record;
        // syncVisitKycStatus reconciles that back onto this visit.
        const visitForKycCheck = await VisitData.findOne({ visitId })
            .select('visitId kycStatus generatedCredentials').lean();
        await syncVisitKycStatus([visitForKycCheck].filter(Boolean));
        const kycCompleted = visitForKycCheck?.kycStatus === 'completed';

        if (!kycCompleted) {
            return res.status(400).json({
                success: false,
                message: 'Cannot approve. Owner KYC must be completed first. Send the KYC link to the owner.'
            });
        }

        // Reuse the login ID already issued to this visit — the owner's completed KYC
        // is attached to that Owner record. Minting a new one here would publish the
        // property under an empty Owner and strand the KYC that just unblocked approval.
        const finalLoginId = await resolveVisitOwnerLoginId(visitForKycCheck, loginId);
        const finalPassword =
            tempPassword ||
            visitForKycCheck?.generatedCredentials?.tempPassword ||
            Math.random().toString(36).slice(-8);

        console.log('?? [visits/approve] Finding visit by visitId:', visitId);
        
        // Build query - check if visitId is a valid MongoDB ObjectId or a timestamp-based ID
        const mongoose = require('mongoose');
        let query;
        if (mongoose.Types.ObjectId.isValid(visitId) && visitId.match(/^[0-9a-fA-F]{24}$/)) {
            // It's a valid ObjectId
            query = { $or: [{ _id: visitId }, { visitId: visitId }] };
        } else {
            // It's a timestamp-based ID like v_1234567890, search by visitId field only
            query = { visitId: visitId };
        }
        
        // Find and update visit status to approved
        const visit = await VisitData.findOneAndUpdate(
            query,
            {
                status: status || 'approved',
                approvedAt: new Date(),
                isLiveOnWebsite: isLiveOnWebsite !== undefined ? isLiveOnWebsite : false,
                generatedCredentials: {
                    loginId: finalLoginId,
                    tempPassword: finalPassword
                }
            },
            { new: true }
        );

        if (!visit) {
            console.error('? [visits/approve] Visit not found:', visitId);
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        console.log('? [visits/approve] Visit found and updated:', visit._id);

        const ownerName =
            visit.ownerName ||
            (visit.propertyInfo && visit.propertyInfo.ownerName) ||
            'Owner';
        const ownerEmailFromVisit =
            visit.ownerEmail ||
            (visit.propertyInfo && (visit.propertyInfo.ownerEmail || visit.propertyInfo.ownerGmail)) ||
            '';
        const ownerPhone =
            visit.ownerPhone ||
            visit.contactPhone ||
            (visit.propertyInfo && visit.propertyInfo.contactPhone) ||
            '';
        const ownerAddress =
            visit.address ||
            (visit.propertyInfo && visit.propertyInfo.address) ||
            '';
        const ownerArea =
            visit.area ||
            (visit.propertyInfo && visit.propertyInfo.area) ||
            '';
        const propertyTitle =
            visit.propertyName ||
            (visit.propertyInfo && visit.propertyInfo.name) ||
            'Property';
        const propertyAddress =
            visit.address ||
            (visit.propertyInfo && visit.propertyInfo.address) ||
            '';
        const propertyLocationCode = String(
            visit.locationCode ||
            (visit.propertyInfo && visit.propertyInfo.locationCode) ||
            ownerArea ||
            visit.city ||
            finalLoginId
        ).trim().toUpperCase();
        const occupancy = normalizeOccupancyFields(visit);
        const propertyHasVacancy = hasVacancy(occupancy);

        await Owner.findOneAndUpdate(
            { loginId: finalLoginId },
            {
                $set: {
                    loginId: finalLoginId,
                    name: ownerName,
                    email: ownerEmailFromVisit,
                    phone: ownerPhone,
                    address: ownerAddress,
                    locationCode: propertyLocationCode,
                    area: ownerArea,
                    profile: {
                        name: ownerName,
                        email: ownerEmailFromVisit,
                        phone: ownerPhone,
                        address: ownerAddress,
                        locationCode: propertyLocationCode,
                        updatedAt: new Date()
                    },
                    ...occupancy,
                    credentials: {
                        password: finalPassword,
                        firstTime: true
                    },
                    checkinPassword: finalPassword,
                    isActive: true
                },
                $setOnInsert: {
                    createdAt: new Date()
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        let ownerProperty = await Property.findOne({
            ownerLoginId: finalLoginId,
            title: { $regex: `^${escapeRegex(propertyTitle)}$`, $options: 'i' }
        });

        if (!ownerProperty) {
            ownerProperty = await Property.create({
                title: propertyTitle,
                description: visit.description || '',
                address: propertyAddress,
                city: visit.city || '',
                area: ownerArea || '',
                propertyType: visit.propertyType || '',
                monthlyRent: Number(visit.monthlyRent || 0),
                ...occupancy,
                ownerName,
                ownerEmail: ownerEmailFromVisit,
                ownerPhone,
                locationCode: propertyLocationCode || 'GEN',
                ownerLoginId: finalLoginId,
                status: 'active',
                isPublished: propertyHasVacancy,
                roomTypes: visit.roomTypes || []
            });
        } else {
            ownerProperty.description = visit.description || ownerProperty.description || '';
            ownerProperty.address = propertyAddress || ownerProperty.address || '';
            ownerProperty.city = visit.city || ownerProperty.city || '';
            ownerProperty.area = ownerArea || ownerProperty.area || '';
            ownerProperty.propertyType = visit.propertyType || ownerProperty.propertyType || '';
            ownerProperty.monthlyRent = Number(visit.monthlyRent || ownerProperty.monthlyRent || 0);
            ownerProperty.roomCount = occupancy.roomCount || ownerProperty.roomCount || 0;
            ownerProperty.bedCount = occupancy.bedCount || ownerProperty.bedCount || 0;
            ownerProperty.vacantRooms = occupancy.vacantRooms;
            ownerProperty.occupiedRooms = occupancy.occupiedRooms;
            ownerProperty.occupiedBeds = occupancy.occupiedBeds;
            ownerProperty.ownerName = ownerName || ownerProperty.ownerName || '';
            ownerProperty.ownerEmail = ownerEmailFromVisit || ownerProperty.ownerEmail || '';
            ownerProperty.ownerPhone = ownerPhone || ownerProperty.ownerPhone || '';
            ownerProperty.locationCode = propertyLocationCode || ownerProperty.locationCode || 'GEN';
            ownerProperty.ownerLoginId = finalLoginId;
            ownerProperty.status = 'active';
            ownerProperty.isPublished = propertyHasVacancy;
            if (visit.roomTypes && visit.roomTypes.length > 0) {
                ownerProperty.roomTypes = visit.roomTypes;
            }
            await ownerProperty.save();
        }

        // Always save/update approved visit to ApprovedProperty collection
        try {
            const ApprovedProperty = require('../models/ApprovedProperty');
            const propData = {
                visitId: visit._id || visit.visitId,
                propertyInfo: {
                    name: visit.propertyName || (visit.propertyInfo && visit.propertyInfo.name) || 'Property',
                    address: visit.address || (visit.propertyInfo && visit.propertyInfo.address) || '',
                    city: visit.city || (visit.propertyInfo && visit.propertyInfo.city) || '',
                    area: visit.area || (visit.propertyInfo && visit.propertyInfo.area) || '',
                    locationCode: propertyLocationCode,
                    photos: visit.photos || (visit.propertyInfo && visit.propertyInfo.photos) || [],
                    ownerName: visit.ownerName || (visit.propertyInfo && visit.propertyInfo.ownerName) || '',
                    ownerPhone: visit.ownerPhone || visit.contactPhone || (visit.propertyInfo && visit.propertyInfo.contactPhone) || '',
                    ownerEmail: visit.ownerEmail || (visit.propertyInfo && visit.propertyInfo.ownerEmail) || '',
                    ownerLoginId: finalLoginId,
                    rent: visit.monthlyRent || 0,
                    deposit: visit.deposit || '',
                    ...occupancy,
                    description: visit.description || '',
                    amenities: visit.amenities || [],
                    genderSuitability: visit.gender || (visit.propertyInfo && visit.propertyInfo.genderSuitability) || '',
                    propertyType: visit.propertyType || (visit.propertyInfo && visit.propertyInfo.propertyType) || ''
                },
                roomTypes: visit.roomTypes || [],
                professionalPhotos: visit.professionalPhotos || [],
                generatedCredentials: {
                    loginId: finalLoginId,
                    tempPassword: finalPassword
                },
                propertyRef: ownerProperty._id,
                isLiveOnWebsite: propertyHasVacancy ? Boolean(isLiveOnWebsite) : false,
                status: propertyHasVacancy && isLiveOnWebsite ? 'live' : 'approved',
                approvedAt: new Date(),
                submittedAt: visit.submittedAt || new Date(),
                approvedBy: 'superadmin'
            };
            
            const approvedProp = await ApprovedProperty.findOneAndUpdate(
                { visitId: visit._id || visit.visitId },
                propData,
                { upsert: true, new: true }
            );
            console.log('? [visits/approve] Saved to ApprovedProperty collection:', approvedProp._id);

            // Clear cached listings so the new property shows up immediately
            clearCache('/api/approved-properties');
            clearCache('/api/properties');
        } catch (approvedErr) {
            console.warn('?? [visits/approve] Warning saving to ApprovedProperty:', approvedErr.message);
            // Don't fail the approval if ApprovedProperty save fails
        }

        console.log('? [visits/approve] Visit approved successfully:', visitId);

        // Send owner credentials email with owner login page and digital KYC links.
        let emailAttempted = false;
        let emailSent = false;
        try {
            const ownerFromDb = await Owner.findOne({ loginId: finalLoginId })
                .select('email profile.email')
                .lean();
            const checkinRecord = await CheckinRecord.findOne({ loginId: finalLoginId, role: 'owner' })
                .select('ownerProfile.email')
                .lean();
            const ownerEmail =
                ownerEmailFromVisit ||
                (ownerFromDb && (ownerFromDb.email || (ownerFromDb.profile && ownerFromDb.profile.email))) ||
                (checkinRecord && checkinRecord.ownerProfile && checkinRecord.ownerProfile.email) ||
                '';

            if (ownerEmail) {
                emailAttempted = true;
                const loginPageLink = `${APP_URL}/propertyowner/ownerlogin`;
                const subject = 'Welcome to RoomHy - Your Property is Approved!';
                const text = `Welcome to RoomHy!\n\nDear ${ownerName},\n\nYour property has been approved.\n\nProperty: ${propertyTitle}\nLogin ID: ${finalLoginId}\nTemporary Password: ${finalPassword}\n\nOwner Login Page: ${loginPageLink}\n\nPlease change your password after first login.\n\nRoomHy Team`;
                const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  body{margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f0f2f5;}
  .wrap{max-width:520px;margin:40px auto;padding:20px;}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.1);overflow:hidden;}
  .hdr{background:linear-gradient(135deg,#667eea,#764ba2);padding:30px;text-align:center;}
  .hdr h1{margin:0;color:#fff;font-size:26px;font-weight:700;}
  .hdr p{margin:8px 0 0;color:rgba(255,255,255,.85);font-size:13px;}
  .body{padding:30px;color:#333;}
  .cred{background:#f5f7fa;border-left:4px solid #667eea;border-radius:10px;padding:20px;margin:20px 0;}
  .lbl{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}
  .val{color:#222;font-size:18px;font-weight:700;background:#fff;padding:8px 14px;border-radius:6px;display:inline-block;}
  .btn{display:block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-align:center;padding:14px;text-decoration:none;border-radius:10px;margin:24px 0;font-size:15px;font-weight:600;}
  .warn{background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:14px;font-size:13px;color:#856404;margin-top:16px;}
  .foot{background:#f8f9fa;padding:16px;text-align:center;border-top:1px solid #eee;}
  .foot p{margin:0;color:#999;font-size:12px;}
</style></head>
<body>
  <div class="wrap"><div class="card">
    <div class="hdr"><h1>RoomHy</h1><p>Your Property is Approved!</p></div>
    <div class="body">
      <p>Dear <strong>${ownerName}</strong>,</p>
      <p>Congratulations! Your property <strong>${propertyTitle}</strong> has been approved and added to your owner account.</p>
      <div class="cred">
        <div style="margin-bottom:14px;"><div class="lbl">Login ID</div><div class="val">${finalLoginId}</div></div>
        <div><div class="lbl">Temporary Password</div><div class="val">${finalPassword}</div></div>
      </div>
      <a href="${loginPageLink}" class="btn">Login to Owner Portal</a>
      <div class="warn">⚠️ <strong>Important:</strong> Please change your password after your first login.</div>
    </div>
    <div class="foot"><p>© 2025 RoomHy. All rights reserved. | support@roomhy.com</p></div>
  </div></div>
</body>
</html>`;
                emailSent = await mailer.sendMail(ownerEmail, subject, text, html);
            }
        } catch (emailErr) {
            console.warn('[visits/approve] Email send failed:', emailErr.message);
        }

        res.json({
            success: true,
            message: 'Visit approved successfully',
            visit: visit,
            credentials: {
                loginId: finalLoginId,
                tempPassword: finalPassword
            },
            ownerProperty,
            email: {
                attempted: emailAttempted,
                sent: emailSent
            }
        });
    } catch (error) {
        console.error('? [visits/approve] Error approving visit:', error.message);
        console.error('? [visits/approve] Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Error approving visit',
            error: error.message
        });
    }
});

// ============================================================
// POST: Hold a visit
// ============================================================
router.post('/hold', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const { visitId, holdReason, holdAction } = req.body;

        if (!visitId) {
            return res.status(400).json({
                success: false,
                message: 'Missing visitId'
            });
        }

        // Find and update visit status to hold
        const visit = await VisitData.findOneAndUpdate(
            { $or: [{ _id: visitId }, { visitId: visitId }] },
            {
                status: 'hold',
                holdReason: holdReason || '',
                holdAction: holdAction || 'edit',
                holdAt: new Date()
            },
            { new: true }
        );

        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        console.log('? [visits/hold] Visit held:', visitId);

        res.json({
            success: true,
            message: 'Visit held successfully',
            visit: visit
        });
    } catch (error) {
        console.error('? [visits/hold] Error holding visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error holding visit',
            error: error.message
        });
    }
});

// ============================================================
// POST: Submit a new visit
// Supports both old (Area Manager) and new (clean form) formats
// ============================================================
router.post('/submit', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        let {
            visitorName,
            visitorEmail,
            visitorPhone,
            propertyName,
            propertyType,
            city,
            area,
            address,
            pincode,
            description,
            amenities,
            genderSuitability,
            monthlyRent,
            deposit,
            vacantRooms,
            occupiedRooms,
            occupiedBeds,
            ownerName,
            ownerEmail,
            ownerPhone,
            ownerCity,
            photos,
            professionalPhotos,
            // Old format support
            staffName,
            staffId,
            propertyInfo,
            name,
            contactPhone,
            ownerGmail,
            landmark,
            nearbyLocation,
            cleanlinessRating,
            studentReviewsRating,
            studentReviews,
            furnishing,
            ventilation,
            minStay,
            entryExit,
            visitorsAllowed,
            cookingAllowed,
            smokingAllowed,
            petsAllowed,
            internalRemarks,
            cleanlinessNote,
            ownerBehaviour,
            latitude,
            longitude,
            roomTypes
        } = req.body;

        // Support both old and new formats
        if (propertyInfo) {
            // Old Area Manager format
            propertyName = propertyName || propertyInfo.name || name;
            propertyType = propertyType || propertyInfo.propertyType;
            city = city || propertyInfo.city;
            area = area || propertyInfo.area;
            ownerName = ownerName || propertyInfo.ownerName;
            ownerEmail = ownerEmail || propertyInfo.ownerGmail || propertyInfo.ownerEmail;
            ownerPhone = ownerPhone || propertyInfo.contactPhone;
            address = address || propertyInfo.address;
            pincode = pincode || propertyInfo.pincode;
        } else {
            // New format - ensure propertyName is set
            propertyName = propertyName || name;
        }

        // Validate required fields
        // propertyName is required. city is optional if area is provided.
        if (!propertyName) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: propertyName'
            });
        }
        
        // If city is not provided, use area as city (for Area Manager visits)
        if (!city && area) {
            city = area;
        } else if (!city) {
            city = 'Unknown'; // Fallback city
        }

        // Create unique visit ID (use existing _id if provided)
        const visitId = req.body._id || (Date.now() + '_' + Math.random().toString(36).substr(2, 9));

        // Create new visit
        const visit = new VisitData({
            visitId,
            visitorName: visitorName || staffName,
            visitorEmail,
            visitorPhone,
            propertyName,
            propertyType,
            city,
            area,
            address,
            pincode,
            description,
            amenities: (amenities && Array.isArray(amenities)) ? amenities : (amenities ? [amenities] : []),
            genderSuitability,
            monthlyRent: parseInt(monthlyRent) || 0,
            deposit,
            ...normalizeOccupancyFields({ vacantRooms, occupiedRooms, occupiedBeds }),
            ownerName,
            ownerEmail,
            ownerPhone,
            ownerCity: ownerCity || city,
            photos: (photos && Array.isArray(photos)) ? photos : (photos ? [photos] : []),
            professionalPhotos: (professionalPhotos && Array.isArray(professionalPhotos)) ? professionalPhotos : (professionalPhotos ? [professionalPhotos] : []),
            roomTypes: (roomTypes && Array.isArray(roomTypes)) ? roomTypes : [],
            status: 'submitted',
            // Additional fields from old format
            ...(staffId && { staffId }),
            ...(staffName && { staffName }),
            ...(latitude && { latitude }),
            ...(longitude && { longitude }),
            ...(landmark && { landmark }),
            ...(nearbyLocation && { nearbyLocation }),
            ...(cleanlinessRating && { cleanlinessRating }),
            ...(studentReviewsRating && { studentReviewsRating }),
            ...(studentReviews && { studentReviews }),
            ...(furnishing && { furnishing }),
            ...(ventilation && { ventilation }),
            ...(minStay && { minStay }),
            ...(entryExit && { entryExit }),
            ...(visitorsAllowed !== undefined && { visitorsAllowed: stringToBoolean(visitorsAllowed) }),
            ...(cookingAllowed !== undefined && { cookingAllowed: stringToBoolean(cookingAllowed) }),
            ...(smokingAllowed !== undefined && { smokingAllowed: stringToBoolean(smokingAllowed) }),
            ...(petsAllowed !== undefined && { petsAllowed: stringToBoolean(petsAllowed) }),
            ...(internalRemarks && { internalRemarks }),
            ...(cleanlinessNote && { cleanlinessNote }),
            ...(ownerBehaviour && { ownerBehaviour })
        });

        // Save to MongoDB
        await visit.save();

        // Issue owner credentials and email the digital-KYC link straight away —
        // the owner completing KYC is what unblocks superadmin approval, so this
        // must not wait on a manual step. Failure here is reported but never
        // fails the submission: the report is saved and the link can be resent.
        let kycLinkSent = false;
        let kycLinkError = null;
        try {
            await sendOwnerKycLink(visit);
            kycLinkSent = true;
        } catch (kycErr) {
            kycLinkError = kycErr.message;
            console.warn('[visits/submit] KYC link auto-send failed:', kycErr.message);
        }

        try {
            await notifySuperadmin({
                type: 'new_enquiry',
                from: 'area_manager',
                subject: `New Visit Submission - ${propertyName || 'Property'}`,
                message: 'A new visit submission is waiting for superadmin approval.',
                meta: {
                    enquiryId: visitId,
                    userName: ownerName || visitorName || staffName || '',
                    userEmail: ownerEmail || visitorEmail || '',
                    propertyName: propertyName || '',
                    city: city || '',
                    area: area || ''
                }
            });
        } catch (notifyErr) {
            console.warn('visit submit notification failed:', notifyErr.message);
        }

        res.status(201).json({
            success: true,
            message: kycLinkSent
                ? 'Visit submitted successfully. Digital KYC link sent to the owner.'
                : 'Visit submitted successfully, but the KYC link could not be emailed. Resend it from Visit Reports.',
            visitId: visitId,
            kycLinkSent,
            kycLinkError,
            data: visit
        });

    } catch (error) {
        console.error('Error submitting visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error submitting visit',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get all visits - Superadmin only
// ============================================================
router.get('/all', protect, authorize('superadmin'), async (req, res) => {
    try {
        const visits = await VisitData.find({}).sort({ submittedAt: -1 });
        res.json({
            success: true,
            count: visits.length,
            visits: visits
        });
    } catch (error) {
        console.error('Error fetching visits:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching visits',
            error: error.message
        });
    }
});

// ============================================================
// GET: Get approved visits - Superadmin only
// ============================================================
router.get('/approved', protect, authorize('superadmin'), async (req, res) => {
    try {
        const visits = await VisitData.find({
            status: 'approved'
        }).sort({ submittedAt: -1 });
        res.json({
            success: true,
            count: visits.length,
            visits: visits,
            properties: visits  // Alias for compatibility
        });
    } catch (error) {
        console.error('Error fetching approved visits:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching approved visits',
            error: error.message
        });
    }
});
// POST: Resend the digital-KYC link to the property owner's email
// The link is sent automatically on visit submission; this is the manual resend.
// ============================================================
router.post('/:visitId/send-kyc-link', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const visit = await VisitData.findOne({ visitId: req.params.visitId });
        if (!visit) {
            return res.status(404).json({ success: false, message: 'Visit not found' });
        }

        const { loginId } = await sendOwnerKycLink(visit);
        res.json({ success: true, message: 'KYC link sent successfully to owner email', loginId });
    } catch (error) {
        console.error('[visits/send-kyc-link] Error:', error.message);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode ? error.message : 'Error sending KYC link',
            error: error.message
        });
    }
});

// NOTE: the token-based KYC routes that used to live here (GET /kyc/:token and
// POST /kyc/:token/submit) were removed. Owners complete KYC on the digital
// check-in pages — which is where the emailed link has always pointed — and that
// flow writes to the Owner record, reconciled back here by syncVisitKycStatus().
// The token routes were never reachable and duplicated kycStatus handling.

// ============================================================
// GET: Get a single visit by ID
// ============================================================
router.get('/:visitId', async (req, res) => {
    try {
        const visit = await VisitData.findOne({ visitId: req.params.visitId });
        
        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        res.json({
            success: true,
            visit: visit
        });
    } catch (error) {
        console.error('Error fetching visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching visit',
            error: error.message
        });
    }
});

// ============================================================
// DELETE: Delete a visit report by visitId or _id
// ============================================================
router.delete('/:visitId', async (req, res) => {
    try {
        const { visitId } = req.params;
        const mongoose = require('mongoose');
        let query;
        if (mongoose.Types.ObjectId.isValid(visitId) && visitId.match(/^[0-9a-fA-F]{24}$/)) {
            query = { $or: [{ _id: visitId }, { visitId: visitId }] };
        } else {
            query = { visitId: visitId };
        }
        const deleted = await VisitData.findOneAndDelete(query);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Visit not found' });
        }
        res.json({ success: true, message: 'Visit report deleted successfully' });
    } catch (error) {
        console.error('Error deleting visit:', error);
        res.status(500).json({ success: false, message: 'Error deleting visit', error: error.message });
    }
});



// ============================================================
// POST: Reject a visit with explicit reason and next action
// ============================================================
router.post('/reject', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const { visitId, rejectReason, rejectAction } = req.body;

        if (!visitId) {
            return res.status(400).json({
                success: false,
                message: 'Missing visitId'
            });
        }

        const visit = await VisitData.findOneAndUpdate(
            { $or: [{ _id: visitId }, { visitId: visitId }] },
            {
                status: 'rejected',
                rejectReason: rejectReason || '',
                rejectAction: rejectAction || 'cancel',
                rejectedAt: new Date()
            },
            { new: true }
        );

        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        console.log('? [visits/reject] Visit rejected:', visitId);

        res.json({
            success: true,
            message: 'Visit rejected successfully',
            visit
        });
    } catch (error) {
        console.error('? [visits/reject] Error rejecting visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error rejecting visit',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Update visit status
// ============================================================
router.put('/:visitId/status', protect, authorize('superadmin', 'employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const { status } = req.body;
        
        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'status is required'
            });
        }

        const visit = await VisitData.findOneAndUpdate(
            { visitId: req.params.visitId },
            { status, updatedAt: new Date() },
            { new: true }
        );

        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        res.json({
            success: true,
            message: 'Visit status updated',
            visit: visit
        });
    } catch (error) {
        console.error('Error updating visit status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating visit status',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Update full visit details (moved after status route to avoid interception)
// ============================================================
router.put('/:visitId', protect, authorize('employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const {
            propertyName,
            propertyType,
            propertyId,
            address,
            area,
            areaLocality,
            city,
            landmark,
            nearbyLocation,
            ownerName,
            ownerEmail,
            contactPhone,
            gender,
            monthlyRent,
            deposit,
            vacantRooms,
            occupiedRooms,
            occupiedBeds,
            electricityCharges,
            foodCharges,
            maintenanceCharges,
            minStay,
            entryExit,
            amenities,
            cleanlinessRating,
            ownerBehaviourPublic,
            studentReviewsRating,
            employeeRating,
            visitorsAllowed,
            cookingAllowed,
            smokingAllowed,
            petsAllowed,
            internalRemarks,
            studentReviews,
            cleanlinessNote,
            ownerBehaviour,
            latitude,
            longitude,
            photos,
            professionalPhotos,
            locationCode,
            bankAccountHolderName,
            bankAccountNumber,
            bankIfscCode,
            bankName,
            bankBranchName,
            bankUpiId
        } = req.body;

        const visit = await VisitData.findOneAndUpdate(
            { visitId: req.params.visitId },
            {
                ...(propertyName !== undefined && { propertyName }),
                ...(propertyType !== undefined && { propertyType }),
                ...(propertyId !== undefined && { propertyId }),
                ...(address !== undefined && { address }),
                ...(area !== undefined && { area }),
                ...(areaLocality !== undefined && { areaLocality }),
                ...(city !== undefined && { city }),
                ...(landmark !== undefined && { landmark }),
                ...(nearbyLocation !== undefined && { nearbyLocation }),
                ...(ownerName !== undefined && { ownerName }),
                ...(ownerEmail !== undefined && { ownerEmail }),
                ...(contactPhone !== undefined && { contactPhone, ownerPhone: contactPhone }),
                ...(gender !== undefined && { gender }),
                ...(monthlyRent !== undefined && { monthlyRent: parseInt(monthlyRent, 10) || 0 }),
                ...(deposit !== undefined && { deposit: parseInt(deposit, 10) || 0 }),
                ...((vacantRooms !== undefined || occupiedRooms !== undefined || occupiedBeds !== undefined)
                    ? normalizeOccupancyFields({ vacantRooms, occupiedRooms, occupiedBeds })
                    : {}),
                ...(electricityCharges !== undefined && { electricityCharges: parseInt(electricityCharges, 10) || 0 }),
                ...(foodCharges !== undefined && { foodCharges: parseInt(foodCharges, 10) || 0 }),
                ...(maintenanceCharges !== undefined && { maintenanceCharges: parseInt(maintenanceCharges, 10) || 0 }),
                ...(minStay !== undefined && { minStay: parseInt(minStay, 10) || 0 }),
                ...(entryExit !== undefined && { entryExit }),
                ...(amenities !== undefined && { amenities: Array.isArray(amenities) ? amenities : (amenities ? [amenities] : []) }),
                ...(cleanlinessRating !== undefined && { cleanlinessRating: parseInt(cleanlinessRating, 10) || 0 }),
                ...(ownerBehaviourPublic !== undefined && { ownerBehaviourPublic }),
                ...(studentReviewsRating !== undefined && { studentReviewsRating: parseInt(studentReviewsRating, 10) || 0 }),
                ...(employeeRating !== undefined && { employeeRating: parseInt(employeeRating, 10) || 0 }),
                ...(visitorsAllowed !== undefined && { visitorsAllowed: stringToBoolean(visitorsAllowed) }),
                ...(cookingAllowed !== undefined && { cookingAllowed: stringToBoolean(cookingAllowed) }),
                ...(smokingAllowed !== undefined && { smokingAllowed: stringToBoolean(smokingAllowed) }),
                ...(petsAllowed !== undefined && { petsAllowed: stringToBoolean(petsAllowed) }),
                ...(internalRemarks !== undefined && { internalRemarks }),
                ...(studentReviews !== undefined && { studentReviews }),
                ...(cleanlinessNote !== undefined && { cleanlinessNote }),
                ...(ownerBehaviour !== undefined && { ownerBehaviour }),
                ...(latitude !== undefined && { latitude }),
                ...(longitude !== undefined && { longitude }),
                ...(photos !== undefined && { photos: Array.isArray(photos) ? photos : (photos ? [photos] : []) }),
                ...(professionalPhotos !== undefined && { professionalPhotos: Array.isArray(professionalPhotos) ? professionalPhotos : (professionalPhotos ? [professionalPhotos] : []) }),
                ...(locationCode !== undefined && { locationCode }),
                ...(bankAccountHolderName !== undefined && { bankAccountHolderName }),
                ...(bankAccountNumber !== undefined && { bankAccountNumber }),
                ...(bankIfscCode !== undefined && { bankIfscCode }),
                ...(bankName !== undefined && { bankName }),
                ...(bankBranchName !== undefined && { bankBranchName }),
                ...(bankUpiId !== undefined && { bankUpiId }),
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        // Auto-sync bank details to Owner if any bank field was provided
        const hasBankData = [bankAccountHolderName, bankAccountNumber, bankIfscCode, bankName, bankBranchName].some(v => v !== undefined && v !== '');
        if (hasBankData && visit.generatedCredentials?.loginId) {
            try {
                const Owner = require('../models/Owner');
                await Owner.findOneAndUpdate(
                    { loginId: visit.generatedCredentials.loginId },
                    {
                        ...(bankAccountHolderName !== undefined && { checkinAccountHolderName: bankAccountHolderName }),
                        ...(bankAccountNumber !== undefined && { checkinBankAccountNumber: bankAccountNumber }),
                        ...(bankIfscCode !== undefined && { checkinIfscCode: bankIfscCode }),
                        ...(bankName !== undefined && { checkinBankName: bankName }),
                        ...(bankBranchName !== undefined && { checkinBranchName: bankBranchName }),
                        ...(bankUpiId !== undefined && { checkinUpiId: bankUpiId }),
                        bankLockedByVisit: true
                    }
                );
            } catch (_) {}
        }

        res.json({
            success: true,
            message: 'Visit updated successfully',
            visit
        });
    } catch (error) {
        console.error('Error updating visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating visit',
            error: error.message
        });
    }
});

// ============================================================
// NOTE: the legacy `POST /:visitId/approve` route was removed. It set the visit
// to approved WITHOUT the owner-KYC gate and wrote a malformed ApprovedProperty
// document (flat fields instead of the propertyInfo shape the website reads), so
// it never actually published anything. `POST /api/visits/approve` is the single
// approval path: it enforces KYC, provisions the Owner + Property, and publishes.
// ============================================================

// ============================================================
// POST: Reject a visit
// ============================================================
router.post('/:visitId/reject', protect, authorize('employee', 'manager', 'areamanager'), async (req, res) => {
    try {
        const { approvalNotes, approvedBy } = req.body;
        
        const visit = await VisitData.findOneAndUpdate(
            { visitId: req.params.visitId },
            {
                status: 'rejected',
                approvalNotes,
                approvedBy,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        res.json({
            success: true,
            message: 'Visit rejected',
            visit: visit
        });

    } catch (error) {
        console.error('Error rejecting visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error rejecting visit',
            error: error.message
        });
    }
});

// ============================================================
// DELETE: Delete a visit
// ============================================================
router.delete('/:visitId', async (req, res) => {
    try {
        const visit = await VisitData.findOneAndDelete({ visitId: req.params.visitId });
        
        if (!visit) {
            return res.status(404).json({
                success: false,
                message: 'Visit not found'
            });
        }

        res.json({
            success: true,
            message: 'Visit deleted successfully',
            visit: visit
        });
    } catch (error) {
        console.error('Error deleting visit:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting visit',
            error: error.message
        });
    }
});

module.exports = router;
