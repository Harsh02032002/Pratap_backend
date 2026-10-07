'use strict';
// Agreement expiry → one-month notice → owner-initiated extension workflow.
//
//   ACTIVE ──(1 calendar month before expiry)──► NOTICE
//     NOTICE: automatic reminder email (no link), once per agreement cycle
//     NOTICE: owner clicks "Extend Agreement" (= owner consent) → request email
//             with the Digital KYC extension link (signed token)
//     tenant re-verifies Aadhaar → signs → extension COMPLETED → PDF
//             "AGREEMENT EXTENSION #n" emailed to tenant and owner
//   expiry day with no completed extension → open request EXPIRED, tenant fully
//   exited via moveoutService.completeMoveout (bed freed, login revoked, comms stop)
//
// The original agreement (digitalCheckin.agreement / agreementDetails / its PDF)
// is never modified. Extensions are appended to tenant.agreementExtensions.

const jwt = require('jsonwebtoken');
const Tenant = require('../models/Tenant');
const Owner = require('../models/Owner');
const Notification = require('../models/Notification');
const { sendMail } = require('../utils/mailer');
const cloudinary = require('../utils/cloudinary');
const { completeMoveout, isOnNotice } = require('./moveoutService');
const {
    addCalendarMonths, todayIST, getAgreementCycle, formatDisplayDate
} = require('../utils/agreementDates');

const TOKEN_PURPOSE = 'agreement_extension';
const MAX_EXTENSION_MONTHS = 60;

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

const isExited = (tenant) => tenant.status !== 'active' || !!tenant.moveoutRequest?.completedAt || tenant.isDeleted;

// Tenants already past expiry when this workflow went live were never "watched"
// before their end date. They are not auto-exited; the owner decides.
const isLegacyExpired = (tenant, cycle) =>
    cycle.phase === 'expired' && tenant.agreementLifecycle?.watchedEndDate !== cycle.endDate;

/** Owner-facing summary of where the tenant sits in the expiry cycle. */
function buildCycleSummary(tenant, today = todayIST()) {
    const cycle = getAgreementCycle(tenant, today);
    if (!cycle) return null;
    const extensions = (tenant.agreementExtensions || []).map((e) => ({
        number: e.number,
        status: e.status,
        months: e.months,
        previousStartDate: e.previousStartDate,
        previousEndDate: e.previousEndDate,
        newStartDate: e.newStartDate,
        newEndDate: e.newEndDate,
        requestedAt: e.requestedAt,
        tenantSignedAt: e.tenantSignedAt,
        completedAt: e.completedAt,
        pdfUrl: e.pdfUrl || ''
    }));
    const legacyExpired = isLegacyExpired(tenant, cycle);
    let blockedReason = '';
    if (isExited(tenant)) blockedReason = 'Tenant is not active';
    else if (isOnNotice(tenant)) blockedReason = 'Tenant is serving a move-out notice';
    else if (cycle.pendingExtension) blockedReason = 'An extension request is already waiting for the tenant';
    else if (cycle.phase === 'active') blockedReason = `Extension opens on ${formatDisplayDate(cycle.noticeStartDate)}`;
    else if (cycle.phase === 'expired' && !legacyExpired) blockedReason = 'Agreement has expired';
    return {
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        noticeStartDate: cycle.noticeStartDate,
        daysLeft: cycle.daysLeft,
        phase: cycle.phase,
        legacyExpired,
        reminderSentAt: tenant.agreementLifecycle?.reminderSentForEndDate === cycle.endDate
            ? tenant.agreementLifecycle.reminderSentAt : null,
        pendingExtension: cycle.pendingExtension
            ? extensions.find((e) => e.number === cycle.pendingExtension.number) : null,
        lastCompletedExtension: [...extensions].reverse().find((e) => e.status === 'completed') || null,
        extensions,
        canExtend: !blockedReason,
        blockedReason
    };
}

// ── Links ────────────────────────────────────────────────────────────────────

function signExtensionToken(tenant, ext) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET missing');
    // Valid until the new period ends at the latest; the real cut-off (expiry of
    // the current agreement) is enforced from the stored status on every use.
    const expSeconds = Math.floor(Date.parse(`${ext.newEndDate}T00:00:00+05:30`) / 1000);
    return jwt.sign(
        { loginId: tenant.loginId, ext: ext.number, purpose: TOKEN_PURPOSE, exp: expSeconds },
        secret
    );
}

function buildExtensionLink(origin, tenant, ext) {
    const base = String(origin || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${base}/digital-checkin/tenantkyc?loginId=${encodeURIComponent(tenant.loginId)}&ext=${encodeURIComponent(signExtensionToken(tenant, ext))}`;
}

/**
 * Resolves an extension link token to { tenant, ext }. Throws 4xx errors with
 * tenant-readable messages when the link is invalid, used or expired.
 */
async function resolveExtensionToken(token, { loginId } = {}) {
    let payload;
    try {
        payload = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    } catch (_) {
        throw httpError(401, 'This extension link is invalid or has expired.');
    }
    if (payload.purpose !== TOKEN_PURPOSE) throw httpError(401, 'This extension link is invalid.');
    if (loginId && String(loginId).toUpperCase() !== String(payload.loginId).toUpperCase()) {
        throw httpError(401, 'This extension link does not belong to this tenant.');
    }
    const tenant = await Tenant.findOne({ loginId: String(payload.loginId).toUpperCase() });
    if (!tenant) throw httpError(404, 'Tenant not found.');
    const ext = (tenant.agreementExtensions || []).find((e) => e.number === payload.ext);
    if (!ext) throw httpError(404, 'Extension request not found.');
    return { tenant, ext };
}

/** True while the tenant may still complete this extension. */
function isExtensionOpen(tenant, ext, today = todayIST()) {
    if (ext.status !== 'requested' || isExited(tenant)) return false;
    // Link dies at expiry (agreed rule). Requests raised for an agreement that
    // had already expired before go-live (legacy) stay open until the proposed
    // period would end, since there is no notice period left to honour.
    return ext.legacy ? today < ext.newEndDate : today < ext.previousEndDate;
}

// ── Emails ───────────────────────────────────────────────────────────────────

function emailShell(title, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;padding:40px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dddddd;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #dddddd;"><p style="margin:0;font-size:20px;font-weight:700;color:#111111;">RoomHy</p></td></tr>
<tr><td style="padding:32px;"><h1 style="margin:0 0 16px;font-size:20px;color:#111111;">${title}</h1>${bodyHtml}</td></tr>
<tr><td style="border-top:1px solid #dddddd;padding:20px 32px;background:#f9f9f9;"><p style="margin:0;font-size:12px;color:#888888;line-height:1.8;"><strong style="color:#555555;">RoomHy Support Team</strong><br>Email: support@roomhy.com | Website: www.roomhy.com<br>&copy; ${new Date().getFullYear()} RoomHy. All rights reserved.</p></td></tr>
</table></td></tr></table></body></html>`;
}

const p = (html) => `<p style="margin:0 0 14px;font-size:14px;color:#555555;line-height:1.7;">${html}</p>`;
const where = (tenant) => `<strong>${tenant.propertyTitle || 'your property'}</strong>${tenant.roomNo ? `, Room ${tenant.roomNo}` : ''}`;

async function sendAutomaticReminder(tenant, cycle) {
    if (!tenant.email) return false;
    const end = formatDisplayDate(cycle.endDate);
    const html = emailShell('Your agreement is coming up for renewal', [
        p(`Dear <strong>${tenant.name || 'Tenant'}</strong>,`),
        p(`This is a friendly reminder that your current agreement for ${where(tenant)} runs until <strong>${end}</strong> — ${cycle.daysLeft} days from today.`),
        p('If you would like to stay on, your property owner can send you an agreement extension. You will receive a separate email with the details when they do.'),
        p('There is nothing you need to do right now.')
    ].join(''));
    const text = `Dear ${tenant.name || 'Tenant'},\n\nYour current agreement for ${tenant.propertyTitle || 'your property'} runs until ${end} (${cycle.daysLeft} days from today).\n\nIf you would like to stay on, your property owner can send you an agreement extension. You will receive a separate email when they do. There is nothing you need to do right now.\n\nRoomHy Support Team`;
    return sendMail(tenant.email, `Your agreement ends on ${end}`, text, html);
}

async function sendExtensionRequestEmail(tenant, ext, link) {
    const prev = `${formatDisplayDate(ext.previousStartDate)} – ${formatDisplayDate(ext.previousEndDate)}`;
    const next = `${formatDisplayDate(ext.newStartDate)} – ${formatDisplayDate(ext.newEndDate)}`;
    const html = emailShell('Your owner has requested an agreement extension', [
        p(`Dear <strong>${tenant.name || 'Tenant'}</strong>,`),
        p(`Your property owner would like to extend your agreement for ${where(tenant)} by <strong>${ext.months} month${ext.months === 1 ? '' : 's'}</strong>.`),
        p(`<strong>Current agreement:</strong> ${prev}<br><strong>Proposed extension:</strong> ${next}`),
        p('To accept, re-verify your Aadhaar and sign the extension using the link below.'),
        `<table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#111111;"><a href="${link}" style="display:inline-block;color:#ffffff;text-decoration:none;padding:13px 28px;font-size:14px;font-weight:600;">Review &amp; Sign Extension</a></td></tr></table>`,
        `<p style="margin:20px 0 0;font-size:12px;color:#888888;">This link works until ${formatDisplayDate(ext.previousEndDate)} if your current agreement has not ended yet. Please do not share it.<br><span style="color:#333333;word-break:break-all;">${link}</span></p>`
    ].join(''));
    const text = `Dear ${tenant.name || 'Tenant'},\n\nYour property owner would like to extend your agreement by ${ext.months} month(s).\nCurrent agreement: ${prev}\nProposed extension: ${next}\n\nReview and sign: ${link}\n\nRoomHy Support Team`;
    return sendMail(tenant.email, `Agreement extension request — ${tenant.propertyTitle || 'RoomHy'}`, text, html);
}

async function notify(toLoginId, title, message) {
    if (!toLoginId) return;
    await Notification.create({ toLoginId, from: 'system', type: 'system', title, message, meta: { title, message }, read: false })
        .catch((e) => console.error('[AGREEMENT] notification failed:', e.message));
}

// ── Owner: request an extension ──────────────────────────────────────────────

async function requestExtension(tenantId, { months, actorLoginId, actorRole, origin }) {
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EXTENSION_MONTHS) {
        throw httpError(400, `Extension must be a whole number of months between 1 and ${MAX_EXTENSION_MONTHS}.`);
    }
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw httpError(404, 'Tenant not found');
    if (!tenant.email) throw httpError(400, 'Tenant email address is missing');
    const summary = buildCycleSummary(tenant);
    if (!summary) throw httpError(400, 'This tenant has no agreement dates on record.');
    if (!summary.canExtend) throw httpError(409, summary.blockedReason);

    const number = (tenant.agreementExtensions || []).reduce((m, e) => Math.max(m, e.number || 0), 0) + 1;
    const now = new Date();
    const ext = {
        number,
        status: 'requested',
        months: n,
        previousStartDate: summary.startDate,
        previousEndDate: summary.endDate,
        newStartDate: summary.endDate,
        newEndDate: addCalendarMonths(summary.endDate, n),
        requestedAt: now,
        requestedBy: actorLoginId || '',
        requestedByRole: actorRole || '',
        ownerConfirmedAt: now,
        legacy: summary.legacyExpired
    };

    // Atomic guard: only one open request per agreement cycle, even when the
    // owner double-clicks or two staff members act at once.
    const updated = await Tenant.findOneAndUpdate(
        {
            _id: tenant._id,
            agreementExtensions: { $not: { $elemMatch: { status: 'requested', previousEndDate: summary.endDate } } },
            'agreementExtensions.number': { $ne: number }
        },
        { $push: { agreementExtensions: ext } },
        { new: true }
    );
    if (!updated) throw httpError(409, 'An extension request is already waiting for the tenant');

    const saved = updated.agreementExtensions.find((e) => e.number === number);
    const link = buildExtensionLink(origin, updated, saved);
    const sent = await sendExtensionRequestEmail(updated, saved, link);
    if (sent) {
        await Tenant.updateOne({ _id: updated._id, 'agreementExtensions.number': number }, { $set: { 'agreementExtensions.$.requestEmailSentAt': new Date() } });
    }
    await notify(updated.loginId, 'Agreement extension requested', `Your owner has proposed a ${n}-month extension (${formatDisplayDate(saved.newStartDate)} – ${formatDisplayDate(saved.newEndDate)}). Check your email to review and sign.`);
    return { tenant: updated, extension: saved, emailSent: Boolean(sent), link };
}

/** Re-sends the request email for the open request. Never creates a new request. */
async function resendExtensionRequest(tenantId, { origin }) {
    const tenant = await Tenant.findById(tenantId);
    if (!tenant) throw httpError(404, 'Tenant not found');
    const ext = (tenant.agreementExtensions || []).find((e) => e.status === 'requested');
    if (!ext || !isExtensionOpen(tenant, ext)) throw httpError(409, 'There is no open extension request to resend.');
    const link = buildExtensionLink(origin, tenant, ext);
    const sent = await sendExtensionRequestEmail(tenant, ext, link);
    return { emailSent: Boolean(sent), link };
}

// ── Tenant: view + sign ──────────────────────────────────────────────────────

function publicExtensionView(tenant, ext) {
    return {
        loginId: tenant.loginId,
        tenantName: tenant.name,
        propertyTitle: tenant.propertyTitle || '',
        roomNo: tenant.roomNo || '',
        number: ext.number,
        status: ext.status,
        months: ext.months,
        previousStartDate: ext.previousStartDate,
        previousEndDate: ext.previousEndDate,
        newStartDate: ext.newStartDate,
        newEndDate: ext.newEndDate,
        open: isExtensionOpen(tenant, ext),
        requiresKyc: !kycReverifiedFor(tenant, ext)
    };
}

// The extension reuses the existing Aadhaar KYC: the tenant must re-verify
// after the request was raised before they can sign.
function kycReverifiedFor(tenant, ext) {
    const times = [tenant.kyc?.otpVerifiedAt, tenant.kyc?.digilockerVerifiedAt]
        .filter(Boolean).map((d) => new Date(d).getTime());
    return times.length > 0 && Math.max(...times) >= new Date(ext.requestedAt).getTime();
}

async function signExtension({ token, loginId, eSignName, accepted, signatureDataUrl }) {
    if (!eSignName || accepted !== true || !signatureDataUrl) {
        throw httpError(400, 'Agreement acceptance, e-sign, and tenant signature are required');
    }
    const { tenant, ext } = await resolveExtensionToken(token, { loginId });
    if (ext.status === 'completed') throw httpError(409, 'This extension has already been signed.');
    if (!isExtensionOpen(tenant, ext)) throw httpError(410, 'This extension request is no longer open. Please contact your property owner.');
    if (tenant.kycStatus === 'mismatch_review') {
        throw httpError(400, 'Data mismatch detected. Please check if you have uploaded the correct Aadhaar Card. If you are still facing a data mismatch issue, please contact your property owner.');
    }
    if (!kycReverifiedFor(tenant, ext)) throw httpError(400, 'Please re-verify your Aadhaar before signing the extension.');

    const now = new Date();
    // Atomic: only a still-open request can complete, so a double submit cannot
    // send two sets of completion emails.
    const updated = await Tenant.findOneAndUpdate(
        { _id: tenant._id, agreementExtensions: { $elemMatch: { number: ext.number, status: 'requested' } } },
        { $set: {
            'agreementExtensions.$.status': 'completed',
            'agreementExtensions.$.tenantSignedAt': now,
            'agreementExtensions.$.tenantESignName': eSignName,
            'agreementExtensions.$.tenantSignatureDataUrl': signatureDataUrl,
            'agreementExtensions.$.completedAt': now
        } },
        { new: true }
    );
    if (!updated) throw httpError(409, 'This extension has already been signed.');
    const done = updated.agreementExtensions.find((e) => e.number === ext.number);

    // PDF + emails in the background, mirroring completeTenantAgreementAndNotify.
    finalizeExtensionDocuments(updated, done).catch((e) => console.error('[AGREEMENT EXTENSION] finalize error:', e.message));
    return publicExtensionView(updated, done);
}

async function finalizeExtensionDocuments(tenant, ext) {
    const { generateTenantAgreementPdfBuffer } = require('./tenantOnboardingService');
    const pdf = await generateTenantAgreementPdfBuffer(tenant, {}, {
        duration: `${ext.months} Months`,
        licenseStartDate: ext.newStartDate,
        licenseEndDate: ext.newEndDate,
        signatureDataUrl: ext.tenantSignatureDataUrl,
        eSignName: ext.tenantESignName,
        signedDate: todayIST(ext.tenantSignedAt),
        extension: { number: ext.number, previousStartDate: ext.previousStartDate, previousEndDate: ext.previousEndDate, months: ext.months }
    });

    let pdfUrl = '';
    try {
        // Separate public_id — the original agreement PDF is never overwritten.
        const up = await cloudinary.uploader.upload(`data:application/pdf;base64,${pdf.toString('base64')}`, {
            folder: 'roomhy/agreements',
            resource_type: 'raw',
            public_id: `agreement-${tenant.loginId}-extension-${ext.number}`,
            overwrite: false,
            use_filename: false
        });
        pdfUrl = up.secure_url;
    } catch (e) {
        console.error('[AGREEMENT EXTENSION] PDF upload error:', e.message);
    }

    const filename = `RoomHy-Agreement-Extension-${ext.number}-${tenant.loginId}.pdf`;
    const attachments = [{ filename, content: pdf, contentType: 'application/pdf' }];
    const period = `${formatDisplayDate(ext.newStartDate)} – ${formatDisplayDate(ext.newEndDate)}`;

    if (tenant.email) {
        await sendMail(tenant.email, `Agreement Extension #${ext.number} completed — ${tenant.propertyTitle || 'RoomHy'}`,
            `Dear ${tenant.name || 'Tenant'}, your agreement extension (${period}) is complete. The signed document is attached.`,
            emailShell(`Agreement Extension #${ext.number} completed`, [
                p(`Dear <strong>${tenant.name || 'Tenant'}</strong>,`),
                p(`Your agreement for ${where(tenant)} has been extended by <strong>${ext.months} month${ext.months === 1 ? '' : 's'}</strong>: <strong>${period}</strong>.`),
                p('The signed extension agreement is attached. Your original agreement remains on record.')
            ].join('')),
            { attachments }).catch((e) => console.error('[AGREEMENT EXTENSION] tenant email error:', e.message));
    }

    const owner = tenant.ownerLoginId ? await Owner.findOne({ loginId: String(tenant.ownerLoginId).toUpperCase() }).lean() : null;
    if (owner?.email) {
        await sendMail(owner.email, `Agreement Extension #${ext.number} signed — ${tenant.name}`,
            `${tenant.name} has signed Agreement Extension #${ext.number} (${period}). The signed document is attached.`,
            emailShell(`Agreement Extension #${ext.number} signed`, [
                p(`Dear <strong>${owner.name || owner.profile?.name || 'Owner'}</strong>,`),
                p(`<strong>${tenant.name}</strong> (${where(tenant)}) has signed the agreement extension you requested.`),
                p(`<strong>New period:</strong> ${period}`),
                p('The signed extension agreement is attached.')
            ].join('')),
            { attachments }).catch((e) => console.error('[AGREEMENT EXTENSION] owner email error:', e.message));
    }
    await notify(tenant.ownerLoginId, `Agreement extended — ${tenant.name}`, `Agreement Extension #${ext.number} is complete: ${period}.`);

    await Tenant.updateOne({ _id: tenant._id, 'agreementExtensions.number': ext.number }, { $set: {
        'agreementExtensions.$.completionEmailSentAt': new Date(),
        ...(pdfUrl && { 'agreementExtensions.$.pdfUrl': pdfUrl })
    } });
}

// ── Daily job ────────────────────────────────────────────────────────────────

/**
 * Idempotent: every state change is a conditional update keyed by the
 * agreement's end date, so re-running (same day, catch-up after downtime, or
 * two server instances) never sends a second reminder or exits twice.
 */
async function runAgreementExpiryJob(now = new Date()) {
    const today = todayIST(now);
    const stats = { reminders: 0, expiredRequests: 0, exited: 0 };
    const tenants = await Tenant.find({
        status: 'active',
        isDeleted: { $ne: true },
        'moveoutRequest.completedAt': null
    });

    for (const tenant of tenants) {
        try {
            const cycle = getAgreementCycle(tenant, today);
            if (!cycle) continue;
            const { endDate } = cycle;

            if (cycle.phase !== 'expired') {
                if (tenant.agreementLifecycle?.watchedEndDate !== endDate) {
                    await Tenant.updateOne({ _id: tenant._id }, { $set: { 'agreementLifecycle.watchedEndDate': endDate } });
                }
                if (cycle.phase === 'notice' && !isOnNotice(tenant)) {
                    const claimed = await Tenant.updateOne(
                        { _id: tenant._id, 'agreementLifecycle.reminderSentForEndDate': { $ne: endDate } },
                        { $set: { 'agreementLifecycle.reminderSentForEndDate': endDate, 'agreementLifecycle.reminderSentAt': now } }
                    );
                    if (claimed.modifiedCount === 1) {
                        await sendAutomaticReminder(tenant, cycle).catch((e) => console.error('[AGREEMENT] reminder email error:', e.message));
                        await notify(tenant.ownerLoginId, `Agreement ending — ${tenant.name}`,
                            `${tenant.name} (Room ${tenant.roomNo || 'N/A'}) — agreement ends ${formatDisplayDate(endDate)}. You can extend it from Tenants.`);
                        stats.reminders++;
                    }
                }
                continue;
            }

            // Expired, never watched before expiry → legacy, leave to the owner.
            if (isLegacyExpired(tenant, cycle)) continue;

            // Legacy requests are excluded: they were raised after expiry on purpose.
            const expired = await Tenant.updateOne(
                { _id: tenant._id },
                { $set: { 'agreementExtensions.$[e].status': 'expired', 'agreementExtensions.$[e].expiredAt': now } },
                { arrayFilters: [{ 'e.status': 'requested', 'e.previousEndDate': endDate, 'e.legacy': { $ne: true } }] }
            );
            if (expired.modifiedCount) stats.expiredRequests++;

            tenant.agreementLifecycle = { ...(tenant.agreementLifecycle?.toObject?.() || tenant.agreementLifecycle || {}), expiredExitForEndDate: endDate, expiredExitAt: now };
            tenant.moveoutRequest = tenant.moveoutRequest || {};
            if (!tenant.moveoutRequest.reason) tenant.moveoutRequest.reason = 'Agreement expired without extension';
            if (await completeMoveout(tenant)) {
                stats.exited++;
                await notify(tenant.ownerLoginId, `Agreement expired — ${tenant.name}`,
                    `${tenant.name} (Room ${tenant.roomNo || 'N/A'}) — the agreement ended on ${formatDisplayDate(endDate)} without an extension. The tenant has been moved to ex-tenants and the bed is free.`);
            }
        } catch (err) {
            console.error(`[AGREEMENT] job error for ${tenant.loginId}:`, err.message);
        }
    }
    try { require('./tenantCommsGuard').clearCommsGuardCache(); } catch (_) { }
    return stats;
}

module.exports = {
    MAX_EXTENSION_MONTHS,
    buildCycleSummary,
    requestExtension,
    resendExtensionRequest,
    resolveExtensionToken,
    publicExtensionView,
    kycReverifiedFor,
    isExtensionOpen,
    signExtension,
    runAgreementExpiryJob
};
