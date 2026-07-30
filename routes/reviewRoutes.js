const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');
const { applyReviewScope } = require('../utils/scopeHelpers');

// Safety/text moderation helper for review submissions
function moderateReviewText(text) {
  if (!text) return { flagged: false };
  
  // 1. Contact leakage / links check (email, phone, upi, social handles, external links)
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i;
  const phoneRegex = /(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
  const simplePhoneRegex = /\b\d{10}\b/;
  const upiRegex = /[a-zA-Z0-9.-]+\s*@\s*(upi|ybl|paytm|okaxis|okhdfcbank|okicici|pay|phonepe|gpay|okdhfl|oksbi|axisbank|hdfcbank|icici|sbi|barodampay|kotak)/gi;
  const socialRegex = /(instagram\.com|ig\.me|t\.me|telegram\.me|facebook\.com|fb\.me|fb\.com|snapchat\.com|twitter\.com|x\.com)/i;
  const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
  
  if (
    emailRegex.test(text) || 
    phoneRegex.test(text) || 
    simplePhoneRegex.test(text) || 
    upiRegex.test(text) || 
    socialRegex.test(text) || 
    linkRegex.test(text)
  ) {
    return { flagged: true, reason: 'spam', details: 'Contact info or link detected' };
  }
  
  // 2. Profanity / Hate Speech check
  const abuseRegex = /\b(abuse|hate|spam|scam|fraud|bastard|idiot|stupid|asshole|bitch|fucking?|fuck|shit|crap|piss|chutiya|madarchod|behenchod|saala|kamina|harami|bhosdike|randi|gandu|saale)\b/i;
  if (abuseRegex.test(text)) {
    return { flagged: true, reason: 'abuse', details: 'Abusive language or profanity detected' };
  }
  
  // 3. Spam / Repetitive letters check
  const repetitiveRegex = /([a-zA-Z])\1{4,}/;
  if (repetitiveRegex.test(text)) {
    return { flagged: true, reason: 'spam', details: 'Repetitive characters detected' };
  }
  
  // 4. Duplicate words check
  const duplicateWordsRegex = /(\b\w+\b)(?:\s+\1){3,}/i;
  if (duplicateWordsRegex.test(text)) {
    return { flagged: true, reason: 'spam', details: 'Repetitive words detected' };
  }

  return { flagged: false };
}

// ============================================================
// GET: Fetch all reviews (public)
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { featured, limit = 10, minRating, status = 'Active' } = req.query;
    
    let query = { status };
    
    // Filter by featured
    if (featured === 'true') {
      query.isFeatured = true;
    }
    
    // Filter by minimum rating
    if (minRating) {
      query.rating = { $gte: parseInt(minRating) };
    }
    
    const reviews = await Review.find(query)
      .select('-email -userId')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching reviews'
    });
  }
});

// ============================================================
// GET: Fetch all reviews for admin management (protected & scoped)
// ============================================================
router.get('/admin/all', protect, authorize('admin', 'superadmin', 'employee', 'manager'), applyEmployeeScope, async (req, res) => {
  try {
    const query = applyReviewScope(req, {});
    const reviews = await Review.find(query).sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      data: reviews
    });
  } catch (error) {
    console.error('Error fetching admin reviews:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ============================================================
// GET: Fetch featured reviews for homepage (public)
// ============================================================
router.get('/featured', async (req, res) => {
  try {
    const { limit = 6 } = req.query;
    
    const reviews = await Review.getFeaturedReviews(parseInt(limit));
    
    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('Error fetching featured reviews:', error);
    res.status(500).json({ success: false, message: 'Error fetching featured reviews' });
  }
});

// ============================================================
// GET: Fetch top rated reviews (public)
// ============================================================
router.get('/top-rated', async (req, res) => {
  try {
    const { limit = 6, minRating = 4 } = req.query;

    const reviews = await Review.getReviewsByRating(parseInt(minRating), parseInt(limit));

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('Error fetching top rated reviews:', error);
    res.status(500).json({ success: false, message: 'Error fetching top rated reviews' });
  }
});

// ============================================================
// GET: Get review statistics (public)
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const stats = await Review.getAverageRating();
    const totalReviews = await Review.countDocuments({ status: 'Active' });
    const featuredReviews = await Review.countDocuments({ isFeatured: true, status: 'Active' });

    res.status(200).json({
      success: true,
      data: {
        averageRating: stats.length > 0 ? Math.round(stats[0].avgRating * 10) / 10 : 0,
        totalReviews,
        featuredReviews
      }
    });
  } catch (error) {
    console.error('Error fetching review stats:', error);
    res.status(500).json({ success: false, message: 'Error fetching review statistics' });
  }
});

// ============================================================
// GET: Fetch reviews for a specific property (public)
// ============================================================
router.get('/property/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { limit = 50 } = req.query;
    
    const reviews = await Review.getPropertyReviews(propertyId, parseInt(limit));
    
    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('Error fetching property reviews:', error);
    res.status(500).json({ success: false, message: 'Error fetching property reviews' });
  }
});

// ============================================================
// GET: Get average rating and stats for a property (public)
// ============================================================
router.get('/property/:propertyId/stats', async (req, res) => {
  try {
    const { propertyId } = req.params;

    const stats = await Review.getPropertyAverageRating(propertyId);
    const totalReviews = await Review.countDocuments({ propertyId, status: 'Active' });

    if (stats.length === 0) {
      return res.status(200).json({
        success: true,
        data: { avgRating: 0, totalReviews: 0, ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } }
      });
    }

    const result = stats[0];
    res.status(200).json({
      success: true,
      data: {
        avgRating: Math.round(result.avgRating * 10) / 10,
        totalReviews: result.totalReviews,
        ratingBreakdown: {
          5: result.rating5 || 0,
          4: result.rating4 || 0,
          3: result.rating3 || 0,
          2: result.rating2 || 0,
          1: result.rating1 || 0
        }
      }
    });
  } catch (error) {
    console.error('Error fetching property rating stats:', error);
    res.status(500).json({ success: false, message: 'Error fetching property rating stats' });
  }
});

// ============================================================
// GET: Check if user has reviewed a property (protected)
// ============================================================
router.get('/property/:propertyId/user-review', protect, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const userId = req.user._id;
    
    const review = await Review.hasUserReviewed(propertyId, userId);
    
    res.status(200).json({
      success: true,
      hasReviewed: !!review,
      review: review || null
    });
  } catch (error) {
    console.error('Error checking user review:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking user review'
    });
  }
});

// ============================================================
// GET: Fetch single review by ID (public)
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id).select('-email -userId');

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    res.status(200).json({
      success: true,
      data: review
    });
  } catch (error) {
    console.error('Error fetching review:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching review'
    });
  }
});

// ============================================================
// POST: Create new review (protected - requires login)
// ============================================================
router.post('/', protect, async (req, res) => {
  try {
    const { propertyId, propertyName, rating, review } = req.body;
    const userId = req.user._id;
    const name = req.user.name;
    const email = req.user.email;
    
    // Validate required fields
    if (!propertyId || !propertyName || rating === undefined || !review) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: propertyId, propertyName, rating, review'
      });
    }

    // Validate if propertyId is a valid MongoDB ObjectId to prevent CastError
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(propertyId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property ID format.'
      });
    }
    
    // Check if user has already rated this property (only if rating > 0)
    if (Number(rating) > 0) {
      const existingReview = await Review.findOne({ propertyId, userId, rating: { $gt: 0 }, status: { $in: ['Approved', 'Pending', 'Active'] } });
      if (existingReview) {
        return res.status(400).json({
          success: false,
          message: 'You have already rated this property'
        });
      }
    }
    // ✅ GATE: Only active moved-in tenants or ex-tenants can submit reviews
    const Tenant = require('../models/Tenant');
    const now = new Date();

    // First: Check if they have an active or inactive Tenant record for this property
    const tenantRecord = await Tenant.findOne({
      property: propertyId,
      isDeleted: { $ne: true },
      $or: [
        {
          status: 'active',
          moveInDate: { $lte: now }
        },
        {
          status: 'inactive'
        }
      ],
      $or: [
        { email: email },
        { user: userId }
      ]
    }).lean();

    let resolvedBookingId = '';
    let resolvedTenantId = '';
    let resolvedOwnerId = '';

    // Query BookingRequest to find the booking ID
    const BookingRequest = require('../models/BookingRequest');
    const userBooking = await BookingRequest.findOne({
      $and: [
        { property_id: propertyId },
        { 
          $or: [
            { user_id: String(userId) },
            { email: email }
          ]
        },
        { 
          $or: [
            { booking_status: 'confirmed' },
            { status: 'confirmed' },
            { status: 'booked' },
            { payment_status: 'completed' }
          ]
        }
      ]
    });

    // In development mode, bypass the strict moved-in tenant gate to make local testing easy.
    const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
    if (!tenantRecord && !userBooking && !isDev) {
      return res.status(403).json({
        success: false,
        message: 'Reviews can only be submitted by active tenants who have already moved in, or ex-tenants of this property.'
      });
    }

    // Resolve IDs for Mongoose validation requirements
    if (tenantRecord) {
      resolvedTenantId = tenantRecord.loginId || String(userId);
      resolvedOwnerId = tenantRecord.ownerLoginId || '';
    } else {
      resolvedTenantId = String(userId);
    }

    if (userBooking) {
      resolvedBookingId = userBooking.visitId || userBooking._id.toString();
      if (!resolvedOwnerId) {
        resolvedOwnerId = userBooking.owner_id || '';
      }
    } else if (tenantRecord) {
      // Direct tenant without booking request
      resolvedBookingId = `DIRECT-${tenantRecord.loginId || tenantRecord._id.toString()}`;
    } else if (isDev) {
      // Fallbacks for testing in dev mode
      resolvedBookingId = `DEV-${userId}`;
      resolvedOwnerId = 'DEV-OWNER';
    }

    // Fallback: If ownerId is still not resolved, query the property details to get it
    if (!resolvedOwnerId) {
      const ApprovedProperty = require('../models/ApprovedProperty');
      const propertyDoc = await ApprovedProperty.findOne({ $or: [{ _id: propertyId }, { visitId: propertyId }] }).lean();
      if (propertyDoc) {
        resolvedOwnerId = propertyDoc.generatedCredentials?.loginId || propertyDoc.createdBy || propertyDoc.propertyInfo?.ownerLoginId || 'SYSTEM';
      } else {
        resolvedOwnerId = 'SYSTEM';
      }
    }

    // Run safety / text moderation checks
    const moderation = moderateReviewText(review);
    const reviewStatus = moderation.flagged ? 'Pending Review' : 'Active';
    const modStatus = moderation.flagged ? 'flagged' : 'approved';
    const flaggedViolations = moderation.flagged ? [moderation.reason] : [];
    const moderationNotes = moderation.flagged ? `Auto-flagged: ${moderation.details}` : 'Auto-approved';

    // Create new review
    const newReview = await Review.create({
      propertyId,
      propertyName,
      userId,
      name,
      email,
      rating: parseInt(rating),
      review,
      bookingId: resolvedBookingId,
      tenantId: resolvedTenantId,
      ownerId: resolvedOwnerId,
      isVerifiedStay: true, // Mark it as verified stay review since we verified eligibility
      isVerified: true,
      isFeatured: false,
      status: reviewStatus,
      moderationStatus: modStatus,
      flaggedViolations,
      moderationNotes
    });

    const responseMessage = reviewStatus === 'Active' 
      ? 'Review submitted and approved successfully.'
      : 'Review submitted successfully. It has been flagged for manual verification by the safety filter.';

    res.status(201).json({
      success: true,
      message: responseMessage,
      data: newReview
    });
  } catch (error) {
    console.error('Error creating review:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating review'
    });
  }
});

// ============================================================
// PUT: Update review (protected - admin or owner edit)
// ============================================================
router.put('/:id', protect, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    const isOwner = String(review.userId) === String(req.user._id) || String(review.userId) === String(req.user.id);

    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this review'
      });
    }

    const oldStatus = review.status;

    // Admin updates: featured, verified, status
    if (isAdmin) {
      const { isFeatured, isVerified, status } = req.body;
      if (isFeatured !== undefined) review.isFeatured = isFeatured;
      if (isVerified !== undefined) review.isVerified = isVerified;
      if (status !== undefined) review.status = status;

      // Explicit audit log for review moderation
      try {
        const AuditLog = require('../models/AuditLog');
        await AuditLog.create({
          actorId: req.user?.loginId || req.user?._id || 'SUPER_ADMIN',
          actorRole: req.user?.role || 'superadmin',
          module: 'Review',
          action: 'Moderate Review',
          method: 'PUT',
          path: req.originalUrl || `/api/reviews/${req.params.id}`,
          statusCode: 200,
          payload: {
            reviewId: req.params.id,
            isFeatured,
            isVerified,
            status,
            oldValue: oldStatus,
            newValue: status
          }
        });
      } catch (auditErr) {
        console.warn('Review moderation audit log failed:', auditErr.message);
      }
    }

    // Owner updates: review text and/or rating
    if (isOwner) {
      const { text, review: reviewText, rating } = req.body;
      const newText = text || reviewText;

      if (newText) {
        review.review = newText;
        review.reviewText = newText;
        
        // Re-run moderation filter on new text
        const moderation = moderateReviewText(newText);
        review.status = moderation.flagged ? 'Pending Review' : 'Active';
        review.moderationStatus = moderation.flagged ? 'flagged' : 'approved';
      }
      
      if (rating !== undefined) {
        review.rating = Number(rating);
      }
    }

    review.updatedAt = Date.now();
    await review.save();

    res.status(200).json({
      success: true,
      message: 'Review updated successfully',
      data: review
    });
  } catch (error) {
    console.error('Error updating review:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating review'
    });
  }
});

// ============================================================
// GET: Get current user's reviews (protected)
// ============================================================
router.get('/user/my-reviews', protect, async (req, res) => {
  try {
    const reviews = await Review.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .populate('propertyId', 'propertyName propertyImage');

    res.status(200).json({
      success: true,
      count: reviews.length,
      reviews: reviews.map(review => ({
        _id: review._id,
        text: review.reviewText || review.text,
        rating: review.rating,
        createdAt: review.createdAt,
        propertyName: review.propertyId?.propertyName || 'Unknown Property',
        propertyImage: review.propertyId?.propertyImage || null,
        propertyId: review.propertyId?._id
      }))
    });
  } catch (error) {
    console.error('Error fetching user reviews:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user reviews'
    });
  }
});



// ============================================================
// DELETE: Delete own review (protected - owner only)
// ============================================================
router.delete('/:id', protect, async (req, res) => {
  try {
    // Find review and check ownership
    const review = await Review.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or you do not have permission to delete it'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting review'
    });
  }
});

// ============================================================
// DELETE: Delete review (protected - admin only) - Admin route
// ============================================================
router.delete('/admin/:id', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting review:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting review'
    });
  }
});

module.exports = router;
