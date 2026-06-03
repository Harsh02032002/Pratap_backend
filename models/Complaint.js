const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
    tenantId: {
        type: String,
        required: true,
        index: true
    },
    tenantLoginId: {
        type: String,
        default: ''
    },
    tenantEmail: {
        type: String,
        default: ''
    },
    type: {
        type: String,
        enum: ['Tenant', 'Owner'],
        default: 'Tenant',
        index: true
    },
    ownerLoginId: {
        type: String,
        index: true
    },
    tenantName: {
        type: String,
        required: true
    },
    tenantPhone: {
        type: String,
        required: true
    },
    property: {
        type: String,
        required: true
    },
    propertyId: {
        type: String,
        default: '',
        index: true
    },
    roomNo: {
        type: String,
        required: true
    },
    bedNo: {
        type: String,
        required: true
    },
    category: {
        type: String,
        required: true
    },
    issueType: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        required: true
    },
    priority: {
        type: String,
        required: true,
        enum: ['Low', 'Medium', 'High'],
        default: 'Low'
    },
    status: {
        type: String,
        required: true,
        enum: ['Open', 'In Progress', 'Resolved', 'Rejected', 'Taken'],
        default: 'Open'
    },
    escalated: {
        type: Boolean,
        default: false
    },
    imageStr: {
        type: String
    },
    ownerResponse: {
        type: String,
        default: ''
    },
    ownerResponseBy: {
        type: String,
        default: ''
    },
    ownerResponseByLoginId: {
        type: String,
        default: ''
    },
    assignedTo: {
        type: String,
        default: null
    },
    assignedStaffId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Employee'
    },
    assignedStaffName: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    resolvedAt: {
        type: Date,
        default: null
    },
    escalatedAt: {
        type: Date,
        default: null
    }
});

module.exports = mongoose.model('Complaint', complaintSchema);
