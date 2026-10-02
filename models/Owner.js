const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$/;
const looksBcryptHashed = (v) => typeof v === 'string' && BCRYPT_HASH_RE.test(v);

const parseArrayInput = (value) => {
    // If already an array, return as-is
    if (Array.isArray(value)) return value;
    
    // If string, try to parse it
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        
        try {
            // Try JSON.parse first
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [];
        } catch (parseErr) {
            // If JSON.parse fails, try to extract array from string representation
            try {
                if (trimmed.startsWith('[') || trimmed.includes('id:')) {
                    const match = trimmed.match(/^\[([\s\S]*)\]$/);
                    if (match) {
                        const content = match[1];
                        const objMatches = content.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
                        if (objMatches && objMatches.length > 0) {
                            try {
                                const reconstructed = '[' + objMatches.join(',') + ']';
                                const reParsed = JSON.parse(reconstructed);
                                return Array.isArray(reParsed) ? reParsed : [];
                            } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
            return [];
        }
    }
    return [];
};

const ownerBedSchema = new mongoose.Schema(
    {
        status: { type: String, enum: ['available', 'occupied'], default: 'available' },
        tenantId: String,
        tenantName: String
    },
    { _id: false }
);

const ownerRoomInventorySchema = new mongoose.Schema(
    {
        id: String,
        propertyId: String,
        propertyTitle: String,
        number: String,
        roomNo: String,
        title: String,
        type: String,
        roomType: String,
        rent: { type: Number, default: 0 },
        price: { type: Number, default: 0 },
        gender: String,
        beds: { type: [ownerBedSchema], default: [] }
    },
    { _id: false }
);

const ownerSchema = new mongoose.Schema({
    loginId: { type: String, required: true, unique: true, trim: true, uppercase: true },
    // Top-level fields for backward compatibility
    name: String,
    email: String,
    phone: String,
    address: String,
    city: String,
    locationCode: String, // e.g. area code like 'KO', 'IN'
    area: String, // human-friendly area name (Koramangala, Indiranagar)
    // Top-level banking fields (populated by edit owner flow & controller merge)
    bankName: String,
    accountNumber: String,
    ifscCode: String,
    branchName: String,
    // checkinEmail is the digital checkin email (may differ from profile email)
    checkinEmail: String,
    // Nested profile object (preferred structure)
    profile: {
        name: String,
        email: String,
        phone: String,
        address: String,
        city: String,
        locationCode: String,
        bankName: String,
        accountNumber: String,
        ifscCode: String,
        branchName: String,
        updatedAt: Date 
    },
    credentials: {
        password: String,
        firstTime: { type: Boolean, default: false }
    },
    kyc: {
        status: { type: String, default: 'pending' },
        aadharNumber: String,
        documentImage: String,
        verifiedAt: Date,
        submittedAt: Date
    }, // Digital Check-In fields (with "checkin" prefix for frontend display)
    checkinDob: String,
    checkinPhone: String,
    checkinAddress: String,
    checkinArea: String,
    checkinPassword: String,
    checkinAadhaarLinkedPhone: String,
    checkinAadhaarNumber: String,
    checkinAccountHolderName: String,
    checkinUpiId: String,
    checkinBankAccountNumber: String,
    checkinIfscCode: String,
    checkinBankName: String,
    checkinBranchName: String,
    bankLockedByVisit: { type: Boolean, default: false },
    checkinOwnerPhoto: String,
    checkinOwnerPhotoName: String,
    checkinOwnerPhotoType: String,
    checkinBankProof: String,
    checkinBankProofName: String,
    checkinBankProofType: String,
    checkinAadhaarImage: String,
    checkinAadhaarImageName: String,
    checkinAadhaarImageType: String,

    // ─── Cashfree Bank Details (for payouts) ──────────────────────────────
    bankDetails: {
        accountHolderName: { type: String, default: null },
        accountNumber:     { type: String, default: null },
        ifsc:              { type: String, default: null },
        bankName:          { type: String, default: null },
        upiId:             { type: String, default: null },
        isVerified:        { type: Boolean, default: false },
        verifiedAt:        { type: Date, default: null },
        cf_beneficiary_id: { type: String, default: null }, // Cashfree beneficiary ID after add
    },
    roomCount: { type: Number, default: 0 },
    bedCount: { type: Number, default: 0 },
    vacantRooms: { type: Number, default: 0 },
    vacantBeds: { type: Number, default: 0 },
    occupiedRooms: { type: Number, default: 0 },
    occupiedBeds: { type: Number, default: 0 },
    roomInventory: {
        type: [ownerRoomInventorySchema],
        default: [],
        set: parseArrayInput
    },
    agreementRequestId: String,
    agreementStatus: String,
    agreementSignedAt: Date,
    checkinCancelledCheque: {
        name: String,
        mimeType: String,  // Changed from "type" to avoid Mongoose keyword conflict
        size: Number,
        dataUrl: String
    },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    chatRestrictedUntil: { type: Date, default: null },
    fcmTokens: [{
        token: { type: String },
        deviceType: { type: String, default: 'web' },
        updatedAt: { type: Date, default: Date.now }
    }],
    settings: {
        checkoutTime: { type: String, default: "10:00 AM" },
        checkinTime: { type: String, default: "11:00 AM" },
        fineGracePeriod: { type: Number, default: 5 },
        fineAmount: { type: Number, default: 100 },
        curfewTime: { type: String, default: "11:00 PM" },
        electricityUnitRate: { type: Number, default: 12 }
    },
    walletBalance:     { type: Number, default: 0 },  // available for withdrawal
    availableBalance:  { type: Number, default: 0 },  // ready to withdraw
    pendingBalance:    { type: Number, default: 0 },  // legacy
    withdrawnBalance:  { type: Number, default: 0 },
    // Owner Panel Free Trial & Subscription tracking
    subscription: {
        trialStartDate: { type: Date }, // set at onboarding (or pulled from createdAt)
        trialEndDate: { type: Date },   // trialStartDate + ownerTrialDays from SystemSettings
        isSubscribed: { type: Boolean, default: false },
        subscriptionExpiry: { type: Date },
        extendedBy: { type: String },   // superadmin loginId who extended
        extensionNote: { type: String }, // reason for extension
        lastExtendedAt: { type: Date }
    },
    createdByStaffId: { type: String },
    createdByStaffName: { type: String },
    addedByStaffId: { type: String },
    addedByStaffName: { type: String },
    staffId: { type: String },
    createdAt: { type: Date, default: Date.now }
});

// Owner passwords were historically stored as plain text (see security audit,
// 2026-09-29). Rather than a one-shot migration script touching every existing
// record, this hashes lazily: any password written from here on gets hashed on
// save, and verifyStoredPassword() below upgrades a legacy plain-text password
// to a hash the moment it's next used successfully — so the DB converges to
// fully-hashed passwords over normal usage with no separate migration to run.
ownerSchema.pre('save', async function (next) {
    try {
        if (this.isModified('credentials.password') && this.credentials?.password && !looksBcryptHashed(this.credentials.password)) {
            this.credentials.password = await bcrypt.hash(this.credentials.password, 10);
        }
        if (this.isModified('checkinPassword') && this.checkinPassword && !looksBcryptHashed(this.checkinPassword)) {
            this.checkinPassword = await bcrypt.hash(this.checkinPassword, 10);
        }
        next();
    } catch (err) {
        next(err);
    }
});

// Verifies `candidate` against whichever of credentials.password / checkinPassword
// is set, transparently handling both already-hashed and legacy plain-text values.
// On a legacy plain-text match, re-saves the owner with the hash so the same
// record never compares in plain text again.
ownerSchema.statics.verifyStoredPassword = async function (ownerDoc, candidate) {
    if (!ownerDoc || !candidate) return false;
    const stored = ownerDoc.credentials?.password || ownerDoc.checkinPassword || '';
    if (!stored) return false;

    if (looksBcryptHashed(stored)) {
        return bcrypt.compare(String(candidate), stored);
    }

    const matches = String(stored) === String(candidate);
    if (matches) {
        try {
            const Owner = mongoose.models.Owner || mongoose.model('Owner');
            const doc = typeof ownerDoc.save === 'function' ? ownerDoc : await Owner.findById(ownerDoc._id);
            if (doc) {
                if (doc.credentials?.password) doc.credentials.password = candidate;
                if (doc.checkinPassword) doc.checkinPassword = candidate;
                await doc.save();
            }
        } catch (_) {
            // Best-effort upgrade only — a failed re-hash must never fail the login.
        }
    }
    return matches;
};

ownerSchema.statics.looksBcryptHashed = looksBcryptHashed;

// `pre('save')` above only fires on .save() — a LOT of code in this codebase
// writes passwords via findOneAndUpdate/updateOne instead (e.g. the digital
// check-in profile submission), which bypasses it entirely. Cover those too,
// so no write path can leave a plain-text password at rest.
async function hashUpdatePasswords(next) {
    try {
        const update = this.getUpdate ? this.getUpdate() : null;
        if (!update) return next();
        const setBlock = update.$set || update;

        if (setBlock.checkinPassword && !looksBcryptHashed(setBlock.checkinPassword)) {
            setBlock.checkinPassword = await bcrypt.hash(setBlock.checkinPassword, 10);
        }
        if (setBlock['credentials.password'] && !looksBcryptHashed(setBlock['credentials.password'])) {
            setBlock['credentials.password'] = await bcrypt.hash(setBlock['credentials.password'], 10);
        }
        if (setBlock.credentials?.password && !looksBcryptHashed(setBlock.credentials.password)) {
            setBlock.credentials.password = await bcrypt.hash(setBlock.credentials.password, 10);
        }
        next();
    } catch (err) {
        next(err);
    }
}
ownerSchema.pre('findOneAndUpdate', hashUpdatePasswords);
ownerSchema.pre('updateOne', hashUpdatePasswords);
ownerSchema.pre('updateMany', hashUpdatePasswords);

// Pre-save hook to ensure roomInventory is properly formatted
ownerSchema.pre('save', function(next) {
    try {
        if (this.roomInventory) {
            const roomInv = this.roomInventory;
            if (typeof roomInv === 'string') {
                this.roomInventory = parseArrayInput(roomInv);
            } else if (Array.isArray(roomInv)) {
                this.roomInventory = roomInv.map(room => {
                    if (typeof room === 'string') {
                        try {
                            return JSON.parse(room);
                        } catch (_) {
                            return room;
                        }
                    }
                    return room;
                });
            }
        }
        next();
    } catch (err) {
        next(err);
    }
});

module.exports = mongoose.models.Owner || mongoose.model('Owner', ownerSchema);
