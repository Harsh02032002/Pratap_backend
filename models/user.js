const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String }, // Optional for Owners/Tenants who use ID
    // Not unique: multiple accounts (e.g. a tenant and a household member, or
    // reused test data) may share a phone number. authController.login already
    // handles this — if a phone lookup matches more than one account, it asks
    // the caller to log in with their Login ID instead of picking one.
    phone: { type: String, required: true },
    password: { type: String, required: true },
    
    role: { 
        type: String, 
        enum: ['superadmin', 'admin', 'areamanager', 'owner', 'tenant', 'employee'], 
        default: 'tenant' 
    },

    // Special Login IDs (e.g., KO01, RHY-8821)
    loginId: { type: String, unique: true, sparse: true },
    
    // For Area Managers & Owners (e.g., "KO" for Kota)
    locationCode: { type: String }, 
    
    // For Owners created via Visit
    status: { type: String, enum: ['active', 'pending', 'inactive', 'blocked', 'suspended'], default: 'pending' },
    isActive: { type: Boolean, default: true },
    requirePasswordReset: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    chatRestrictedUntil: { type: Date, default: null },

    // Profile fields
    profilePic: { type: String },
    profileImage: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    address: { type: String },
    city: { type: String },
    bio: { type: String },

    // User settings
    settings: {
        notifications: {
            email: { type: Boolean, default: true },
            sms: { type: Boolean, default: true },
            push: { type: Boolean, default: true },
            marketing: { type: Boolean, default: false }
        },
        privacy: {
            profileVisible: { type: Boolean, default: true },
            showPhone: { type: Boolean, default: false },
            showEmail: { type: Boolean, default: false }
        },
        preferences: {
            darkMode: { type: Boolean, default: false },
            language: { type: String, default: 'en' }
        }
    },

    // Favourites (array of property IDs)
    favourites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Property' }],

    // Stats
    bookings: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Booking' }],
    reviews: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Review' }],

    createdAt: { type: Date, default: Date.now }
});

// Encrypt password
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Check password
userSchema.methods.matchPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

// Compare password (alias for matchPassword)
userSchema.methods.comparePassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);