const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  // Property reference (can be ObjectId or custom string like DELHI-PG-002)
  propertyId: {
    type: String,
    required: [true, 'Property ID is required'],
    index: true
  },
  propertyName: {
    type: String,
    required: true
  },
  
  // User reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    trim: true,
    lowercase: true
  },
  avatar: {
    type: String,
    default: null
  },
  
  // Review content
  rating: {
    type: Number,
    required: [true, 'Rating is required'],
    min: 1,
    max: 5,
    default: 5
  },
  review: {
    type: String,
    required: [true, 'Review text is required'],
    trim: true,
    maxlength: [1000, 'Review cannot exceed 1000 characters']
  },
  
  // Optional fields
  designation: {
    type: String,
    default: 'Student',
    trim: true
  },
  location: {
    type: String,
    default: '',
    trim: true
  },
  
  // Status
  isVerified: {
    type: Boolean,
    default: false
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive', 'Pending'],
    default: 'Active'
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
reviewSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Static method to get featured reviews
reviewSchema.statics.getFeaturedReviews = function(limit = 6) {
  return this.find({ isFeatured: true, status: 'Active' })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to get recent reviews
reviewSchema.statics.getRecentReviews = function(limit = 10) {
  return this.find({ status: 'Active' })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to get reviews by rating
reviewSchema.statics.getReviewsByRating = function(minRating = 4, limit = 10) {
  return this.find({ rating: { $gte: minRating }, status: 'Active' })
    .sort({ rating: -1, createdAt: -1 })
    .limit(limit);
};

// Static method to get average rating
reviewSchema.statics.getAverageRating = function() {
  return this.aggregate([
    { $match: { status: 'Active' } },
    { $group: { _id: null, avgRating: { $avg: '$rating' }, totalReviews: { $sum: 1 } } }
  ]);
};

// Static method to get reviews for a specific property
reviewSchema.statics.getPropertyReviews = function(propertyId, limit = 50) {
  return this.find({ propertyId, status: 'Active' })
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to get average rating for a specific property
reviewSchema.statics.getPropertyAverageRating = function(propertyId) {
  return this.aggregate([
    { $match: { propertyId: propertyId, status: 'Active' } },
    { 
      $group: { 
        _id: null, 
        avgRating: { $avg: '$rating' }, 
        totalReviews: { $sum: 1 },
        rating5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        rating4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        rating3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        rating2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        rating1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } }
      } 
    }
  ]);
};

// Static method to check if user has already reviewed a property
reviewSchema.statics.hasUserReviewed = function(propertyId, userId) {
  return this.findOne({ propertyId, userId, status: 'Active' });
};

module.exports = mongoose.model('Review', reviewSchema);
