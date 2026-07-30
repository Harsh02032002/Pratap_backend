/**
 * permissionKeys.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all Employee permission strings.
 * Import from here — never hardcode permission strings in routes/controllers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Top-Level Module Access Keys ────────────────────────────────────────────
// Stored in Employee.permissions[] — controls which panel sections are accessible
const MODULE_KEYS = {
  DASHBOARD:           'dashboard',
  HOME:                'home',
  USER_MANAGEMENT:     'user_management',
  PROPERTY_MANAGEMENT: 'property_management',
  CHAT_MANAGEMENT:     'chat_management',
  VISITS:              'visits',
  REPORT_ANALYTICS:    'report_analytics',
  BOOKING_LEADS:       'booking_leads',
  REVIEW:              'review',
  SUPPORT:             'support',
};

// ─── Superadmin-Only Modules ──────────────────────────────────────────────────
// These are NEVER shown or granted to employees
const SUPERADMIN_ONLY_MODULES = [
  'accounting',
  'crm',
  'subscription_control',
  'settings',
];

// ─── Restricted Sub-Module Keys ───────────────────────────────────────────────
// Stored in Employee.restrictedModules[]
// CHECKED in UI = present in this array = employee CANNOT access
// UNCHECKED in UI = NOT in this array = employee CAN access
const RESTRICTED_KEYS = {
  // Dashboard
  DASHBOARD_REVENUE:      'dashboard_revenue',
  DASHBOARD_ANALYTICS:    'dashboard_analytics',

  // User Management
  UM_TEAM_MANAGEMENT:     'um_team_management',
  UM_ROLES_PERMISSIONS:   'um_roles_permissions',
  UM_ATTENDANCE:          'um_attendance',
  UM_EMPLOYEE_MANAGEMENT: 'um_employee_management',
  UM_CREATE_USER:         'um_create_user',
  UM_EDIT_USER:           'um_edit_user',
  UM_DELETE_USER:         'um_delete_user',

  // Property Management
  PM_APPROVE:             'pm_approve',
  PM_REJECT:              'pm_reject',
  PM_EMP_APPROVAL:        'pm_emp_approval',
  PM_CATEGORIES:          'pm_categories',
  PM_DELETE:              'pm_delete',
  PM_PERMANENT:           'pm_permanent',

  // Chat Management
  CHAT_ALERTS:            'chat_alerts',
  CHAT_VIOLATIONS:        'chat_violations',

  // Reports
  RPT_REVENUE:            'rpt_revenue',
  RPT_GROWTH:             'rpt_growth',
  RPT_STAFF:              'rpt_staff',
  RPT_COMPANY:            'rpt_company',

  // Bookings
  BK_CONVERSION:          'bk_conversion',
  BK_LOCATIONS:           'bk_locations',
  BK_REVENUE:             'bk_revenue',

  // Reviews
  RV_MODERATION:          'rv_moderation',
  RV_ANALYTICS:           'rv_analytics',
  RV_FEED:                'rv_feed',

  // Support
  SP_VERIFICATION:        'sp_verification',
  SP_RESOLUTION:          'sp_resolution',
};

// ─── Default Restricted Modules ───────────────────────────────────────────────
// All restricted modules are blocked by default for new employees.
// Superadmin can selectively unblock by removing keys from this list.
const DEFAULT_RESTRICTED_MODULES = Object.values(RESTRICTED_KEYS);

// ─── Employee Types ───────────────────────────────────────────────────────────
const EMPLOYEE_TYPES = [
  'Field Executive',
  'Area Manager',
  'Marketing Executive',
  'Verification Officer',
];

// ─── Roles that REQUIRE assignedProperties to be non-empty ───────────────────
const ROLES_REQUIRING_ASSIGNED_PROPERTIES = [
  'Field Executive',
  'Verification Officer',
];

// ─── Flat list of all valid module keys (for validation) ─────────────────────
const ALL_MODULE_KEYS = Object.values(MODULE_KEYS);

// ─── Flat list of all valid restricted keys (for validation) ─────────────────
const ALL_RESTRICTED_KEYS = Object.values(RESTRICTED_KEYS);

module.exports = {
  MODULE_KEYS,
  SUPERADMIN_ONLY_MODULES,
  RESTRICTED_KEYS,
  DEFAULT_RESTRICTED_MODULES,
  EMPLOYEE_TYPES,
  ROLES_REQUIRING_ASSIGNED_PROPERTIES,
  ALL_MODULE_KEYS,
  ALL_RESTRICTED_KEYS,
};
