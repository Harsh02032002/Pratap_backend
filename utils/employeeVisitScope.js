'use strict';

const { escapeRegex } = require('./normalizeId');

function uniqueTruthy(values = []) {
    return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function isPrivilegedVisitViewer(scopeOrUser = {}) {
    const role = String(scopeOrUser.role || '').toLowerCase();
    if (role === 'superadmin' || role === 'admin') return true;
    return scopeOrUser.isSuperadmin === true || scopeOrUser.isEmployee === false;
}

function isFieldEmployee(scopeOrUser = {}) {
    if (scopeOrUser.isEmployee === true) return true;
    const role = String(scopeOrUser.role || '').toLowerCase();
    return ['employee', 'manager', 'areamanager', 'staff', 'verification_officer', 'field_executive'].includes(role);
}

function staffIdValues(scope = {}) {
    return uniqueTruthy([
        scope.loginId,
        scope.employeeId && String(scope.employeeId),
        scope.staffId
    ]).flatMap((id) => [id, String(id).toUpperCase(), String(id).toLowerCase()]);
}

function areaValues(scope = {}) {
    return uniqueTruthy([scope.area, scope.areaCode, scope.locationCode, scope.locality]);
}

function visitMatchesEmployeeScope(visit = {}, scope = {}) {
    const ids = staffIdValues(scope);
    const visitStaff = uniqueTruthy([
        visit.staffId,
        visit.submittedByLoginId,
        visit.submittedById,
        visit.submittedBy
    ]);
    if (ids.some((id) => visitStaff.includes(id))) return true;

    const assigned = (scope.assignedProperties || []).map((id) => String(id));
    const visitPropertyIds = uniqueTruthy([
        visit.propertyId,
        visit.propertyRef,
        visit._id
    ]).map(String);
    if (assigned.some((id) => visitPropertyIds.includes(id))) return true;

    const city = String(scope.city || '').trim();
    const areas = areaValues(scope);
    if (!city || areas.length === 0) return false;

    const visitCity = String(visit.city || '').trim();
    if (!visitCity || visitCity.toLowerCase() !== city.toLowerCase()) return false;

    const visitAreas = uniqueTruthy([visit.area, visit.landmark, visit.locationCode, visit.locality]);
    return areas.some((area) =>
        visitAreas.some((visitArea) => visitArea.toLowerCase() === area.toLowerCase())
    );
}

/**
 * Mongo filter for GET /api/visits and GET /api/visits/pending.
 * Superadmin/admin: empty filter (caller decides extra status constraints).
 * Employee: assigned staff OR assigned property OR (city AND area/locality).
 */
function buildEmployeeVisitQuery(scope = {}) {
    if (!isFieldEmployee(scope) || isPrivilegedVisitViewer(scope)) return {};

    const or = [];
    const idValues = staffIdValues(scope);
    if (idValues.length) {
        or.push(
            { staffId: { $in: idValues } },
            { submittedById: { $in: idValues } },
            { submittedByLoginId: { $in: idValues } }
        );
    }

    const assigned = (scope.assignedProperties || []).filter(Boolean);
    if (assigned.length) {
        or.push({ propertyId: { $in: assigned } });
        or.push({ propertyRef: { $in: assigned } });
    }

    const city = String(scope.city || '').trim();
    const areas = areaValues(scope);
    if (city && areas.length) {
        const cityRegex = new RegExp(`^${escapeRegex(city)}$`, 'i');
        const areaOr = areas.flatMap((area) => {
            const areaRegex = new RegExp(`^${escapeRegex(area)}$`, 'i');
            return [
                { area: areaRegex },
                { landmark: areaRegex },
                { locationCode: areaRegex },
                { locality: areaRegex }
            ];
        });
        or.push({ city: cityRegex, $or: areaOr });
    }

    if (!or.length) {
        return { _id: { $exists: false } };
    }
    return { $or: or };
}

module.exports = {
    uniqueTruthy,
    isPrivilegedVisitViewer,
    isFieldEmployee,
    visitMatchesEmployeeScope,
    buildEmployeeVisitQuery
};
