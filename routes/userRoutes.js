const express = require('express');
const router = express.Router();
const User = require('../models/user');
const KYCVerification = require('../models/KYCVerification');
const { protect } = require('../middleware/authMiddleware');

// Get user profile
router.get('/profile', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Get additional KYC data if available
        const kyc = await KYCVerification.findOne({ email: user.email });

        res.json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                firstName: user.firstName || user.name?.split(' ')[0],
                lastName: user.lastName || user.name?.split(' ').slice(1).join(' '),
                email: user.email,
                phone: user.phone,
                address: user.address || kyc?.address || '',
                city: user.city || kyc?.city || '',
                bio: user.bio || '',
                profileImage: user.profileImage || null,
                role: user.role,
                isActive: user.isActive,
                createdAt: user.createdAt,
                stats: {
                    bookings: user.bookings?.length || 0,
                    favourites: user.favourites?.length || 0,
                    reviews: user.reviews?.length || 0
                }
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ message: 'Failed to load profile', error: error.message });
    }
});

// Update user profile
router.put('/profile', protect, async (req, res) => {
    try {
        const { name, firstName, lastName, phone, address, city, bio } = req.body;

        const updateData = {};
        if (name) updateData.name = name;
        if (firstName && lastName) updateData.name = `${firstName} ${lastName}`.trim();
        if (phone) updateData.phone = phone;
        if (address) updateData.address = address;
        if (city) updateData.city = city;
        if (bio) updateData.bio = bio;

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: updateData },
            { new: true, select: '-password' }
        );

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Also update KYC if exists
        await KYCVerification.findOneAndUpdate(
            { email: user.email },
            { $set: { firstName: firstName || user.name?.split(' ')[0], lastName: lastName || '', phone: phone || user.phone, address: address || '', city: city || '' } }
        );

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ message: 'Failed to update profile', error: error.message });
    }
});

// Get user settings
router.get('/settings', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('settings email phone');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            success: true,
            settings: user.settings || {
                notifications: {
                    email: true,
                    sms: true,
                    push: true,
                    marketing: false
                },
                privacy: {
                    profileVisible: true,
                    showPhone: false,
                    showEmail: false
                },
                preferences: {
                    darkMode: false,
                    language: 'en'
                }
            }
        });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ message: 'Failed to load settings', error: error.message });
    }
});

// Update user settings
router.put('/settings', protect, async (req, res) => {
    try {
        const { notifications, privacy, preferences } = req.body;

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: { settings: { notifications, privacy, preferences } } },
            { new: true, select: '-password' }
        );

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            success: true,
            message: 'Settings saved successfully',
            settings: user.settings
        });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ message: 'Failed to save settings', error: error.message });
    }
});

// Change password
router.put('/change-password', protect, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Verify current password
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        // Update password
        user.password = newPassword;
        await user.save();

        res.json({
            success: true,
            message: 'Password changed successfully'
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Failed to change password', error: error.message });
    }
});

// Get favourites
router.get('/favourites', protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .populate('favourites', 'name location area price images rating type amenities gender');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            success: true,
            favourites: user.favourites || []
        });
    } catch (error) {
        console.error('Get favourites error:', error);
        res.status(500).json({ message: 'Failed to load favourites', error: error.message });
    }
});

// Add to favourites
router.post('/favourites/:propertyId', protect, async (req, res) => {
    try {
        const { propertyId } = req.params;

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if already in favourites
        if (user.favourites?.includes(propertyId)) {
            return res.status(400).json({ message: 'Property already in favourites' });
        }

        // Add to favourites
        user.favourites = user.favourites || [];
        user.favourites.push(propertyId);
        await user.save();

        res.json({
            success: true,
            message: 'Added to favourites'
        });
    } catch (error) {
        console.error('Add favourite error:', error);
        res.status(500).json({ message: 'Failed to add favourite', error: error.message });
    }
});

// Remove from favourites
router.delete('/favourites/:propertyId', protect, async (req, res) => {
    try {
        const { propertyId } = req.params;

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Remove from favourites
        user.favourites = user.favourites?.filter(id => id.toString() !== propertyId) || [];
        await user.save();

        res.json({
            success: true,
            message: 'Removed from favourites'
        });
    } catch (error) {
        console.error('Remove favourite error:', error);
        res.status(500).json({ message: 'Failed to remove favourite', error: error.message });
    }
});

// Delete account - permanently delete from database
router.delete('/account', protect, async (req, res) => {
    try {
        const { password } = req.body;

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Verify password
        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Password is incorrect' });
        }

        const userEmail = user.email;

        // Hard delete - remove user completely
        await User.findByIdAndDelete(req.user.id);

        // Also delete related KYC data
        await KYCVerification.deleteOne({ email: userEmail });

        res.json({
            success: true,
            message: 'Account deleted successfully'
        });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ message: 'Failed to delete account', error: error.message });
    }
});

// Seed user - for development only
router.post('/seed-user', async (req, res) => {
    try {
        const bcrypt = require('bcryptjs');
        const KYCVerification = require('../models/KYCVerification');

        // Check if user already exists
        let user = await User.findOne({ email: 'harshdeepbca503@gmail.com' });
        if (user) {
            // Delete existing user
            await User.findByIdAndDelete(user._id);
        }

        // Delete existing KYC entry
        await KYCVerification.deleteOne({ email: 'harshdeepbca503@gmail.com' });

        // Create new user with hashed password
        const hashedPassword = await bcrypt.hash('123456', 10);

        user = new User({
            name: 'Harshdeep',
            email: 'harshdeepbca503@gmail.com',
            phone: '9464165010',
            password: hashedPassword,
            role: 'tenant',
            isActive: true,
            status: 'active',
            firstName: 'Harshdeep',
            lastName: '',
            loginId: 'harshdeepbca503@gmail.com',
            settings: {
                notifications: {
                    email: true,
                    sms: true,
                    push: true,
                    marketing: false
                },
                privacy: {
                    profileVisible: true,
                    showPhone: false,
                    showEmail: false
                },
                preferences: {
                    darkMode: false,
                    language: 'en'
                }
            },
            favourites: [],
            bookings: [],
            reviews: []
        });

        await user.save();

        // Create KYCVerification entry for OTP login
        const kyc = new KYCVerification({
            id: `roomhyweb${String(Date.now()).slice(-6)}`,
            email: 'harshdeepbca503@gmail.com',
            firstName: 'Harshdeep',
            lastName: '',
            phone: '9464165010',
            status: 'pending',
            kycStatus: 'pending',
            role: 'tenant',
            loginId: 'harshdeepbca503@gmail.com',
            password: hashedPassword,
            from: 'website'
        });

        await kyc.save();

        res.json({
            success: true,
            message: 'User and KYC entry created successfully',
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                phone: user.phone
            }
        });
    } catch (error) {
        console.error('Seed user error:', error);
        res.status(500).json({ message: 'Failed to create user', error: error.message });
    }
});

module.exports = router;
