/**
 * employeeScope.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Core Employee Security Middleware.
 *
 * Provides:
 *   applyEmployeeScope   — Builds req.employeeScope ONCE per request (1 DB fetch)
 *   checkModuleAccess    — Enforces top-level module permission
 *   checkNotRestricted   — Enforces sub-module restriction
 *   requireAssignedProps — Blocks if employee has no assigned properties
 *
 * Usage in routes:
 *   router.get('/...', protect, applyEmployeeScope, checkModuleAccess('visits'), handler);
 *
 * Superadmin / admin ALWAYS bypass all employee checks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const mongoose  = require('mongoose');
const Employee  = require('../models/Employee');
const AuditLog  = require('../models/AuditLog');
const cache     = require('../utils/cache');
const { buildCacheKey } = require('../utils/cacheKeys');

// Visit-derived scope only ever GROWS access as visits are added; the short
// TTL bounds how long a removed visit/reassignment keeps granting access.
const VISIT_SCOPE_RESOURCE = 'visit-scope';
const VISIT_SCOPE_TTL_SECONDS = 60;

const toObjectIds = (ids) => (ids || []).map((id) =>
  id instanceof mongoose.Types.ObjectId || !/^[a-f0-9]{24}$/i.test(String(id))
    ? id
    : new mongoose.Types.ObjectId(String(id)));

// Scope is visit-report based: employee → VisitData/VisitReport → property → owner.
// Do NOT match ownerInfo.phone/email to the employee — empty strings match every
// report with a blank owner phone, which leaked other employees' records.
// Throws on any DB error so a partial/empty scope is never cached.
async function resolveVisitScope(emp, staffValues) {
  const VisitData = require('../models/VisitData');
  const VisitReport = require('../models/VisitReport');
  const Property = require('../models/Property');
  const Owner = require('../models/Owner');

  const visitStaffFilter = staffValues.length
    ? {
        $or: [
          { staffId: { $in: staffValues } },
          { submittedByLoginId: { $in: staffValues } },
          { submittedBy: { $in: staffValues } },
          { submittedById: { $in: staffValues } }
        ]
      }
    : { _id: { $exists: false } };

  const [myVisits, myVisitReports] = await Promise.all([
    VisitData.find(visitStaffFilter)
      .select('visitId propertyName ownerLoginId generatedCredentials')
      .lean(),
    VisitReport.find({ areaManager: emp._id })
      .select('_id propertyInfo generatedCredentials property')
      .lean()
  ]);

  const visitPropNames = [
    ...myVisits.map(v => v.propertyName).filter(Boolean),
    ...myVisitReports.map(vr => vr.propertyInfo?.name).filter(Boolean)
  ];
  let visitOwnerIds = [
    ...myVisits.map(v => v.ownerLoginId || v.generatedCredentials?.loginId).filter(Boolean),
    ...myVisitReports.map(vr => vr.generatedCredentials?.loginId).filter(Boolean)
  ];
  const visitIds = [
    ...myVisits.map(v => v.visitId).filter(Boolean),
    ...myVisitReports.map(vr => String(vr._id)).filter(Boolean)
  ];
  let visitPropObjectIds = myVisitReports.map(vr => vr.property).filter(Boolean);

  if (visitIds.length > 0) {
    const linkedProps = await Property.find({ visitId: { $in: visitIds } })
      .select('_id ownerLoginId')
      .lean();
    visitPropObjectIds = [...visitPropObjectIds, ...linkedProps.map(p => p._id)];
    visitOwnerIds = [
      ...visitOwnerIds,
      ...linkedProps.map(p => p.ownerLoginId).filter(Boolean)
    ];
  }

  visitOwnerIds = [...new Set(visitOwnerIds.map(id => String(id).trim().toUpperCase()).filter(Boolean))];

  let ownerObjectIds = [];
  if (visitOwnerIds.length > 0) {
    const ownerDocs = await Owner.find({ loginId: { $in: visitOwnerIds } }).select('_id').lean();
    ownerObjectIds = ownerDocs.map(o => o._id);
  }

  return { visitPropNames, visitOwnerIds, visitIds, visitPropObjectIds, ownerObjectIds };
}

// ─── Internal: write access-denial audit log (non-blocking) ──────────────────
async function _denyLog(req, { reason, moduleKey = '', subModuleKey = '' }) {
  try {
    const actor = req.user || {};
    const xff   = req.headers['x-forwarded-for'];
    const ip    = Array.isArray(xff)
      ? xff[0]
      : String(xff || req.socket?.remoteAddress || '');

    await AuditLog.create({
      actorId:    actor.loginId || String(actor._id || ''),
      actorRole:  'employee',
      actorEmail: actor.email || '',
      module:     moduleKey,
      action:     `DENIED: ${req.method} ${req.originalUrl}`,
      method:     req.method,
      path:       req.originalUrl || req.path,
      statusCode: 403,
      ip:         ip.split(',')[0].trim(),
      userAgent:  String(req.headers['user-agent'] || ''),
      payload:    { reason, subModule: subModuleKey },
    });
  } catch (e) {
    console.warn('[employeeScope] Audit log write failed:', e.message);
  }
}

// ─── Helper: is the requesting user a Superadmin or Admin ────────────────────
function _isSuperAdmin(req) {
  const role = String(req.user?.role || '').toLowerCase();
  return role === 'superadmin' || role === 'admin';
}

// ─── Helper: is the requesting user a field employee ─────────────────────────
function _isEmployee(req) {
  if (!req.user) return false;
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'superadmin' || role === 'admin') return false;
  const employeeRoles = ['employee', 'manager', 'areamanager', 'staff', 'verification_officer', 'field_executive'];
  return employeeRoles.includes(role) || !!req.user.employeeId || !!req.user.team;
}

/**
 * applyEmployeeScope
 * ──────────────────
 * Attaches req.employeeScope to the request. Loads the Employee record ONCE
 * from DB and caches it on the request — downstream controllers reuse it.
 *
 * For non-employees: req.employeeScope = { isEmployee: false }
 * For employees:     req.employeeScope = { isEmployee: true, employeeId, city,
 *                      area, cityId, areaId, assignedProperties, assignedOwners,
 *                      permissions, restrictedModules, employeeType }
 */
async function applyEmployeeScope(req, res, next) {
  // If req.user is missing but Authorization header exists, attempt auto-resolution.
  // Never fall back to a hardcoded secret — with JWT_SECRET unset that default
  // would let anyone forge a token. protect() refuses to run without it too.
  if (!req.user && process.env.JWT_SECRET && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      const jwt = require('jsonwebtoken');
      const User = require('../models/user');
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      let user = null;
      try { user = await User.findById(decoded.id).select('-password'); } catch (_) {}
      if (!user) {
        try { user = await Employee.findById(decoded.id).select('-password'); } catch (_) {
          user = await Employee.findOne({ loginId: String(decoded.id).toUpperCase() }).select('-password');
        }
      }
      if (user) {
        if (user.role === 'propertyowner') user.role = 'owner';
        req.user = user;
      }
    } catch (err) {
      console.warn('[employeeScope] Auto-token resolution warning:', err.message);
    }
  }

  // Non-employees: attach stub and move on
  if (!_isEmployee(req)) {
    req.employeeScope = { isEmployee: false, isSuperadmin: _isSuperAdmin(req) };
    return next();
  }

  try {
    // req.user is set by protect() — find matching Employee doc by _id, loginId, or email
    const userLoginId = req.user.loginId || '';
    const userEmail = req.user.email || '';
    
    const emp = await Employee.findOne({
      $or: [
        { _id: req.user._id },
        ...(userLoginId ? [{ loginId: userLoginId }] : []),
        ...(userEmail ? [{ email: userEmail }] : [])
      ]
    }).select('-password').lean() || req.user;

    // Scope is visit-report based: employee → VisitData/VisitReport → property → owner.
    // Do NOT match ownerInfo.phone/email to the employee — empty strings match every
    // report with a blank owner phone, which leaked other employees' records.
    let visitPropNames = [];
    let visitOwnerIds = [];
    let visitIds = [];
    let visitPropObjectIds = [];
    try {
      const empLoginId = String(emp.loginId || '').trim();
      const empIdStr = String(emp._id || '').trim();
      const staffValues = [...new Set([
        empLoginId,
        empLoginId.toUpperCase(),
        empLoginId.toLowerCase(),
        empIdStr,
        String(emp.employeeId || '').trim()
      ].filter(Boolean))];

      // Only the visit-derived part is cached (4 queries). The Employee doc
      // above — permissions, restrictedModules, assignedProperties — is still
      // read fresh on every request, so a permission change or deactivation
      // takes effect immediately. Scope id is the DB employee _id, never a
      // client value; a missing id yields a null key → no caching.
      const visitScope = await cache.wrap(
        buildCacheKey({
          panel: 'staff',
          scopeType: 'employee',
          scopeId: emp._id,
          resource: VISIT_SCOPE_RESOURCE,
          params: { staffValues }
        }),
        VISIT_SCOPE_TTL_SECONDS,
        () => resolveVisitScope(emp, staffValues),
        { panel: 'staff', resource: VISIT_SCOPE_RESOURCE }
      );

      visitPropNames = visitScope.visitPropNames;
      visitOwnerIds = visitScope.visitOwnerIds;
      visitIds = visitScope.visitIds;
      // JSON turns ObjectIds into strings; aggregate pipelines do not cast,
      // so restore the original types.
      visitPropObjectIds = toObjectIds(visitScope.visitPropObjectIds);
      if (visitScope.ownerObjectIds.length > 0) {
        emp.assignedOwners = [...(emp.assignedOwners || []), ...toObjectIds(visitScope.ownerObjectIds)];
      }
    } catch (vErr) {
      console.warn('[employeeScope] VisitData/VisitReport scope resolution warning:', vErr.message);
    }

    const mergedAssignedProps = [...(emp.assignedProperties || []), ...visitPropObjectIds];

    req.employeeScope = {
      isEmployee:         true,
      isSuperadmin:       false,
      employeeId:         emp._id,
      loginId:            emp.loginId,
      city:               emp.city               || '',
      area:               emp.area               || '',
      areaCode:           emp.areaCode           || '',
      locationCode:       emp.locationCode       || '',
      locality:           emp.locality           || emp.area || '',
      cityId:             emp.cityId             || null,
      areaId:             emp.areaId             || null,
      assignedProperties: mergedAssignedProps,
      assignedOwners:     emp.assignedOwners     || [],
      permissions:        emp.permissions        || [],
      restrictedModules:  emp.restrictedModules  || [],
      employeeType:       emp.employeeType        || 'Field Executive',
      visitPropNames,
      visitOwnerIds,
      visitIds
    };

    return next();
  } catch (err) {
    console.error('[employeeScope] applyEmployeeScope error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal server error during scope resolution' });
  }
}

/**
 * checkModuleAccess(moduleKey)
 * ────────────────────────────
 * Returns middleware that checks top-level module permission.
 * If the employee does NOT have the module in their permissions[] → 403.
 *
 * @param {string} moduleKey  e.g. 'visits', 'property_management'
 */
function checkModuleAccess(moduleKey) {
  return async function (req, res, next) {
    // Superadmins always pass
    if (_isSuperAdmin(req)) return next();

    // Non-employees pass (their access is controlled elsewhere)
    const scope = req.employeeScope;
    if (!scope || !scope.isEmployee) return next();

    const perms = scope.permissions || [];

    if (!perms.includes(moduleKey)) {
      await _denyLog(req, {
        reason:    'Permission Missing',
        moduleKey,
        subModuleKey: '',
      });
      return res.status(403).json({
        success: false,
        message: `Access denied: you do not have permission for module '${moduleKey}'`,
      });
    }

    return next();
  };
}

/**
 * checkNotRestricted(subModuleKey)
 * ──────────────────────────────────
 * Returns middleware that blocks access if the sub-module is in restrictedModules[].
 * Executes NO DB queries — uses req.employeeScope already built by applyEmployeeScope.
 *
 * Important: fires BEFORE any query runs → improves performance + security.
 *
 * @param {string} subModuleKey  e.g. 'rpt_revenue', 'pm_approve'
 */
function checkNotRestricted(subModuleKey) {
  return async function (req, res, next) {
    // Superadmins always pass
    if (_isSuperAdmin(req)) return next();

    const scope = req.employeeScope;
    if (!scope || !scope.isEmployee) return next();

    const restricted = scope.restrictedModules || [];

    if (restricted.includes(subModuleKey)) {
      await _denyLog(req, {
        reason:       'Restricted Module',
        moduleKey:    subModuleKey.split('_')[0],
        subModuleKey,
      });
      return res.status(403).json({
        success: false,
        message: `Access denied: sub-module '${subModuleKey}' is restricted for your account`,
      });
    }

    return next();
  };
}

/**
 * requireAssignedProps()
 * ──────────────────────
 * Returns middleware that blocks the request if the employee has no
 * assignedProperties (required for Field Executives and Verification Officers).
 */
function requireAssignedProps() {
  return async function (req, res, next) {
    if (_isSuperAdmin(req)) return next();

    const scope = req.employeeScope;
    if (!scope || !scope.isEmployee) return next();

    if (!scope.assignedProperties || scope.assignedProperties.length === 0) {
      await _denyLog(req, {
        reason:    'No Assigned Properties',
        moduleKey: 'property_management',
      });
      return res.status(403).json({
        success: false,
        message: 'Access denied: no properties are assigned to your account. Contact your administrator.',
      });
    }

    return next();
  };
}

module.exports = {
  applyEmployeeScope,
  checkModuleAccess,
  checkNotRestricted,
  requireAssignedProps,
};
