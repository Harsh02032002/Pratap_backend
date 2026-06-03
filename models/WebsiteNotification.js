const mongoose = require('mongoose');

const websiteNotificationSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        default: ''
    },
    type: {
        type: String,
        enum: ['info', 'success', 'error', 'warning', 'booking_accept', 'chat_message', 'booking_request'],
        default: 'info'
    },
    read: {
        type: Boolean,
        default: false
    },
    actionUrl: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Auto-delete notifications after 30 days
websiteNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('WebsiteNotification', websiteNotificationSchema);
