const mongoose = require('mongoose');
const bcryptjs = require('bcryptjs');

const areaManagerSchema = new mongoose.Schema({
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
        required: true,
        lowercase: true,
        unique: true,
        sparse: true
    },
    phone: String,
    password: {
        type: String,
        required: true
    },
    area: String,
    areaName: String,
    areaCode: String,
    city: {
        type: String,
        default: ''
    },
    region: {
        type: String,
        default: ''
    },
    permissions: [String], // Array of permission strings
    isActive: {
        type: Boolean,
        default: true
    },
    role: {
        type: String,
        enum: ['areamanager', 'manager'],
        default: 'areamanager'
    },
    department: {
        type: String,
        default: 'Area Management'
    },
    profilePhoto: String,
    joinDate: {
        type: Date,
        default: Date.now
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
areaManagerSchema.index({ area: 1, areaCode: 1 });
areaManagerSchema.index({ isActive: 1 });

// Pre-save hook to hash password
areaManagerSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    
    try {
        const salt = await bcryptjs.genSalt(10);
        this.password = await bcryptjs.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

// Method to match password
areaManagerSchema.methods.matchPassword = async function(enteredPassword) {
    return await bcryptjs.compare(enteredPassword, this.password);
};

// Exclude password from JSON responses
areaManagerSchema.methods.toJSON = function() {
    const obj = this.toObject();
    delete obj.password;
    return obj;
};

module.exports = mongoose.model('AreaManager', areaManagerSchema);
