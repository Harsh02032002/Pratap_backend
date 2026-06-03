const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
    {
        name: String,
        type: String,
        size: Number,
        dataUrl: String
    },
    { _id: false }
);

const checkinRecordSchema = new mongoose.Schema(
    {
        loginId: { type: String, required: true, trim: true, uppercase: true },
        role: { type: String, enum: ['owner', 'tenant'], required: true },

        ownerProfile: {
            name: String,
            dob: String,
            email: String,
            payment: {
                bankAccountNumber: String,
                ifscCode: String,
                accountHolderName: String,
                upiId: String,
                cancelledCheque: fileSchema
            }
        },
        ownerKyc: {
            aadhaarLinkedPhone: String,
            aadhaarNumber: String,
            otpVerified: { type: Boolean, default: false }
        },
        ownerTermsAcceptedAt: Date,
        ownerFinalVerified: { type: Boolean, default: false },
        ownerSubmittedAt: Date,

        tenantProfile: {
            name: String,
            dob: String,
            guardianNumber: String,
            moveInDate: String,
            email: String
        },
        tenantKyc: {
            aadhaarLinkedPhone: String,
            aadhaarNumber: String,
            aadhaarFront: fileSchema,
            aadhaarBack: fileSchema,
            otpVerified: { type: Boolean, default: false }
        },
        tenantAgreement: {
            eSignName: String,
            acceptedAt: Date
        },
        tenantSubmittedAt: Date
    },
    { timestamps: true }
);

checkinRecordSchema.index({ loginId: 1, role: 1 }, { unique: true });

module.exports = mongoose.model('CheckinRecord', checkinRecordSchema);

