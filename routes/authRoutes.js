const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter, otpLimiter, authIpLimiter, otpIpLimiter, captchaProtection } = require('../middleware/security');

// router.use(authLimiter); // Removed global auth limiter as it affects /me and other routes

// Guarded like every other credential endpoint below. Without these, login was
// bounded only by globalApiLimiter — which keys a login POST by the submitted
// email, so that limit was also the password-guessing budget for an account.
router.post('/login', authIpLimiter, authLimiter, authController.login);

// Removed: GET /debug-emp — an unauthenticated endpoint that returned every
// Employee and User record including the `password` field. Nothing referenced it.

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

// Removed: POST /temp-reset-password — set any account's password given only
// an email address, with no authentication, OTP or token. Nothing referenced
// it. The supported path is the /forgot-password/* OTP flow above.

module.exports = router;
