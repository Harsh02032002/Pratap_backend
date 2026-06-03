const mongoose = require('mongoose');

const bookingRequestSchema = new mongoose.Schema({
    property_id: { type: String, required: true, index: true },
    property_name: { type: String, required: true },
    area: { type: String, required: true, index: true },
    city: { type: String },
    property_type: { type: String },
    rent_amount: { type: Number },

    // Property images and details
    propertyPhotos: [{ type: String }],
    property_photos: [{ type: String }],
    propertyImage: { type: String },
    property_image: { type: String },
    photos: [{ type: String }],

    // Booking dates
    check_in_date: { type: Date },
    checkInDate: { type: Date },
    start_date: { type: Date },
    check_out_date: { type: Date },
    checkOutDate: { type: Date },
    end_date: { type: Date },

    // Booking amounts
    total_amount: { type: Number },
    totalAmount: { type: Number },
    price: { type: Number },

    // Booking status (confirmed, active, completed)
    booking_status: { 
        type: String, 
        enum: ['pending', 'confirmed', 'active', 'completed', 'rejected', 'cancelled'], 
        default: 'pending' 
    },
    bookingStatus: { 
        type: String, 
        enum: ['pending', 'confirmed', 'active', 'completed', 'rejected', 'cancelled']
    },

    user_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, default: null, sparse: true },
    email: { type: String, required: true },

    owner_id: { type: String, required: true, index: true },
    owner_name: { type: String },
    area_manager_id: { type: String, index: true },

    request_type: { 
        type: String, 
        enum: ['request', 'bid', 'direct', 'online', 'website'], 
        required: true 
    },
    bid_amount: { type: Number, default: 0 },
    bid_min: { type: Number, default: null },
    bid_max: { type: Number, default: null },
    filter_criteria: { type: mongoose.Schema.Types.Mixed, default: {} },
    message: { type: String },

    status: { 
        type: String, 
        enum: ['pending', 'confirmed', 'rejected', 'booked'], 
        default: 'pending' 
    },

    visit_type: { 
        type: String, 
        enum: ['physical', 'virtual', null], 
        default: null 
    },
    visit_date: { type: Date },
    visit_time_slot: { type: String },
    visit_status: { 
        type: String, 
        enum: ['not_scheduled', 'scheduled', 'completed'], 
        default: 'not_scheduled' 
    },

    // Personal information
    guardian_name: { type: String },
    guardian_phone: { type: String },

    // Address information
    address_street: { type: String },
    address_city: { type: String },
    address_state: { type: String },
    address_postal_code: { type: String },
    address_country: { type: String },

    // Payment information
    payment_id: { type: String, sparse: true },
    paymentId: { type: String, sparse: true },
    payment_amount: { type: Number },
    payment_status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    payment_method: { type: String }, // 'card', 'upi', 'wallet', 'netbanking', etc
    payment_details: { type: String }, // Masked card/account number or payment method details

    // Chat decision fields
    owner_liked: { type: Boolean, default: false },
    user_liked: { type: Boolean, default: false },
    owner_rejected: { type: Boolean, default: false },
    user_rejected: { type: Boolean, default: false },

    whatsapp_enabled: { type: Boolean, default: true },

    latitude: { type: Number },
    longitude: { type: Number },

    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

// Middleware to update the updated_at timestamp
bookingRequestSchema.pre('save', function(next) {
    this.updated_at = Date.now();
    next();
});

module.exports = mongoose.model('BookingRequest', bookingRequestSchema);
