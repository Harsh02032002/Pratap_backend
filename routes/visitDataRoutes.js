const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const VisitData = require('../models/VisitData');
const VisitSubmitClaim = require('../models/VisitSubmitClaim');
const User = require('../models/user');
const Owner = require('../models/Owner');
const CheckinRecord = require('../models/CheckinRecord');
const Property = require('../models/Property');
const mailer = require('../utils/mailer');
const { notifySuperadmin } = require('../utils/superadminNotifier');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');
const { requireVisitInScope } = require('../utils/scopeHelpers');
const { clearCache } = require('../middleware/apiCache');
// Was 12000 — exactly the client timeout, so it could never fire before the
// browser gave up. Now drawn from the shared hierarchy (7s read class), which
// sits under the 10s request deadline.
const { deadlineFor, runOutsideRequestBudget } = require('../utils/queryDeadline');
const VISITS_QUERY_TIMEOUT_MS = deadlineFor('read');
const VISITS_CACHE_TTL_MS = 10000;
const visitsListCache = new Map();

/**
 * Drop the cached visit lists after anything changes a visit.
 *
 * The cache was write-only: entries expired on a 10s TTL and nothing ever
 * cleared them. So a superadmin who approved or rejected a report, and the
 * panel then reloaded the list, could be served the pre-change copy and see the
 * row unchanged — the action looking as though it had silently failed.
 *
 * Cheap to clear wholesale: entries are keyed by staff filter and pagination,
 * and one mutation can affect any of them.
 */
const invalidateVisitsList = () => visitsListCache.clear();
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
const OWNER_LOGIN_ID_REGEX = /^(ROOMHY\d+|\d{10}|\d{3,6})$/i;

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
            } else if (v.kycStatus !== 'sent') {
                await VisitData.updateOne(
                    { visitId: v.visitId },
                    { kycStatus: 'sent', kycSentAt: v.kycSentAt || new Date() }
                );
                v.kycStatus = 'sent';
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
    const ownerEmail = String(
        visit.ownerEmail ||
        (visit.propertyInfo && (visit.propertyInfo.ownerEmail || visit.propertyInfo.ownerGmail)) ||
        visit.ownerGmail ||
        visit.visitorEmail ||
        ''
    ).trim();

    if (!ownerEmail) {
        const err = new Error('No owner email found on this visit report');
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

    // Carry what the employee already wrote down onto the Owner record, so the
    // digital check-in page can prefill it. Without this the owner is asked to
    // retype the address and bank details that are already on the visit report,
    // and the page shows those fields blank under a "PRE-FILLED BY ROOMHY"
    // heading.
    //
    // Gaps only. This function also backs the manual "Resend KYC" button, and by
    // then the owner may have corrected these fields on the check-in page. The
    // visit report is the employee's second-hand note; whatever the owner
    // entered about their own bank account wins.
    const existingOwner = await Owner.findOne({ loginId })
        .select('phone profile address bankName branchName accountNumber ifscCode accountHolderName upiId ' +
                'checkinPhone checkinAddress checkinBankName checkinBranchName ' +
                'checkinBankAccountNumber checkinIfscCode checkinAccountHolderName checkinUpiId')
        .lean();

    const prefill = {};
    const fillIfBlank = (field, value) => {
        const next = String(value || '').trim();
        if (next && !String(existingOwner?.[field] || '').trim()) prefill[field] = next;
    };
    fillIfBlank('checkinPhone', ownerPhone);
    fillIfBlank('checkinAddress', visit.address || visit.fullAddress);
    fillIfBlank('checkinBankName', visit.bankName);
    fillIfBlank('checkinBranchName', visit.bankBranchName);
    fillIfBlank('checkinBankAccountNumber', visit.bankAccountNumber);
    fillIfBlank('checkinIfscCode', visit.bankIfscCode);
    fillIfBlank('checkinAccountHolderName', visit.bankAccountHolderName || ownerName);
    fillIfBlank('checkinUpiId', visit.bankUpiId);

    fillIfBlank('address', visit.address || visit.fullAddress);
    fillIfBlank('bankName', visit.bankName);
    fillIfBlank('branchName', visit.bankBranchName);
    fillIfBlank('accountNumber', visit.bankAccountNumber);
    fillIfBlank('ifscCode', visit.bankIfscCode);
    fillIfBlank('accountHolderName', visit.bankAccountHolderName || ownerName);
    fillIfBlank('upiId', visit.bankUpiId);

    // A visit with no owner phone must not blank out a number the owner already
    // gave — this same line runs again on every resend.
    const resolvedPhone = ownerPhone || existingOwner?.phone || existingOwner?.profile?.phone || '';

    // Create/update Owner record so the digital-checkin page can look it up
    await Owner.findOneAndUpdate(
        { loginId },
        {
            $set: {
                loginId,
                name: ownerName,
                email: ownerEmail,
                phone: resolvedPhone,
                area: ownerArea,
                locationCode: propertyLocationCode,
                profile: {
                    name: ownerName,
                    email: ownerEmail,
                    phone: resolvedPhone,
                    address: visit.address || visit.fullAddress || '',
                    locationCode: propertyLocationCode,
                    bankName: visit.bankName || '',
                    accountNumber: visit.bankAccountNumber || '',
                    ifscCode: visit.bankIfscCode || '',
                    branchName: visit.bankBranchName || '',
                    accountHolderName: visit.bankAccountHolderName || ownerName,
                    upiId: visit.bankUpiId || '',
                    updatedAt: new Date()
                },
                ...occupancy,
                ...prefill,
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

/**
 * Write a response only if one has not already gone out.
 *
 * The request deadline (middleware/requestDeadline.js) can answer 503 while a
 * handler is still running, and Node cannot cancel that handler — so a late
 * res.json() throws ERR_HTTP_HEADERS_SENT. Worse, a throw from inside a
 * handler's success path lands in its own catch, which responds again and
 * throws a second time, escaping to the Express error handler as noise that
 * buries real failures. Guarding both ends turns that into one log line.
 */
function respondOnce(res, status, payload) {
    if (res.headersSent || res.writableEnded) {
        console.warn(`[visits] response already sent; dropping ${status} reply`);
        return false;
    }
    res.status(status).json(payload);
    return true;
}

/**
 * Post-submission delivery: owner KYC link, superadmin notification, WhatsApp.
 *
 * Runs AFTER the response has been flushed, so its latency cannot push the
 * request past its deadline. Never throws — the caller does not await it, so an
 * escaping rejection would be an unhandled rejection, not a handled error.
 * Outcomes land on the VisitData doc so the Visit Reports list can show what
 * actually happened.
 */
async function dispatchVisitSubmissionNotices(visit, ctx = {}) {
    const { propertyName, ownerName, visitorName, staffName, ownerEmail, visitorEmail, city, area } = ctx;

    // Send Digital KYC link to owner so owner can complete KYC verification
    try {
        await sendOwnerKycLink(visit);
    } catch (kycErr) {
        console.warn('[visits/submit] KYC link auto-send failed:', kycErr.message);
        try {
            await VisitData.updateOne(
                { visitId: visit.visitId },
                { $set: { kycLinkError: kycErr.message } }
            );
        } catch (writeErr) {
            console.warn('[visits/submit] could not record KYC error:', writeErr.message);
        }
    }

    try {
        await notifySuperadmin({
            type: 'new_enquiry',
            from: 'area_manager',
            subject: `New Visit Submission - ${propertyName || 'Property'}`,
            message: 'A new visit submission is waiting for superadmin approval.',
            meta: {
                enquiryId: visit.visitId,
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
}

/**
 * Email the owner their credentials after an approval.
 *
 * Sent AFTER the approve response, not inside it: this is an SMTP round-trip
 * (plus WhatsApp) on top of the seven database round-trips the approval already
 * makes, and awaiting it pushed the request past the 10s request deadline. The
 * deadline then answered 503 for an approval that had already published the
 * property. Never throws — the caller does not await it.
 */
async function sendApprovalCredentialsEmail({
    finalLoginId, finalPassword, ownerEmailFromVisit, ownerName, propertyTitle
}) {
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
                await mailer.sendMail(ownerEmail, subject, text, html);
            }
        } catch (emailErr) {
            console.warn('[visits/approve] Email send failed:', emailErr.message);
        }
}

/**
 * How recently an identical report counts as an accidental re-submit.
 *
 * Measured against the real duplicates in the database: the pair this guard
 * exists for was filed 57 SECONDS apart (a retry after the request appeared to
 * fail), while the genuinely separate re-listings of the same property were
 * ~20 DAYS apart. Ten minutes sits far above the first and far below the
 * second, so it catches the accident without ever blocking a real re-listing.
 */
const DUPLICATE_SUBMIT_WINDOW_MS =
    Number.parseInt(process.env.DUPLICATE_SUBMIT_WINDOW_MS || '', 10) || 10 * 60 * 1000;

/**
 * Identity of a submission, for duplicate detection.
 *
 * Property name plus a strong owner identifier. Name alone would collide across
 * genuinely different owners; an owner alone would block someone legitimately
 * filing two of their properties in one sitting. Normalised so that casing and
 * stray whitespace cannot sneak a duplicate past.
 *
 * @returns {string|null} null when there is not enough to identify the report,
 *   in which case no duplicate claim is attempted at all.
 */
function buildVisitFingerprint({ propertyName, ownerPhone, ownerEmail }) {
    const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const name = norm(propertyName);
    // Phone first: it survives a typo'd email and is what staff actually key on.
    const owner = String(ownerPhone || '').replace(/\D/g, '') || norm(ownerEmail);
    if (!name || !owner) return null;
    return `${name}::${owner}`;
}

/**
 * Claim the right to file this report, or report who already has it.
 *
 * Insert-first-wins against a unique index (models/VisitSubmitClaim.js), so
 * this is safe against concurrent submits in a way a "look then insert" check
 * is not. Verified against the running server: five simultaneous submits used
 * to create five reports, and now create one.
 *
 * @returns {Promise<{claimed:true}|{claimed:false, existingVisit:object|null}>}
 */
async function claimVisitSubmission(fingerprint, visitId) {
    if (!fingerprint) return { claimed: true };

    try {
        await VisitSubmitClaim.create({
            fingerprint,
            visitId,
            expiresAt: new Date(Date.now() + DUPLICATE_SUBMIT_WINDOW_MS)
        });
        return { claimed: true };
    } catch (err) {
        const isDuplicate = err?.code === 11000 || /E11000/.test(err?.message || '');
        if (!isDuplicate) throw err;
    }

    // Someone holds the claim. Point the caller at the report they filed.
    const held = await VisitSubmitClaim.findOne({ fingerprint }).lean();
    const existingVisit = held?.visitId
        ? await VisitData.findOne({ visitId: held.visitId }).lean()
        : null;

    // The claim outlived the report it named (deleted, or the save that made it
    // failed). Nothing to point at, so let this submission take the claim over
    // rather than refusing a report that does not exist.
    if (!existingVisit) {
        await VisitSubmitClaim.updateOne({ fingerprint }, {
            $set: { visitId, expiresAt: new Date(Date.now() + DUPLICATE_SUBMIT_WINDOW_MS) }
        });
        return { claimed: true };
    }

    return { claimed: false, existingVisit };
}

/** Release a claim whose report failed to save, so a retry is not locked out. */
async function releaseVisitSubmission(fingerprint, visitId) {
    if (!fingerprint) return;
    try {
        await VisitSubmitClaim.deleteOne({ fingerprint, visitId });
    } catch (err) {
        console.warn('[visits/submit] could not release claim:', err.message);
    }
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

        console.log('✅ [visits/POST] Visit saved to MongoDB:', newVisit._id, 'visitId:', visitId);

        runOutsideRequestBudget(() => {
            const propName = newVisit.propertyName || (newVisit.propertyInfo && newVisit.propertyInfo.name) || 'Property';
            const oName = newVisit.ownerName || (newVisit.propertyInfo && newVisit.propertyInfo.ownerName) || '';
            const oEmail = newVisit.ownerEmail || (newVisit.propertyInfo && (newVisit.propertyInfo.ownerEmail || newVisit.propertyInfo.ownerGmail)) || newVisit.visitorEmail || '';

            dispatchVisitSubmissionNotices(newVisit, {
                propertyName: propName,
                ownerName: oName,
                ownerEmail: oEmail,
                visitorName: newVisit.visitorName || newVisit.staffName,
                visitorEmail: newVisit.visitorEmail,
                city: newVisit.city,
                area: newVisit.area
            }).catch((err) => {
                console.error('[visits/POST] dispatchVisitSubmissionNotices failed:', err.message);
            });
        });

        res.status(201).json({
            success: true,
            message: 'Visit saved successfully. Digital KYC link sent to owner.',
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
router.get('/', protect, authorize('superadmin', 'employee', 'manager', 'areamanager', 'owner'), async (req, res) => {
    try {
        const requester = await resolveRequestUser(req);
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
        const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);

        // Fetch all visit reports for staff / employee / area admin view without stale cache
        const visitsQuery = VisitData.find({})
            .sort({ submittedAt: -1 })
            .limit(limit)
            .skip(skip)
            .maxTimeMS(VISITS_QUERY_TIMEOUT_MS)
            .lean();

        const countQuery = VisitData.countDocuments({}).maxTimeMS(VISITS_QUERY_TIMEOUT_MS);
        const [visits, totalCount] = await Promise.all([visitsQuery, countQuery]);

        await syncVisitKycStatus(visits);

        console.log(`✅ [visits/GET] Returning all ${visits.length} visits from ${totalCount} total in MongoDB`);
        return res.json({
            success: true,
            count: totalCount,
            returned: visits.length,
            visits
        });
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
        const { visitId, status, isLiveOnWebsite, loginId, tempPassword, tier } = req.body;
        console.log('?? [visits/approve] Received request:', { visitId, status, isLiveOnWebsite, tier });

        if (!visitId) {
            console.error('? [visits/approve] Missing visitId in request body');
            return respondOnce(res, 400, {
                success: false,
                message: 'Missing visitId'
            });
        }

        // Tier must be assigned before a property is published, mirroring the
        // KYC gate below — the UI already disables Approve until both are set.
        if (!tier) {
            return respondOnce(res, 400, {
                success: false,
                message: 'Cannot approve. Select a property tier before publishing.'
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
            return respondOnce(res, 400, {
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
        
        // Claim the transition atomically.
        //
        // Approving does a lot of downstream work — an Owner upsert, a Property
        // create, an ApprovedProperty upsert, a credentials email. Two clicks
        // (or a retry after the request appeared to fail) both used to pass the
        // checks above and run all of it twice, which is how a property gets
        // published twice and the owner gets two credential mails. The `$ne`
        // means only ONE request can move the visit into the target status;
        // whoever loses finds it already approved and stops.
        const targetStatus = status || 'approved';
        const visit = await VisitData.findOneAndUpdate(
            { ...query, status: { $ne: targetStatus } },
            {
                status: targetStatus,
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
            // Either it does not exist, or someone already approved it.
            const existing = await VisitData.findOne(query).lean();
            if (!existing) {
                console.error('? [visits/approve] Visit not found:', visitId);
                return respondOnce(res, 404, {
                    success: false,
                    message: 'Visit not found'
                });
            }
            console.warn(`[visits/approve] ${visitId} is already '${existing.status}'; ignoring duplicate approve`);
            return respondOnce(res, 200, {
                success: true,
                message: 'This visit was already approved.',
                alreadyApproved: true,
                visit: existing,
                credentials: existing.generatedCredentials || null
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

        const photoDetails = Array.isArray(visit.photoDetails) ? visit.photoDetails : [];
        const cameraPhotoUrls = new Set(
            photoDetails
                .filter(d => d && (d.source === 'camera' || d.isLiveCapture || d.type === 'camera' || d.isCamera === true))
                .map(d => d.url)
                .filter(Boolean)
        );

        (visit.propertyViews || []).forEach((view) => {
            const label = String(view?.label || '').toLowerCase();
            if (label.includes('camera') || label.includes('live')) {
                (view.images || []).forEach((url) => { if (url) cameraPhotoUrls.add(url); });
            }
        });

        const allPhotos = Array.isArray(visit.photos) ? visit.photos : [];
        const uploadedGalleryPhotos = allPhotos.filter(url => url && !cameraPhotoUrls.has(url));

        // Use uploaded gallery photos for public property listing (exclude live camera captures)
        const propertyPhotos = uploadedGalleryPhotos;
        const featuredImage = propertyPhotos[0] || '';

        let ownerProperty = await Property.findOne({
            ownerLoginId: finalLoginId,
            title: { $regex: `^${escapeRegex(propertyTitle)}$`, $options: 'i' }
        });

        if (!ownerProperty) {
            ownerProperty = await Property.create({
                visitId: String(visit._id || visit.visitId),
                images: propertyPhotos,
                featuredImage: featuredImage,
                title: propertyTitle,
                description: visit.description || '',
                address: propertyAddress,
                city: visit.city || '',
                area: ownerArea || '',
                propertyType: visit.propertyType || '',
                monthlyRent: Number(visit.monthlyRent || 0),
                tier,
                ...occupancy,
                ownerName,
                ownerEmail: ownerEmailFromVisit,
                ownerPhone,
                locationCode: propertyLocationCode || 'GEN',
                ownerLoginId: finalLoginId,
                status: 'active',
                isPublished: true,
                isLiveOnWebsite: true,
                roomTypes: visit.roomTypes || []
            });
        } else {
            ownerProperty.description = visit.description || ownerProperty.description || '';
            ownerProperty.address = propertyAddress || ownerProperty.address || '';
            ownerProperty.city = visit.city || ownerProperty.city || '';
            ownerProperty.area = ownerArea || ownerProperty.area || '';
            ownerProperty.propertyType = visit.propertyType || ownerProperty.propertyType || '';
            ownerProperty.monthlyRent = Number(visit.monthlyRent || ownerProperty.monthlyRent || 0);
            ownerProperty.tier = tier || ownerProperty.tier || '';
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
            ownerProperty.isPublished = true;
            ownerProperty.isLiveOnWebsite = true;
            if (visit.roomTypes && visit.roomTypes.length > 0) {
                ownerProperty.roomTypes = visit.roomTypes;
            }
            ownerProperty.images = propertyPhotos;
            if (featuredImage) ownerProperty.featuredImage = featuredImage;
            if (!ownerProperty.visitId) ownerProperty.visitId = String(visit._id || visit.visitId);
            await ownerProperty.save();
        }

        // Always save/update approved visit to ApprovedProperty collection
        try {
            const ApprovedProperty = require('../models/ApprovedProperty');
            const propData = {
                visitId: visit._id || visit.visitId,
                tier,
                images: propertyPhotos,
                featuredImage: featuredImage,
                propertyInfo: {
                    name: visit.propertyName || (visit.propertyInfo && visit.propertyInfo.name) || 'Property',
                    address: visit.address || (visit.propertyInfo && visit.propertyInfo.address) || '',
                    city: visit.city || (visit.propertyInfo && visit.propertyInfo.city) || '',
                    area: visit.area || (visit.propertyInfo && visit.propertyInfo.area) || '',
                    locationCode: propertyLocationCode,
                    photos: propertyPhotos,
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
                isLiveOnWebsite: true,
                status: 'live',
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

        invalidateVisitsList();
        console.log('? [visits/approve] Visit approved successfully:', visitId);

        // Everything the approval actually consists of is now durable, so reply.
        //
        // The credentials email below is a full SMTP round-trip (plus WhatsApp)
        // and used to be awaited before this response. On top of the seven
        // database round-trips above it pushed the request past the 10s deadline
        // in middleware/requestDeadline.js, which answered 503 ("The server took
        // too long to respond") for an approval that had already published the
        // property. Nothing above depends on the mail, so it is sent after the
        // response and detached from the request budget.
        respondOnce(res, 200, {
            success: true,
            message: 'Visit approved successfully',
            visit: visit,
            credentials: {
                loginId: finalLoginId,
                tempPassword: finalPassword
            },
            ownerProperty,
            email: { pending: true }
        });

        runOutsideRequestBudget(() => {
            sendApprovalCredentialsEmail({
                finalLoginId, finalPassword, ownerEmailFromVisit, ownerName, propertyTitle
            }).catch((err) => {
                console.error('[visits/approve] credentials email failed:', err);
            });
        });

    } catch (error) {
        console.error('? [visits/approve] Error approving visit:', error.message);
        console.error('? [visits/approve] Error stack:', error.stack);
        respondOnce(res, 500, {
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
router.post('/submit', protect, authorize(
    'superadmin', 'employee', 'manager', 'areamanager',
    'area_manager', 'area_admin', 'staff', 'field_executive', 'verification_officer',
    'owner', 'tenant', 'website_user', 'user'
), async (req, res) => {
    try {
        let {
            visitorName,
            visitorEmail,
            visitorPhone,
            propertyName,
            propertyType,
            state,
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
            roomTypes,
            bankAccountHolderName,
            bankAccountNumber,
            bankIfscCode,
            bankName,
            bankBranchName,
            bankUpiId,
            photoTimestamps,
            photoDetails
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
            return respondOnce(res, 400, {
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

        // Refuse an accidental re-submit of the same report.
        //
        // The panel reuses one visitId across retries of a draft, so a plain
        // retry lands on the duplicate-key branch below. This covers what that
        // cannot: a reload, a second tab, or a second click after the page was
        // navigated away — all of which mint a FRESH id for a report that has
        // already been filed and already mailed the owner a KYC link.
        //
        // Done as a unique-index claim rather than a lookup because a lookup
        // races: five simultaneous submits each read "nothing filed yet" and
        // each created a report, along with five Owner records under five
        // different loginIds.
        const fingerprint = buildVisitFingerprint({ propertyName, ownerPhone, ownerEmail });
        const claim = await claimVisitSubmission(fingerprint, visitId);
        if (!claim.claimed) {
            const held = claim.existingVisit;
            console.warn(`[visits/submit] near-duplicate of ${held.visitId} ("${propertyName}"); not filing a second report`);
            return respondOnce(res, 200, {
                success: true,
                message: 'This visit report was already submitted a moment ago.',
                visitId: held.visitId,
                duplicate: true,
                kycLinkPending: held.kycStatus !== 'sent',
                data: held
            });
        }

        // Check if an existing VisitData report already exists for this visitId (Edit Mode)
        const mongoose = require('mongoose');
        const existingVisit = await VisitData.findOne({
            $or: [
                { visitId: visitId },
                (req.body._id && mongoose.Types.ObjectId.isValid(req.body._id)) ? { _id: req.body._id } : null
            ].filter(Boolean)
        });

        if (existingVisit) {
            console.log(`📝 [visits/submit] Updating existing visit report ${existingVisit.visitId}`);
            const updateData = {
                visitorName: visitorName || staffName || existingVisit.visitorName,
                visitorEmail: visitorEmail || existingVisit.visitorEmail,
                visitorPhone: visitorPhone || existingVisit.visitorPhone,
                propertyName: propertyName || existingVisit.propertyName,
                propertyType: propertyType || existingVisit.propertyType,
                state: state || existingVisit.state,
                city: city || existingVisit.city,
                area: area || existingVisit.area,
                address: address || existingVisit.address,
                pincode: pincode || existingVisit.pincode,
                description: description || existingVisit.description,
                amenities: (amenities && Array.isArray(amenities)) ? amenities : existingVisit.amenities,
                genderSuitability: genderSuitability || existingVisit.genderSuitability,
                monthlyRent: parseInt(monthlyRent) || existingVisit.monthlyRent,
                deposit: deposit || existingVisit.deposit,
                ...normalizeOccupancyFields({ vacantRooms, occupiedRooms, occupiedBeds }),
                ownerName: ownerName || existingVisit.ownerName,
                ownerEmail: ownerEmail || existingVisit.ownerEmail,
                ownerPhone: ownerPhone || existingVisit.ownerPhone,
                ownerCity: ownerCity || city || existingVisit.ownerCity,
                contactPhone: contactPhone || ownerPhone || visitorPhone || existingVisit.contactPhone,
                photos: (photos && Array.isArray(photos) && photos.length > 0) ? photos : existingVisit.photos,
                professionalPhotos: (professionalPhotos && Array.isArray(professionalPhotos)) ? professionalPhotos : existingVisit.professionalPhotos,
                photoTimestamps: photoTimestamps || existingVisit.photoTimestamps,
                photoDetails: (photoDetails && Array.isArray(photoDetails) && photoDetails.length > 0) ? photoDetails : existingVisit.photoDetails,
                propertyViews: (req.body.propertyViews && Array.isArray(req.body.propertyViews) && req.body.propertyViews.length > 0) ? req.body.propertyViews : existingVisit.propertyViews,
                roomTypes: (roomTypes && Array.isArray(roomTypes) && roomTypes.length > 0) ? roomTypes : existingVisit.roomTypes,
                bankAccountHolderName: bankAccountHolderName || existingVisit.bankAccountHolderName,
                bankAccountNumber: bankAccountNumber || existingVisit.bankAccountNumber,
                bankIfscCode: bankIfscCode || existingVisit.bankIfscCode,
                bankName: bankName || existingVisit.bankName,
                bankBranchName: bankBranchName || existingVisit.bankBranchName,
                bankUpiId: bankUpiId || existingVisit.bankUpiId,
                updatedAt: new Date()
            };

            const updatedVisit = await VisitData.findOneAndUpdate(
                { _id: existingVisit._id },
                { $set: updateData },
                { new: true }
            );

            invalidateVisitsList();

            return respondOnce(res, 200, {
                success: true,
                message: 'Visit report updated successfully',
                visitId: updatedVisit.visitId,
                isUpdate: true,
                data: updatedVisit
            });
        }

        // Create new visit
        const visit = new VisitData({
            visitId,
            visitorName: visitorName || staffName,
            visitorEmail,
            visitorPhone,
            propertyName,
            propertyType,
            state,
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
            contactPhone: contactPhone || ownerPhone || visitorPhone || '',
            photos: (photos && Array.isArray(photos)) ? photos : (photos ? [photos] : []),
            professionalPhotos: (professionalPhotos && Array.isArray(professionalPhotos)) ? professionalPhotos : (professionalPhotos ? [professionalPhotos] : []),
            photoTimestamps: photoTimestamps || {},
            photoDetails: (photoDetails && Array.isArray(photoDetails)) ? photoDetails : [],
            propertyViews: (req.body.propertyViews && Array.isArray(req.body.propertyViews)) ? req.body.propertyViews : [],
            roomTypes: (roomTypes && Array.isArray(roomTypes)) ? roomTypes : [],
            bankAccountHolderName: bankAccountHolderName || '',
            bankAccountNumber: bankAccountNumber || '',
            bankIfscCode: bankIfscCode || '',
            bankName: bankName || '',
            bankBranchName: bankBranchName || '',
            bankUpiId: bankUpiId || '',
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

        // Save to MongoDB.
        //
        // visitId is unique, and the panel now reuses one id for all retries of
        // the same draft (see draftVisitIdRef in the frontend), which makes this
        // endpoint idempotent: a retry after a failed-looking submit must
        // confirm the existing report rather than duplicate it or 500 on E11000.
        try {
            await visit.save();
        } catch (saveErr) {
            const isDuplicate = saveErr?.code === 11000 || /E11000/.test(saveErr?.message || '');
            // The claim names a report that now does not exist. Drop it, or a
            // genuine retry of a failed submit is locked out for the whole window.
            if (!isDuplicate) {
                await releaseVisitSubmission(fingerprint, visitId);
                throw saveErr;
            }

            const existing = await VisitData.findOne({ visitId });
            console.warn(`[visits/submit] duplicate submit for ${visitId}; confirming the existing report`);
            if (!existing) await releaseVisitSubmission(fingerprint, visitId);

            respondOnce(res, 200, {
                success: true,
                message: 'This visit report was already submitted.',
                visitId,
                duplicate: true,
                kycLinkPending: existing?.kycStatus !== 'sent',
                data: existing
            });

            // Only re-run the fan-out if the first attempt never got the link out.
            if (existing && existing.kycStatus !== 'sent') {
                runOutsideRequestBudget(() => {
                    const submitterRole = String(req.user?.role || '').toLowerCase();
                    dispatchVisitSubmissionNotices(existing, {
                        propertyName, ownerName, visitorName, staffName, ownerEmail, visitorEmail, city, area, submitterRole
                    }).catch((err) => {
                        console.error('[visits/submit] retry dispatch failed:', err);
                    });
                });
            }
            return;
        }

        // Reply as soon as the report is durable.
        //
        // The KYC email, the superadmin email and the WhatsApp ping below are
        // each a full round-trip to an external provider, and together they ran
        // 10s+ — past the request deadline in middleware/requestDeadline.js.
        // The deadline then answered 503 ("The server took too long to
        // respond") while this handler carried on to completion, so staff saw a
        // failure for a submission that had in fact saved and mailed, and the
        // handler's own res.json() afterwards threw ERR_HTTP_HEADERS_SENT.
        //
        // Nothing below this line affects whether the visit was recorded, so
        // none of it belongs inside the request. Delivery outcome is written
        // back onto the VisitData doc instead of being reported inline — the
        // list reads kycStatus, and "Resend KYC" covers a failure.
        const requester = await resolveRequestUser(req);
        const submitterRole = String(requester?.role || (req.user && req.user.role) || '').toLowerCase();
        const isSuperAdminSubmitter = ['superadmin', 'admin'].includes(submitterRole);

        // Send owner KYC link synchronously so VisitData.kycStatus is updated to 'sent'
        // before returning 201 to the frontend, preventing 'KYC NOT SENT' race condition.
        let kycLinkSuccess = false;
        let kycErrorMsg = null;
        try {
            await sendOwnerKycLink(visit);
            kycLinkSuccess = true;
        } catch (kycErr) {
            console.warn('[visits/submit] KYC link auto-send failed:', kycErr.message);
            kycErrorMsg = kycErr.message;
            await VisitData.updateOne(
                { visitId: visit.visitId },
                { $set: { kycLinkError: kycErr.message } }
            );
        }

        const freshVisit = await VisitData.findOne({ visitId: visit.visitId }).lean();

        invalidateVisitsList();
        respondOnce(res, 201, {
            success: true,
            message: isSuperAdminSubmitter
                ? 'Visit submitted successfully by SuperAdmin.'
                : 'Visit submitted successfully and queued for SuperAdmin approval.',
            visitId: visitId,
            kycLinkSent: kycLinkSuccess,
            kycLinkError: kycErrorMsg,
            data: freshVisit || visit
        });

        runOutsideRequestBudget(() => {
            notifySuperadmin({
                type: 'new_enquiry',
                from: 'area_manager',
                subject: `New Visit Submission - ${propertyName || 'Property'}`,
                message: 'A new visit submission is waiting for superadmin approval.',
                meta: {
                    enquiryId: visit.visitId,
                    userName: ownerName || visitorName || staffName || '',
                    userEmail: ownerEmail || visitorEmail || '',
                    propertyName: propertyName || '',
                    city: city || '',
                    area: area || ''
                }
            }).catch(err => console.warn('visit submit notification failed:', err.message));
        });

    } catch (error) {
        console.error('Error submitting visit:', error);
        respondOnce(res, 500, {
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
// GET: Get a single visit by ID (Scoped for employees)
// ============================================================
router.get('/:visitId', protect, applyEmployeeScope, requireVisitInScope('visitId'), async (req, res) => {
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

        invalidateVisitsList();
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
router.put('/:visitId', protect, authorize('employee', 'manager', 'areamanager', 'superadmin', 'owner', 'tenant', 'website_user', 'user'), async (req, res) => {
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
