/**
 * scopeHelpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable filter-builder functions for area-scoped data isolation.
 *
 * Every controller imports from here. Zero duplicate filter logic.
 * All helpers read from req.employeeScope (built by applyEmployeeScope middleware).
 *
 * If req.employeeScope.isEmployee === false → returns baseFilter unchanged
 * (superadmins/owners get unscoped access).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');
const { normalizeLoginId, escapeRegex } = require('./normalizeId');

/**
 * Index-eligible candidate list for an identifier used in a scope filter.
 *
 * These filters are `$or` branches that decide what a staff member can see, so
 * a branch that stops matching silently hides their data. The previous
 * `new RegExp('^' + id + '$', 'i')` form matched any casing but could not use
 * an index — and because an `$or` is only index-eligible when EVERY branch is,
 * a single regex branch forced the whole query to a collection scan.
 *
 * Returning both the canonical (uppercase) form and the caller's literal input
 * keeps the previous matching behaviour for the casings that actually occur,
 * while `{ $in: [...] }` of plain strings stays index-eligible.
 */
const _idCandidates = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  return [...new Set([normalizeLoginId(raw), raw])];
};

/** Same as _idCandidates but for a list of identifiers, flattened and deduped. */
const _idListCandidates = (values) => {
  if (!Array.isArray(values)) return [];
  const out = new Set();
  for (const value of values) {
    for (const candidate of _idCandidates(value)) out.add(candidate);
  }
  return [...out];
};

/**
 * _toObjectIdArray(ids)
 * Safely converts an array of strings/ObjectIds to mongoose ObjectIds,
 * filtering out any invalid values.
 */
function _toObjectIdArray(ids = []) {
  return (ids || [])
    .map(id => {
      try {
        return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(String(id)) : null;
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

function _buildScopedPropertyOrClauses(scope) {
  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const rawAssigned = (scope.assignedProperties || []).map(String).filter(Boolean);
  const visitOwnerIds = scope.visitOwnerIds || [];
  const visitIds = scope.visitIds || [];
  const empLoginId = String(scope.loginId || '').trim();
  const empIdStr = String(scope.employeeId || '').trim();
  const orConditions = [];

  if (assignedIds.length > 0) {
    orConditions.push({ _id: { $in: assignedIds } });
    orConditions.push({ propertyId: { $in: assignedIds } });
    orConditions.push({ property_id: { $in: assignedIds.map(String) } });
    orConditions.push({ property: { $in: assignedIds } });
  }
  if (rawAssigned.length > 0) {
    orConditions.push({ propertyId: { $in: rawAssigned } });
    orConditions.push({ property_id: { $in: rawAssigned } });
    orConditions.push({ property: { $in: rawAssigned } });
  }
  if (empLoginId) {
    orConditions.push({ staffLoginId: { $in: _idCandidates(empLoginId) } });
    orConditions.push({ createdBy: { $in: _idCandidates(empLoginId) } });
    orConditions.push({ assignedToName: { $in: _idCandidates(empLoginId) } });
    if (mongoose.Types.ObjectId.isValid(empLoginId)) {
      orConditions.push({ assignedTo: new mongoose.Types.ObjectId(empLoginId) });
    }
  }
  if (empIdStr && mongoose.Types.ObjectId.isValid(empIdStr)) {
    orConditions.push({ createdBy: new mongoose.Types.ObjectId(empIdStr) });
    orConditions.push({ assignedTo: new mongoose.Types.ObjectId(empIdStr) });
  }
  if (visitIds.length > 0) {
    orConditions.push({ visitId: { $in: visitIds } });
  }
  if (visitOwnerIds.length > 0) {
    const ownerIds = _idListCandidates(visitOwnerIds);
    orConditions.push({ ownerLoginId: { $in: ownerIds } });
    orConditions.push({ owner_id: { $in: ownerIds } });
    orConditions.push({ ownerId: { $in: ownerIds } });
    orConditions.push({ 'generatedCredentials.loginId': { $in: ownerIds } });
  }

  return orConditions;
}

function isScopedEmployee(req) {
  return !!req.employeeScope?.isEmployee;
}

function employeeBlocksRevenue(req) {
  return isScopedEmployee(req);
}

/**
 * resolveScopedPropertyContext(req)
 * Resolves all property IDs / owner login IDs in the employee's scope (async, 1 query).
 */
async function resolveScopedPropertyContext(req) {
  if (!isScopedEmployee(req)) {
    return {
      isEmployee: false,
      propertyIds: [],
      propertyIdStrings: [],
      propertyNames: [],
      ownerLoginIds: [],
      properties: [],
    };
  }

  const scope = req.employeeScope;
  const Property = require('../models/Property');
  const propFilter = applyPropertyScope(req, { isDeleted: { $ne: true } });
  const properties = await Property.find(propFilter).select('_id title ownerLoginId city area').lean();
  const propertyIds = properties.map(p => p._id);
  const propertyIdStrings = propertyIds.map(String);
  const propertyNames = [...new Set([
    ...properties.map(p => p.title).filter(Boolean),
    ...(scope.visitPropNames || []),
  ])];
  const ownerLoginIds = [...new Set([
    ...properties.map(p => String(p.ownerLoginId || '').trim()).filter(Boolean),
    ...(scope.visitOwnerIds || []).map(id => String(id).trim()).filter(Boolean),
    ...(scope.assignedOwners || []).map(id => String(id).trim()).filter(Boolean),
  ])];

  return {
    isEmployee: true,
    propertyIds,
    propertyIdStrings,
    propertyNames,
    ownerLoginIds,
    properties,
  };
}

/**
 * _scopedOrFilter(req, baseFilter, orClauses)
 * Applies employee OR-clauses; blocks all rows when scope is empty.
 * Safely merges with existing baseFilter.$or if present.
 */
function _scopedOrFilter(req, baseFilter = {}, orClauses = []) {
  if (!isScopedEmployee(req)) return { ...baseFilter };
  if (!orClauses.length) return { ...baseFilter, _id: { $exists: false } };
  if (baseFilter.$or) {
    const { $or: baseOr, ...rest } = baseFilter;
    return { ...rest, $and: [{ $or: baseOr }, { $or: orClauses }] };
  }
  return { ...baseFilter, $or: orClauses };
}

/**
 * _buildScopedResourceOrClauses(scope, { propertyIdFields, ownerIdFields, nameFields })
 * Generic OR-clause builder for property/owner scoped collections.
 */
function _buildScopedResourceOrClauses(scope, {
  propertyIdFields = ['propertyId', 'property_id', 'property'],
  ownerIdFields = ['ownerLoginId', 'owner_id', 'ownerId'],
  nameFields = ['propertyName', 'property_name'],
} = {}) {
  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const rawAssigned = (scope.assignedProperties || []).map(String).filter(Boolean);
  const visitPropNames = scope.visitPropNames || [];
  const visitOwnerIds = scope.visitOwnerIds || [];
  const orClauses = [];

  const allPropIds = [...assignedIds, ...rawAssigned];
  if (allPropIds.length > 0) {
    for (const field of propertyIdFields) {
      orClauses.push({ [field]: { $in: allPropIds } });
    }
  }
  if (visitPropNames.length > 0) {
    for (const field of nameFields) {
      orClauses.push({ [field]: { $in: visitPropNames } });
    }
  }
  if (visitOwnerIds.length > 0) {
    const ownerRegexes = _idListCandidates(visitOwnerIds);
    for (const field of ownerIdFields) {
      orClauses.push({ [field]: { $in: ownerRegexes } });
    }
  }

  return orClauses;
}

// ─── Property Filter ──────────────────────────────────────────────────────────
/**
 * applyPropertyScope(req, baseFilter)
 * Scopes properties strictly to:
 * 1. Properties explicitly assigned to the employee (assignedProperties)
 * 2. Properties created/submitted by the employee in Visit Reports (visitIds, visitPropNames, visitOwnerIds)
 * 3. Properties where staffLoginId / createdBy / assignedTo matches the employee.
 */
function applyPropertyScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const visitOwnerIds  = scope.visitOwnerIds  || [];
  const visitIds       = scope.visitIds       || [];
  const empLoginId     = String(scope.loginId || '').trim();
  const empIdStr       = String(scope.employeeId || '').trim();

  const orConditions = [];

  // 1. Explicitly assigned property ObjectIds (includes properties linked from this employee's visits)
  if (assignedIds.length > 0) {
    orConditions.push({ _id: { $in: assignedIds } });
  }

  // 2. Properties created by or assigned to this employee
  if (empLoginId) {
    orConditions.push({ staffLoginId: { $in: _idCandidates(empLoginId) } });
    orConditions.push({ createdBy: { $in: _idCandidates(empLoginId) } });
    orConditions.push({ assignedToName: { $in: _idCandidates(empLoginId) } });
    if (mongoose.Types.ObjectId.isValid(empLoginId)) {
      orConditions.push({ assignedTo: new mongoose.Types.ObjectId(empLoginId) });
    }
  }
  if (empIdStr && mongoose.Types.ObjectId.isValid(empIdStr)) {
    orConditions.push({ createdBy: new mongoose.Types.ObjectId(empIdStr) });
    orConditions.push({ assignedTo: new mongoose.Types.ObjectId(empIdStr) });
  }

  // 3. Properties created from this employee's visit reports (visitId / owner login)
  // Title/city/area matching is intentionally omitted: two properties can share a
  // name or city and that used to leak Employee B's records to Employee A.
  if (visitIds.length > 0) {
    orConditions.push({ visitId: { $in: visitIds } });
  }
  if (visitOwnerIds.length > 0) {
    const ownerIds = _idListCandidates(visitOwnerIds);
    orConditions.push({ ownerLoginId: { $in: ownerIds } });
    orConditions.push({ 'generatedCredentials.loginId': { $in: ownerIds } });
  }

  // If employee has NO assigned properties and NO visit properties, block unscoped access
  if (orConditions.length === 0) {
    return { ...baseFilter, _id: { $exists: false } };
  }

  if (baseFilter.$or) {
    const { $or: baseOr, ...rest } = baseFilter;
    return {
      ...rest,
      $and: [{ $or: baseOr }, { $or: orConditions }],
      isDeleted: false,
    };
  }

  return {
    ...baseFilter,
    $or: orConditions,
    isDeleted: false,
  };
}

// ─── Owner Filter ─────────────────────────────────────────────────────────────
/**
 * applyOwnerScope(req, baseFilter)
 * Scopes owners strictly to assigned owners or owners of visit reports submitted by this employee.
 */
function applyOwnerScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const assignedOwnerIds = _toObjectIdArray(scope.assignedOwners);
  const visitOwnerIds = scope.visitOwnerIds || [];
  const empLoginId = String(scope.loginId || '').trim();
  const empIdStr = String(scope.employeeId || '').trim();
  const orConditions = [];

  if (assignedOwnerIds.length > 0) {
    orConditions.push({ _id: { $in: assignedOwnerIds } });
  }

  if (visitOwnerIds.length > 0) {
    const ownerIds = _idListCandidates(visitOwnerIds);
    orConditions.push({ loginId: { $in: ownerIds } });
  }

  if (empLoginId) {
    orConditions.push({ createdByStaffId: { $in: _idCandidates(empLoginId) } });
    orConditions.push({ addedByStaffId: { $in: _idCandidates(empLoginId) } });
    orConditions.push({ staffId: { $in: _idCandidates(empLoginId) } });
  }

  if (empIdStr) {
    orConditions.push({ createdByStaffId: empIdStr });
    orConditions.push({ addedByStaffId: empIdStr });
  }

  if (orConditions.length === 0) {
    return { ...baseFilter, _id: { $exists: false } };
  }

  if (baseFilter.$or) {
    const { $or: baseOr, ...rest } = baseFilter;
    return { ...rest, $and: [{ $or: baseOr }, { $or: orConditions }] };
  }

  return { ...baseFilter, $or: orConditions };
}

// ─── Tenant Filter ────────────────────────────────────────────────────────────
/**
 * applyTenantScope(req, baseFilter)
 * Scopes tenants strictly to properties and owners allowed for this employee.
 */
function applyTenantScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const visitPropNames = scope.visitPropNames || [];
  const visitOwnerIds = scope.visitOwnerIds || [];
  const assignedOwnerIds = _toObjectIdArray(scope.assignedOwners);

  const orClauses = [];

  if (assignedIds.length > 0) {
    orClauses.push({ property: { $in: assignedIds } });
    orClauses.push({ propertyId: { $in: assignedIds } });
  }

  if (visitPropNames.length > 0) {
    orClauses.push({ propertyName: { $in: visitPropNames } });
  }

  if (visitOwnerIds.length > 0) {
    const ownerRegexes = _idListCandidates(visitOwnerIds);
    orClauses.push({ ownerLoginId: { $in: ownerRegexes } });
  }

  if (assignedOwnerIds.length > 0) {
    orClauses.push({ owner: { $in: assignedOwnerIds } });
  }

  if (orClauses.length === 0) {
    return { ...baseFilter, _id: { $exists: false } };
  }

  if (baseFilter.$or) {
    const { $or: baseOr, ...rest } = baseFilter;
    return { ...rest, $and: [{ $or: baseOr }, { $or: orClauses }] };
  }

  return { ...baseFilter, $or: orClauses };
}

// ─── Booking Filter ───────────────────────────────────────────────────────────
/**
 * applyBookingScope(req, baseFilter)
 * Scopes bookings and biddings strictly to properties and owners allowed for this employee.
 */
function applyBookingScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const visitPropNames = scope.visitPropNames || [];
  const visitOwnerIds = scope.visitOwnerIds || [];

  const orClauses = [];

  if (assignedIds.length > 0) {
    orClauses.push({ propertyId: { $in: assignedIds } });
    orClauses.push({ property_id: { $in: assignedIds } });
    orClauses.push({ property: { $in: assignedIds } });
  }

  if (visitPropNames.length > 0) {
    orClauses.push({ propertyName: { $in: visitPropNames } });
    orClauses.push({ property_name: { $in: visitPropNames } });
  }

  if (visitOwnerIds.length > 0) {
    const ownerRegexes = _idListCandidates(visitOwnerIds);
    orClauses.push({ ownerLoginId: { $in: ownerRegexes } });
    orClauses.push({ owner_id: { $in: ownerRegexes } });
  }

  if (orClauses.length === 0) return { ...baseFilter, _id: { $exists: false } };

  if (baseFilter.$or) {
    const { $or: baseOr, ...rest } = baseFilter;
    return { ...rest, $and: [{ $or: baseOr }, { $or: orClauses }] };
  }

  return { ...baseFilter, $or: orClauses };
}

// ─── Complaint Filter ─────────────────────────────────────────────────────────
/**
 * applyComplaintScope(req, baseFilter)
 * Priority 1: complaints directly assigned to this employee
 * Priority 2 (fallback): unassigned complaints in employee's assigned properties
 *
 * NEVER returns complaints assigned to OTHER employees.
 */
function applyComplaintScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const orClauses = _buildScopedResourceOrClauses(scope, {
    propertyIdFields: ['propertyId', 'property'],
    ownerIdFields: ['ownerLoginId'],
    nameFields: ['propertyName'],
  });

  return _scopedOrFilter(req, baseFilter, orClauses);
}

// ─── Visit Filter ─────────────────────────────────────────────────────────────
/**
 * applyVisitScope(req, baseFilter)
 * Employee can only see visits assigned to themselves.
 */
function applyVisitScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const loginIds = _idCandidates(scope.loginId);
  const empIdStr = String(scope.employeeId || '').trim();
  const orClauses = [];

  if (loginIds.length) {
    orClauses.push({ staffId: { $in: loginIds } });
    orClauses.push({ submittedByLoginId: { $in: loginIds } });
    orClauses.push({ submittedBy: { $in: loginIds } });
    orClauses.push({ submittedById: { $in: loginIds } });
  }
  if (empIdStr) {
    orClauses.push({ submittedById: empIdStr });
    orClauses.push({ assignedEmployee: scope.employeeId });
    orClauses.push({ assignedTo: scope.employeeId });
    orClauses.push({ employeeId: scope.employeeId });
  }
  if ((scope.visitIds || []).length > 0) {
    orClauses.push({ visitId: { $in: scope.visitIds } });
  }

  return _scopedOrFilter(req, baseFilter, orClauses);
}

// ─── Report Filter ────────────────────────────────────────────────────────────
/**
 * applyReportScope(req, res, restrictedKey)
 * Throws HTTP 403 BEFORE any query runs if the report sub-module is restricted.
 * Otherwise returns geo-filter for city + area.
 *
 * Usage in controller:
 *   const filter = applyReportScope(req, res, RESTRICTED_KEYS.RPT_REVENUE);
 *   if (!filter) return; // 403 already sent
 */
function applyReportScope(req, res, restrictedKey = null) {
  const scope = req.employeeScope;

  // Non-employees: no filter needed
  if (!scope || !scope.isEmployee) return {};

  // Check if this specific report is restricted — early 403 before any DB query
  if (restrictedKey && (scope.restrictedModules || []).includes(restrictedKey)) {
    res.status(403).json({
      success: false,
      message: `Access denied: report '${restrictedKey}' is restricted for your account`,
    });
    return null; // Signal to caller that response has been sent
  }

  // Return geo-scoped filter
  const filter = {};
  if (scope.city) filter.city = scope.city;
  if (scope.area) filter.area = scope.area;
  return filter;
}

// ─── Notification Filter ──────────────────────────────────────────────────────
/**
 * applyNotificationScope(req, baseFilter)
 * Only returns notifications where receiver = this employee's _id.
 * Does NOT broadcast area-wide notifications to all employees.
 */
function applyNotificationScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  return {
    ...baseFilter,
    $or: [
      { toEmployeeId: scope.employeeId },
      { toLoginId:    scope.loginId    },
      { receiver:     scope.employeeId },
    ],
  };
}

// ─── Chat Filter ──────────────────────────────────────────────────────────────
/**
 * applyChatScope(req, baseFilter)
 * Scopes chat rooms to employee's assigned properties.
 */
function applyChatScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const orClauses = _buildScopedResourceOrClauses(scope, {
    propertyIdFields: ['propertyId', 'property'],
    ownerIdFields: ['ownerLoginId', 'owner_id', 'ownerId'],
    nameFields: ['propertyName', 'property_name'],
  });

  return _scopedOrFilter(req, baseFilter, orClauses);
}

// ─── Review Filter ────────────────────────────────────────────────────────────
/**
 * applyReviewScope(req, baseFilter)
 * Scopes reviews to employee's assigned properties.
 */
function applyReviewScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const orClauses = _buildScopedResourceOrClauses(scope, {
    propertyIdFields: ['propertyId'],
    ownerIdFields: ['ownerId', 'ownerLoginId'],
    nameFields: ['propertyName'],
  });

  return _scopedOrFilter(req, baseFilter, orClauses);
}

// ─── Room Filter ──────────────────────────────────────────────────────────────
/**
 * applyRoomScope(req, baseFilter)
 * Scopes rooms strictly to properties allowed for this employee.
 */
function applyRoomScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const rawAssigned = (scope.assignedProperties || []).map(String);
  const empIdStr = String(scope.employeeId || '').trim();

  const orClauses = [];

  if (assignedIds.length > 0 || rawAssigned.length > 0) {
    orClauses.push({ property: { $in: [...assignedIds, ...rawAssigned] } });
  }

  if (empIdStr && mongoose.Types.ObjectId.isValid(empIdStr)) {
    orClauses.push({ createdBy: new mongoose.Types.ObjectId(empIdStr) });
  }

  if (orClauses.length === 0) {
    return { ...baseFilter, _id: { $exists: false } };
  }

  return { ...baseFilter, $or: orClauses };
}

// ─── Lead / Enquiry Filter ───────────────────────────────────────────────────
/**
 * applyLeadScope(req, baseFilter)
 * Scopes enquiries / website leads to employee's assigned properties / owners.
 */
function applyLeadScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const assignedIds = _toObjectIdArray(scope.assignedProperties);
  const visitPropNames = scope.visitPropNames || [];
  const visitOwnerIds = scope.visitOwnerIds || [];

  const orClauses = [];

  if (assignedIds.length > 0) {
    orClauses.push({ propertyId: { $in: assignedIds.map(String) } });
    orClauses.push({ property: { $in: assignedIds } });
  }

  if (visitOwnerIds.length > 0) {
    const ownerIds = _idListCandidates(visitOwnerIds);
    orClauses.push({ ownerLoginId: { $in: ownerIds } });
    orClauses.push({ owner_id: { $in: ownerIds } });
  }

  if (orClauses.length === 0) {
    return { ...baseFilter, _id: { $exists: false } };
  }

  return { ...baseFilter, $or: orClauses };
}

// ─── Support Ticket Filter ────────────────────────────────────────────────────
function applySupportScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const orClauses = _buildScopedResourceOrClauses(scope, {
    propertyIdFields: ['property_id'],
    ownerIdFields: ['owner_id'],
    nameFields: ['property_name'],
  });

  return _scopedOrFilter(req, baseFilter, orClauses);
}

// ─── Payment Transaction Filter ─────────────────────────────────────────────────
function applyTransactionScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const orClauses = _buildScopedResourceOrClauses(scope, {
    propertyIdFields: ['property_id', 'propertyId'],
    ownerIdFields: ['owner_id', 'ownerLoginId'],
    nameFields: ['property_name', 'propertyName'],
  });

  return _scopedOrFilter(req, baseFilter, orClauses);
}

// ─── Rent Filter ──────────────────────────────────────────────────────────────
function applyRentScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const orClauses = _buildScopedResourceOrClauses(scope, {
    propertyIdFields: ['propertyId'],
    ownerIdFields: ['ownerLoginId'],
    nameFields: ['propertyName'],
  });

  return _scopedOrFilter(req, baseFilter, orClauses);
}

function applyKycSignupScope(req, baseFilter = {}) {
  const scope = req.employeeScope;
  if (!scope || !scope.isEmployee) return { ...baseFilter };

  const ownerIds = _idListCandidates(scope.visitOwnerIds || []);
  const orClauses = [];
  if (ownerIds.length) {
    orClauses.push({ loginId: { $in: ownerIds } });
  }
  return _scopedOrFilter(req, baseFilter, orClauses);
}

/**
 * True when this VisitData document belongs to the authenticated employee.
 * Superadmin / non-employee callers are always allowed (returns true).
 */
function visitBelongsToEmployee(visit, scope) {
  if (!scope || !scope.isEmployee) return true;
  if (!visit) return false;

  const loginIds = new Set(_idCandidates(scope.loginId));
  const empId = String(scope.employeeId || '');
  const fieldValues = [
    visit.staffId,
    visit.submittedByLoginId,
    visit.submittedBy,
    visit.submittedById
  ];
  for (const value of fieldValues) {
    if (!value) continue;
    const raw = String(value);
    if (loginIds.has(raw) || loginIds.has(raw.toUpperCase()) || raw === empId) return true;
  }
  if (empId) {
    const assigned = [visit.assignedEmployee, visit.assignedTo, visit.employeeId];
    if (assigned.some((id) => id && String(id) === empId)) return true;
  }
  const visitIds = scope.visitIds || [];
  if (visit.visitId && visitIds.includes(visit.visitId)) return true;
  if (visit._id && visitIds.includes(String(visit._id))) return true;
  return false;
}

function requireOwnerInScope(paramName = 'loginId') {
  return async function (req, res, next) {
    if (!isScopedEmployee(req)) return next();
    const raw = req.params[paramName] || req.params.ownerLoginId || req.params.loginId;
    const loginId = String(raw || '').trim().toUpperCase();
    if (!loginId) {
      return res.status(404).json({ success: false, message: 'Owner not found' });
    }
    const Owner = require('../models/Owner');
    const found = await Owner.findOne(applyOwnerScope(req, {
      loginId,
      isDeleted: { $ne: true }
    })).select('_id').lean();
    if (!found) {
      return res.status(404).json({ success: false, message: 'Owner not found or access denied' });
    }
    return next();
  };
}

function requirePropertyInScope(paramName = 'id') {
  return async function (req, res, next) {
    if (!isScopedEmployee(req)) return next();
    const id = String(req.params[paramName] || '').trim();
    if (!id) {
      return res.status(404).json({ success: false, message: 'Property not found' });
    }
    const Property = require('../models/Property');
    const extra = (mongoose.Types.ObjectId.isValid(id) && id.length === 24)
      ? { $or: [{ _id: id }, { visitId: id }, { propertyId: id }] }
      : { $or: [{ visitId: id }, { propertyId: id }] };
    const found = await Property.findOne(applyPropertyScope(req, extra)).select('_id').lean();
    if (!found) {
      return res.status(404).json({ success: false, message: 'Property not found or access denied' });
    }
    return next();
  };
}

function requireVisitInScope(paramName = 'visitId') {
  return async function (req, res, next) {
    if (!isScopedEmployee(req)) return next();
    const id = String(req.params[paramName] || req.params.id || '').trim();
    if (!id) {
      return res.status(404).json({ success: false, message: 'Visit not found' });
    }
    const VisitData = require('../models/VisitData');
    const extra = (mongoose.Types.ObjectId.isValid(id) && id.length === 24)
      ? { $or: [{ _id: id }, { visitId: id }] }
      : { visitId: id };
    const found = await VisitData.findOne(applyVisitScope(req, extra)).select('_id').lean();
    if (!found) {
      return res.status(404).json({ success: false, message: 'Visit report not found or access denied' });
    }
    return next();
  };
}

module.exports = {
  isScopedEmployee,
  employeeBlocksRevenue,
  resolveScopedPropertyContext,
  applyPropertyScope,
  applyOwnerScope,
  applyTenantScope,
  applyBookingScope,
  applyComplaintScope,
  applyVisitScope,
  applyReportScope,
  applyNotificationScope,
  applyChatScope,
  applyReviewScope,
  applyRoomScope,
  applyLeadScope,
  applySupportScope,
  applyTransactionScope,
  applyRentScope,
  applyKycSignupScope,
  visitBelongsToEmployee,
  requireOwnerInScope,
  requirePropertyInScope,
  requireVisitInScope,
};

