const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const { protect, authorize } = require('../middleware/authMiddleware');

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
      message: 'Error fetching reviews',
      error: error.message
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
    res.status(500).json({
      success: false,
      message: 'Error fetching featured reviews',
      error: error.message
    });
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
    res.status(500).json({
      success: false,
      message: 'Error fetching top rated reviews',
      error: error.message
    });
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
    res.status(500).json({
      success: false,
      message: 'Error fetching review statistics',
      error: error.message
    });
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
    res.status(500).json({
      success: false,
      message: 'Error fetching property reviews',
      error: error.message
    });
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
        data: {
          avgRating: 0,
          totalReviews: 0,
          ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
        }
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
    res.status(500).json({
      success: false,
      message: 'Error fetching property rating stats',
      error: error.message
    });
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
      message: 'Error checking user review',
      error: error.message
    });
  }
});

// ============================================================
// GET: Fetch single review by ID (public)
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    
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
      message: 'Error fetching review',
      error: error.message
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
    if (!propertyId || !propertyName || !rating || !review) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: propertyId, propertyName, rating, review'
      });
    }
    
    // Check if user has already reviewed this property
    const existingReview = await Review.hasUserReviewed(propertyId, userId);
    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this property'
      });
    }

    // ✅ NEW: Verify if the user has actually bought (booked) the property
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

    if (!userBooking) {
      return res.status(403).json({
        success: false,
        message: 'Access Denied: Reviews are only allowed for guests with a confirmed and paid booking for this property.'
      });
    }
    
    // Create new review
    const newReview = await Review.create({
      propertyId,
      propertyName,
      userId,
      name,
      email,
      rating: parseInt(rating),
      review,
      isVerified: false,
      isFeatured: false,
      status: 'Active'
    });
    
    res.status(201).json({
      success: true,
      message: 'Review submitted successfully. It will be visible after approval.',
      data: newReview
    });
  } catch (error) {
    console.error('Error creating review:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating review',
      error: error.message
    });
  }
});

// ============================================================
// PUT: Update review (protected - admin only)
// ============================================================
router.put('/:id', protect, authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { isFeatured, isVerified, status } = req.body;
    
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { 
        isFeatured, 
        isVerified, 
        status,
        updatedAt: Date.now()
      },
      { new: true, runValidators: true }
    );
    
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Review updated successfully',
      data: review
    });
  } catch (error) {
    console.error('Error updating review:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating review',
      error: error.message
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
      message: 'Error fetching user reviews',
      error: error.message
    });
  }
});

// ============================================================
// PUT: Update own review (protected - owner only)
// ============================================================
router.put('/:id', protect, async (req, res) => {
  try {
    const { text, rating } = req.body;

    // Find review and check ownership
    const review = await Review.findOne({
      _id: req.params.id,
      userId: req.user.id
    });

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or you do not have permission to update it'
      });
    }

    // Update fields
    if (text) review.reviewText = text;
    if (text) review.text = text;
    if (rating) review.rating = rating;

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
      message: 'Error updating review',
      error: error.message
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
      message: 'Error deleting review',
      error: error.message
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
      message: 'Error deleting review',
      error: error.message
    });
  }
});

module.exports = router;
