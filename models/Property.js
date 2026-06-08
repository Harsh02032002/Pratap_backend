const mongoose = require('mongoose');

const PropertySchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  address: { type: String },
  locationCode: { type: String, default: 'GEN' },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ownerLoginId: { type: String },
  ownerName: { type: String },
  ownerPhone: { type: String },
  status: { type: String, enum: ['inactive','active','blocked','pending_approval'], default: 'inactive' },
  isPublished: { type: Boolean, default: false },
  isLiveOnWebsite: { type: Boolean, default: false },
  visitId: { type: String, index: true },
  city: { type: String, index: true },
  locality: { type: String, index: true },
  state: { type: String },
  pincode: { type: String },
  landmark: { type: String },
  propertyCategory: { type: String },
  propertyId: { type: String },
  enquiry_id: { type: String },
  contact: {
    name: { type: String },
    number: { type: String },
    email: { type: String }
  },
  videoUrl: { type: String },
  
  // Amenities - Array of amenity objects with icon and name
  amenities: [{
    name: { type: String, required: true },
    icon: { type: String, default: 'check' }, // icon name from lucide
    category: { type: String, enum: ['basic', 'comfort', 'luxury'], default: 'basic' }
  }],
  
  // Exclusive Direct Benefits - Array of benefit strings
  exclusiveBenefits: [{
    title: { type: String, required: true },
    description: { type: String },
    icon: { type: String, default: 'gift' }
  }],
  
  // Property Views/Gallery - Like OYO (Facade, Room, Kitchen, etc.)
  propertyViews: [{
    label: { type: String, required: true }, // e.g., "Facade", "Room", "Kitchen", "Lobby"
    images: [{ type: String }], // Array of image URLs for this view
    description: { type: String }
  }],
  
  // Main gallery images (legacy support)
  images: [{ type: String }],
  
  // Featured image
  featuredImage: { type: String },
  
  // Property details
  propertyType: { type: String, enum: ['pg', 'hostel', 'co-living', 'coliving', 'apartment', 'room'], default: 'pg' },
  gender: { type: String, enum: ['male', 'female', 'any'], default: 'any' },
  monthlyRent: { type: Number, default: 0 },
  
  // Room details (new structure for Wizard)
  roomTypes: [{
    type: { type: String },
    desc: { type: String },
    totalRooms: { type: String },
    totalBeds: { type: String },
    occupancy: { type: Number },
    pricePerBed: { type: String },
    pricePerRoom: { type: String },
    images: [{ type: String }]
  }],

  // Additional details from Wizard
  propertyDetails: {
    totalArea: { type: String },
    yearBuilt: { type: String },
    propertyAge: { type: String },
    floors: { type: String },
    liftAvailable: { type: String },
    parkingAvailable: { type: String },
    noticePeriod: { type: String },
    genderPref: { type: String },
    preferredFor: {
      students: { type: Boolean },
      professionals: { type: Boolean },
      both: { type: Boolean },
      family: { type: Boolean }
    }
  },

  // Pricing details from Wizard
  pricing: {
    rentType: { type: String },
    securityDeposit: { type: String },
    advanceRent: { type: String },
    noticePeriod: { type: String },
    lockInPeriod: { type: String },
    discountPercent: { type: String },
    includedInRent: { type: Object },
    additionalCharges: [{
      name: { type: String },
      amount: { type: String },
      per: { type: String }
    }],
    cancellationPolicy: { type: String }
  },

  // Policies/House Rules from Wizard
  policies: {
    smokingAllowed: { type: String },
    alcoholAllowed: { type: String },
    petsAllowed: { type: String },
    cookingAllowed: { type: String },
    visitorsAllowed: { type: String },
    visitorTiming: { type: String },
    partyAllowed: { type: String },
    outsideFood: { type: String },
    quietHours: { type: String },
    quietHoursTiming: { type: String },
    earlyCheckIn: { type: String }
  },

  tenantDescription: { type: String },
  
  roomCount: { type: Number, default: 0 },
  bedCount: { type: Number, default: 0 },
  vacantRooms: { type: Number, default: 0 },
  vacantBeds: { type: Number, default: 0 },
  occupiedRooms: { type: Number, default: 0 },
  occupiedBeds: { type: Number, default: 0 },
  
  totalRooms: { type: Number, default: 0 },
  bedsPerRoom: { type: Number, default: 1 },
  discount: { type: Number, default: 0 },
  
  // Facilities (boolean flags for quick filtering)
  facilities: {
    wifi: { type: Boolean, default: false },
    ac: { type: Boolean, default: false },
    food: { type: Boolean, default: false },
    laundry: { type: Boolean, default: false },
    parking: { type: Boolean, default: false },
    gym: { type: Boolean, default: false },
    tv: { type: Boolean, default: false },
    powerBackup: { type: Boolean, default: false }
  },
  
  views: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  isDeleted: { type: Boolean, default: false },

  // Owner Edit Requests — pending admin approval before going live
  pendingChanges: {
    data: { type: Object, default: null },
    requestedAt: { type: Date, default: null },
    requestedBy: { type: String, default: null },   // owner loginId
    reason: { type: String, default: null },
    status: { type: String, enum: ['pending', 'approved', 'rejected', null], default: null }
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto-update updatedAt on save and resolve/link Owner details
PropertySchema.pre('save', async function(next) {
  this.updatedAt = new Date();
  
  try {
    // If owner is already fully resolved (has owner ObjectId and ownerLoginId), and ownerLoginId has not been modified, skip
    if (this.owner && this.ownerLoginId && !this.isModified('ownerLoginId')) {
      return next();
    }
    
    const OwnerModel = mongoose.models.Owner || require('./Owner');
    const UserModel = mongoose.models.User || require('./user');
    
    let ownerDoc = null;
    
    // 1. Match by ownerLoginId
    const loginId = String(this.ownerLoginId || '').trim().toUpperCase();
    if (loginId) {
        ownerDoc = await OwnerModel.findOne({ loginId });
    }
    
    // 2. Match by contact email or top-level email
    if (!ownerDoc) {
        const email = String(this.contact?.email || this.email || '').trim().toLowerCase();
        if (email) {
            ownerDoc = await OwnerModel.findOne({
                $or: [
                    { email: email },
                    { 'profile.email': email }
                ]
            });
        }
    }
    
    // 3. Match by contact number or ownerPhone
    if (!ownerDoc) {
        const phone = String(this.contact?.number || this.ownerPhone || this.phone || '').trim();
        if (phone) {
            const cleanPhone = phone.replace(/^\+?91/, '').trim();
            if (cleanPhone.length >= 10) {
                ownerDoc = await OwnerModel.findOne({
                    $or: [
                        { phone: new RegExp(cleanPhone + '$') },
                        { 'profile.phone': new RegExp(cleanPhone + '$') },
                        { checkinPhone: new RegExp(cleanPhone + '$') }
                    ]
                });
            }
        }
    }
    
    // If found, populate the owner details in the property
    if (ownerDoc) {
        this.ownerLoginId = ownerDoc.loginId;
        if (!this.ownerName) this.ownerName = ownerDoc.name || ownerDoc.profile?.name;
        if (!this.ownerPhone) this.ownerPhone = ownerDoc.phone || ownerDoc.profile?.phone;
        
        // Find corresponding user ObjectId
        const userDoc = await UserModel.findOne({ loginId: ownerDoc.loginId, role: 'owner' });
        if (userDoc) {
            this.owner = userDoc._id;
        }
    }
  } catch (err) {
    console.error('Error in Property pre-save owner resolution:', err);
  }
  
  next();
});

PropertySchema.index({ ownerLoginId: 1 });

module.exports = mongoose.models.Property || mongoose.model('Property', PropertySchema);
