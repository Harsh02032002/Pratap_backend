const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter, otpLimiter, authIpLimiter, otpIpLimiter, captchaProtection } = require('../middleware/security');

// router.use(authLimiter); // Removed global auth limiter as it affects /me and other routes

router.post('/login', authController.login);

router.get('/debug-emp', async (req, res) => {
    try {
        const Employee = require('../models/Employee');
        const User = require('../models/user');
        const emps = await Employee.find({});
        const usrs = await User.find({});
        res.json({ 
            allEmployees: emps.map(e => ({ name: e.name, loginId: e.loginId, email: e.email, password: e.password })),
            allUsers: usrs.map(u => ({ name: u.name, loginId: u.loginId, email: u.email, role: u.role, password: u.password }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/register', authIpLimiter, authLimiter, authController.register);
router.get('/me', protect, authController.me);

// Owner specific flows (temp password verification and set new password)
router.post('/reset-initial-password', authController.resetInitialPasswordAll);
router.post('/owner/verify-temp', authIpLimiter, authLimiter, authController.verifyOwnerTemp);
router.post('/owner/set-password', authIpLimiter, authLimiter, authController.setOwnerPassword);
router.post('/owner/forgot-password/request-otp', otpIpLimiter, otpLimiter, captchaProtection({ required: false }), authController.ownerForgotPasswordRequestOTP);
router.post('/owner/forgot-password/verify-otp', otpIpLimiter, otpLimiter, authController.ownerForgotPasswordVerifyOTP);
router.post('/owner/forgot-password/reset-password', authIpLimiter, authLimiter, authController.ownerForgotPasswordReset);

// Tenant specific flows (temp password verification and set new password)
router.post('/tenant/verify-temp', authIpLimiter, authLimiter, authController.verifyTenantTemp);
router.post('/tenant/set-password', authIpLimiter, authLimiter, authController.setTenantPassword);
router.post('/tenant/forgot-password/request-otp', otpIpLimiter, otpLimiter, captchaProtection({ required: false }), authController.tenantForgotPasswordRequestOTP);
router.post('/tenant/forgot-password/verify-otp', otpIpLimiter, otpLimiter, authController.tenantForgotPasswordVerifyOTP);
router.post('/tenant/forgot-password/reset-password', authIpLimiter, authLimiter, authController.tenantForgotPasswordReset);

// Forgot Password Flow
router.post('/forgot-password/request-otp', otpIpLimiter, otpLimiter, captchaProtection({ required: false }), authController.forgotPasswordRequestOTP);
router.post('/forgot-password/verify-otp', otpIpLimiter, otpLimiter, authController.forgotPasswordVerifyOTP);
router.post('/forgot-password/reset-password', authIpLimiter, authLimiter, authController.forgotPasswordReset);

// TEMPORARY: Reset password for specific user without old password
router.post('/temp-reset-password', async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword) {
            return res.status(400).json({ success: false, message: 'Email and new password required' });
        }
        
        const User = require('../models/user');
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        user.password = newPassword;
        user.requirePasswordReset = false;
        await user.save();
        
        console.log(`[TEMP RESET] Password reset for ${email}`);
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        console.error('[TEMP RESET] Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
