const mongoose = require('mongoose');

const propertyInquirySchema = new mongoose.Schema({
    inquiryId: { 
        type: String, 
        unique: true, 
        required: true,
        index: true
    },
    propertyId: {
        type: String,
        required: true,
        index: true
    },
    ownerId: {
        type: String,
        required: true,
        index: true
    },
    visitorId: {
        type: String,
        required: true,
        index: true
    },
    visitorEmail: {
        type: String,
        required: true
    },
    visitorPhone: {
        type: String,
        required: true
    },
    requestMessage: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected'],
        default: 'pending',
        index: true
    },
    chatStarted: { 
        type: Boolean, 
        default: false 
    },
    messageCount: {
        type: Number,
        default: 0
    },
    createdAt: { 
        type: Date, 
        default: Date.now,
        index: true
    },
    respondedAt: {
        type: Date,
        default: null
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Auto-update updatedAt on save
propertyInquirySchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

module.exports = mongoose.model('PropertyInquiry', propertyInquirySchema);
