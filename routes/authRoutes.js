const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter, otpLimiter, captchaProtection } = require('../middleware/security');

router.use(authLimiter);

router.post('/login', authController.login);

router.get('/debug-emp', async (req, res) => {
    try {
        const Employee = require('../models/Employee');
        const emp = await Employee.findOne({ loginId: 'RY7752' });
        res.json(emp);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/register', authController.register);
router.get('/me', protect, authController.me);

// Owner specific flows (temp password verification and set new password)
router.post('/reset-initial-password', authController.resetInitialPasswordAll);
router.post('/owner/verify-temp', authController.verifyOwnerTemp);
router.post('/owner/set-password', authController.setOwnerPassword);
router.post('/owner/forgot-password/request-otp', otpLimiter, captchaProtection({ required: false }), authController.ownerForgotPasswordRequestOTP);
router.post('/owner/forgot-password/verify-otp', otpLimiter, authController.ownerForgotPasswordVerifyOTP);
router.post('/owner/forgot-password/reset-password', authController.ownerForgotPasswordReset);

// Tenant specific flows (temp password verification and set new password)
router.post('/tenant/verify-temp', authController.verifyTenantTemp);
router.post('/tenant/set-password', authController.setTenantPassword);
router.post('/tenant/forgot-password/request-otp', otpLimiter, captchaProtection({ required: false }), authController.tenantForgotPasswordRequestOTP);
router.post('/tenant/forgot-password/verify-otp', otpLimiter, authController.tenantForgotPasswordVerifyOTP);
router.post('/tenant/forgot-password/reset-password', authController.tenantForgotPasswordReset);

// Forgot Password Flow
router.post('/forgot-password/request-otp', otpLimiter, captchaProtection({ required: false }), authController.forgotPasswordRequestOTP);
router.post('/forgot-password/verify-otp', otpLimiter, authController.forgotPasswordVerifyOTP);
router.post('/forgot-password/reset-password', authController.forgotPasswordReset);

module.exports = router;
