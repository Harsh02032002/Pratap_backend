const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter, otpLimiter, captchaProtection } = require('../middleware/security');

// router.use(authLimiter); // Removed global auth limiter as it affects /me and other routes

router.post('/login', authLimiter, authController.login);

router.get('/debug-emp', async (req, res) => {
    try {
        const Employee = require('../models/Employee');
        const emp = await Employee.findOne({ loginId: 'RY7752' });
        res.json(emp);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/register', authLimiter, authController.register);
router.get('/me', protect, authController.me);

// Owner specific flows (temp password verification and set new password)
router.post('/reset-initial-password', authController.resetInitialPasswordAll);
router.post('/owner/verify-temp', authLimiter, authController.verifyOwnerTemp);
router.post('/owner/set-password', authLimiter, authController.setOwnerPassword);
router.post('/owner/forgot-password/request-otp', otpLimiter, captchaProtection({ required: false }), authController.ownerForgotPasswordRequestOTP);
router.post('/owner/forgot-password/verify-otp', otpLimiter, authController.ownerForgotPasswordVerifyOTP);
router.post('/owner/forgot-password/reset-password', authLimiter, authController.ownerForgotPasswordReset);

// Tenant specific flows (temp password verification and set new password)
router.post('/tenant/verify-temp', authLimiter, authController.verifyTenantTemp);
router.post('/tenant/set-password', authLimiter, authController.setTenantPassword);
router.post('/tenant/forgot-password/request-otp', otpLimiter, captchaProtection({ required: false }), authController.tenantForgotPasswordRequestOTP);
router.post('/tenant/forgot-password/verify-otp', otpLimiter, authController.tenantForgotPasswordVerifyOTP);
router.post('/tenant/forgot-password/reset-password', authLimiter, authController.tenantForgotPasswordReset);

// Forgot Password Flow
router.post('/forgot-password/request-otp', otpLimiter, captchaProtection({ required: false }), authController.forgotPasswordRequestOTP);
router.post('/forgot-password/verify-otp', otpLimiter, authController.forgotPasswordVerifyOTP);
router.post('/forgot-password/reset-password', authLimiter, authController.forgotPasswordReset);

module.exports = router;
