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

// ─── Default Restricted Modules for Area Operations / Field Verification Employee ───
const FIELD_VERIFICATION_RESTRICTED_MODULES = [
  // Dashboard & Home
  RESTRICTED_KEYS.DASHBOARD_REVENUE,
  RESTRICTED_KEYS.DASHBOARD_ANALYTICS,
  RESTRICTED_KEYS.HOME_REVENUE,
  RESTRICTED_KEYS.HOME_PENDING_RENT,

  // User Management
  RESTRICTED_KEYS.UM_TEAM_MANAGEMENT,
  RESTRICTED_KEYS.UM_ROLES_PERMISSIONS,
  RESTRICTED_KEYS.UM_OWNER_SUBSCRIPTIONS,
  RESTRICTED_KEYS.UM_KYC,

  // Property Management
  RESTRICTED_KEYS.PM_ADD_PROPERTY,
  RESTRICTED_KEYS.PM_APPROVE,
  RESTRICTED_KEYS.PM_LEADS,
  RESTRICTED_KEYS.PM_CATEGORIES,

  // Accounting (All)
  RESTRICTED_KEYS.ACC_OVERVIEW,
  RESTRICTED_KEYS.ACC_REVENUE_OVERVIEW,
  RESTRICTED_KEYS.ACC_PAYMENT_HISTORY,
  RESTRICTED_KEYS.ACC_OWNER_PAYOUTS,
  RESTRICTED_KEYS.ACC_REFUNDS,
  RESTRICTED_KEYS.ACC_ROOMHY_REVENUE,
  RESTRICTED_KEYS.ACC_OWNER_REVENUE,
  RESTRICTED_KEYS.ACC_PROFIT_LOSS,
  RESTRICTED_KEYS.ACC_CASHFLOW,

  // Chat Management
  RESTRICTED_KEYS.CHAT_ALERTS,

  // Reports
  RESTRICTED_KEYS.RPT_LOCATIONS,
  RESTRICTED_KEYS.RPT_OCCUPANCY,
  RESTRICTED_KEYS.RPT_GROWTH,
  RESTRICTED_KEYS.RPT_STAFF,
  RESTRICTED_KEYS.RPT_REVENUE,

  // Reviews
  RESTRICTED_KEYS.RV_ANALYTICS,
];

const DEFAULT_RESTRICTED_MODULES = FIELD_VERIFICATION_RESTRICTED_MODULES;

// ─── Employee Types ───────────────────────────────────────────────────────────
const EMPLOYEE_TYPES = [
  'Field Executive',
  'Area Manager',
  'Marketing Executive',
  'Verification Officer',
  'Area Operations / Field Verification Employee',
];

// ─── Roles that REQUIRE assignedProperties to be non-empty ───────────────────
const ROLES_REQUIRING_ASSIGNED_PROPERTIES = [
  'Field Executive',
  'Verification Officer',
  'Area Manager',
  'Area Operations / Field Verification Employee',
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
