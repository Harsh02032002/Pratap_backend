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

const Employee  = require('../models/Employee');
const AuditLog  = require('../models/AuditLog');

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
  // If req.user is missing but Authorization header exists, attempt auto-resolution
  if (!req.user && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
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

    // Query visit reports submitted/added by this employee to grant scope on visit-added properties
    let visitPropNames = [];
    let visitOwnerIds = [];
    let visitIds = [];
    let visitPropObjectIds = [];
    try {
      const VisitData = require('../models/VisitData');
      const VisitReport = require('../models/VisitReport');
      const empLoginId = String(emp.loginId || '').trim();
      const empIdStr = String(emp._id || '').trim();

      const [myVisits, myVisitReports] = await Promise.all([
        VisitData.find({
          $or: [
            { staffId: empLoginId },
            { submittedByLoginId: empLoginId },
            { submittedBy: empLoginId },
            { submittedById: empIdStr },
            { staffId: empIdStr }
          ]
        }).select('visitId propertyName ownerLoginId generatedCredentials').lean(),
        VisitReport.find({
          $or: [
            { areaManager: emp._id },
            { 'ownerInfo.phone': emp.phone || '' },
            { 'ownerInfo.email': emp.email || '' }
          ]
        }).select('_id propertyInfo ownerInfo generatedCredentials property').lean()
      ]);

      visitPropNames = [
        ...myVisits.map(v => v.propertyName).filter(Boolean),
        ...myVisitReports.map(vr => vr.propertyInfo?.name).filter(Boolean)
      ];
      visitOwnerIds = [
        ...myVisits.map(v => v.ownerLoginId || v.generatedCredentials?.loginId).filter(Boolean),
        ...myVisitReports.map(vr => vr.generatedCredentials?.loginId).filter(Boolean)
      ];
      visitIds = [
        ...myVisits.map(v => v.visitId).filter(Boolean),
        ...myVisitReports.map(vr => String(vr._id)).filter(Boolean)
      ];
      visitPropObjectIds = myVisitReports.map(vr => vr.property).filter(Boolean);
    } catch (vErr) {
      console.warn('[employeeScope] VisitData/VisitReport scope resolution warning:', vErr.message);
    }

    const mergedAssignedProps = [...(emp.assignedProperties || []), ...visitPropObjectIds];

    req.employeeScope = {
      isEmployee:         true,
      employeeId:         emp._id,
      loginId:            emp.loginId,
      city:               emp.city               || '',
      area:               emp.area               || '',
      areaCode:           emp.areaCode           || '',
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
