'use strict';
// Calendar-date helpers for the agreement expiry / extension workflow.
//
// Everything here works on plain "YYYY-MM-DD" strings in IST so the result
// never drifts with the server's local timezone, and so "one calendar month"
// means a calendar month, not 30 days.
//
// Month arithmetic CLAMPS to the last day of the target month (agreed rule):
//   31 May  − 1 month  → 30 Apr
//   31 Mar  − 1 month  → 28/29 Feb
//   29 Feb 2028 + 12 m → 28 Feb 2029
// This matches calcNoticeEndDate() in services/moveoutService.js.

const { getISTDateString } = require('./istDate');

const DEFAULT_AGREEMENT_MONTHS = 11;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidYmd(s) {
    const m = YMD_RE.exec(String(s || '').trim());
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Adds (or subtracts) whole calendar months, clamping to the month's last day. */
function addCalendarMonths(ymd, months) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const targetIndex = (m - 1) + Number(months);
    const ty = y + Math.floor(targetIndex / 12);
    const tm = ((targetIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Whole days from `fromYmd` to `toYmd` (positive when `toYmd` is later). */
function daysBetween(fromYmd, toYmd) {
    const a = Date.parse(`${fromYmd}T00:00:00Z`);
    const b = Date.parse(`${toYmd}T00:00:00Z`);
    return Math.round((b - a) / 86400000);
}

function todayIST(now = new Date()) {
    return getISTDateString(now);
}

/** Converts a stored Date / date string to an IST "YYYY-MM-DD", or '' if unusable. */
function toYmd(value) {
    if (!value) return '';
    if (typeof value === 'string' && isValidYmd(value.trim())) return value.trim();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : getISTDateString(d);
}

function parseMonths(durationStr) {
    const m = String(durationStr || '').match(/(\d+)/);
    const n = m ? parseInt(m[1], 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

function formatDisplayDate(ymd) {
    if (!isValidYmd(ymd)) return ymd || '-';
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The tenant's current agreement period, as { startDate, endDate, source }.
 * Priority: latest completed extension → stored licenseEndDate →
 * move-in + licenseDuration → move-in + 11 months (the system's default).
 */
function resolveCurrentAgreementPeriod(tenant) {
    const extensions = Array.isArray(tenant?.agreementExtensions) ? tenant.agreementExtensions : [];
    const completed = extensions
        .filter((e) => e && e.status === 'completed' && isValidYmd(e.newEndDate))
        .sort((a, b) => (a.number || 0) - (b.number || 0));
    if (completed.length) {
        const last = completed[completed.length - 1];
        return { startDate: last.newStartDate, endDate: last.newEndDate, source: 'extension', extensionNumber: last.number };
    }

    const details = tenant?.digitalCheckin?.agreementDetails || {};
    const startDate = toYmd(details.licenseStartDate) || toYmd(tenant?.moveInDate);
    const storedEnd = toYmd(details.licenseEndDate);
    if (storedEnd) return { startDate, endDate: storedEnd, source: 'licenseEndDate' };
    if (!startDate) return null;
    const months = parseMonths(details.licenseDuration) || DEFAULT_AGREEMENT_MONTHS;
    return { startDate, endDate: addCalendarMonths(startDate, months), source: 'moveIn+duration' };
}

/**
 * Where the tenant sits in the expiry cycle on `today` (IST "YYYY-MM-DD").
 * phase: 'active' | 'notice' (within one calendar month of expiry) | 'expired'.
 */
function getAgreementCycle(tenant, today = todayIST()) {
    const period = resolveCurrentAgreementPeriod(tenant);
    if (!period) return null;
    const noticeStartDate = addCalendarMonths(period.endDate, -1);
    const daysLeft = daysBetween(today, period.endDate);
    const phase = today >= period.endDate ? 'expired' : today >= noticeStartDate ? 'notice' : 'active';
    const extensions = Array.isArray(tenant?.agreementExtensions) ? tenant.agreementExtensions : [];
    const pendingExtension = extensions.find((e) => e && e.status === 'requested' && e.previousEndDate === period.endDate) || null;
    return { ...period, noticeStartDate, daysLeft, phase, pendingExtension };
}

module.exports = {
    DEFAULT_AGREEMENT_MONTHS,
    isValidYmd,
    addCalendarMonths,
    daysBetween,
    todayIST,
    toYmd,
    parseMonths,
    formatDisplayDate,
    resolveCurrentAgreementPeriod,
    getAgreementCycle
};
