const mongoose = require('mongoose');
const { EMPLOYEE_TYPES, DEFAULT_RESTRICTED_MODULES } = require('../utils/permissionKeys');

const employeeSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    loginId: {
        type: String,
        required: true,
        unique: true,
        sparse: true
    },
    email: {
        type: String,
        lowercase: true,
        unique: true,
        sparse: true
    },
    phone: String,
    password: String,
    role: {
        type: String,
        default: 'Custom'
    },
    photoDataUrl: String,
    customRole: String, // For custom roles
    // ─── Location Assignment ─────────────────────────────────────────────────
    area: String,
    areaCode: String,
    city: String,
    locationCode: String,
    cityId:  { type: mongoose.Schema.Types.ObjectId, ref: 'City',  sparse: true },
    areaId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Area',  sparse: true },

    // ─── Module & Sub-Module Permissions ─────────────────────────────────────
    permissions: [String], // Top-level module access keys
    restrictedModules: { type: [String], default: [] }, // Sub-module block list (checked = blocked)

    // ─── Employee Classification ──────────────────────────────────────────────
    employeeType: {
        type: String,
        enum: EMPLOYEE_TYPES,
        default: 'Field Executive'
    },

    // ─── Assigned Scope (Area Data Isolation) ────────────────────────────────
    assignedProperties: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Property' }],
    assignedOwners:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'Owner' }],
    parentLoginId: String, // For sub-employees
    isActive: {
        type: Boolean,
        default: true
    },
    isDeleted: {
        type: Boolean,
        default: false
    },
    requirePasswordReset: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Index for quick lookups
// Note: email and loginId already have indexes from unique constraint
employeeSchema.index({ area: 1, areaCode: 1 });
employeeSchema.index({ cityId: 1, areaId: 1 });
employeeSchema.index({ assignedProperties: 1 });
employeeSchema.index({ assignedOwners: 1 });
employeeSchema.index({ isActive: 1 });

module.exports = mongoose.model('Employee', employeeSchema);
