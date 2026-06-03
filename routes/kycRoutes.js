const express = require('express');
const router = express.Router();
const KYCVerification = require('../models/KYCVerification');
const User = require('../models/user');
const jwt = require('jsonwebtoken');
const mailer = require('../utils/mailer');
const { notifySuperadmin } = require('../utils/superadminNotifier');
const { formLimiter, otpLimiter, captchaProtection } = require('../middleware/security');
const { sendOTPSMS, formatPhoneNumber } = require('../utils/smsService');

// Temporary OTP store (for production, move to Redis/database)
const signupOtpStore = new Map();
const loginOtpStore = new Map();

function generateSignupOtp() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function generateToken(user) {
    return jwt.sign(
        { id: user._id, role: user.role },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '7d' }
    );
}

function renderOtpHtml(firstName, otp) {
    return `
        <html>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #2563eb;">Roomhy Signup Verification</h2>
                    <p>Hi ${firstName || 'User'},</p>
                    <p>Use this verification code to complete your account signup:</p>
                    <div style="background: #f1f5f9; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                        <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #1d4ed8;">${otp}</div>
                        <div style="margin-top: 8px; color: #64748b;">Valid for 10 minutes</div>
                    </div>
                    <p>If you did not request this, please ignore this email.</p>
                </div>
            </body>
        </html>
    `;
}

function renderLoginOtpHtml(firstName, otp) {
    return `
        <html>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #2563eb;">Roomhy Login Verification</h2>
                    <p>Hi ${firstName || 'User'},</p>
                    <p>Use this verification code to login to your Roomhy account:</p>
                    <div style="background: #f1f5f9; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                        <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #1d4ed8;">${otp}</div>
                        <div style="margin-top: 8px; color: #64748b;">Valid for 10 minutes</div>
                    </div>
                    <p>If you did not request this, please ignore this email.</p>
                </div>
            </body>
        </html>
    `;
}

// Request OTP for website signup
router.post('/signup/request-otp', otpLimiter, captchaProtection({ required: false }), async (req, res) => {
    try {
        const firstName = (req.body.firstName || '').toString().trim();
        const lastName = (req.body.lastName || '').toString().trim();
        const email = (req.body.email || '').toString().trim().toLowerCase();
        const phone = (req.body.phone || '').toString().trim();
        const password = (req.body.password || '').toString();

        if (!firstName || !email || !phone || !password) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        if (!/^\d{10}$/.test(phone)) {
            return res.status(400).json({ message: 'Phone number must be 10 digits' });
        }

        const existingUser = await User.findOne({ $or: [{ email }, { phone }] });
        if (existingUser) {
            return res.status(400).json({ message: 'Email or phone already registered' });
        }

        const existingSignup = await KYCVerification.findOne({ email });
        if (existingSignup && existingSignup.status !== 'rejected') {
            const existingSignupUser = await User.findOne({ $or: [{ email }, { loginId: email }] });
            if (existingSignupUser) {
                return res.status(400).json({ message: 'Email already registered' });
            }
        }

        const otp = generateSignupOtp();
        signupOtpStore.set(email, {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000,
            payload: { firstName, lastName, email, phone, password }
        });

        if (existingSignup) {
            await KYCVerification.findOneAndUpdate(
                { email },
                {
                    $set: {
                        firstName,
                        lastName,
                        phone,
                        role: existingSignup.role || 'tenant',
                        status: existingSignup.status === 'rejected' ? 'pending' : existingSignup.status,
                        kycStatus: existingSignup.kycStatus === 'rejected' ? 'pending' : existingSignup.kycStatus
                    }
                }
            );
        }

        const delivery = {
            email: false,
            whatsapp: false,
            sms: false
        };

        // Send Email OTP
        delivery.email = await mailer.sendMail(
            email,
            'Roomhy - Your Signup Verification Code',
            `Your Roomhy verification code is ${otp}. It is valid for 10 minutes.`,
            renderOtpHtml(firstName, otp)
        );

        // Send WhatsApp OTP
        const formattedPhone = formatPhoneNumber(phone);
        try {
            const whatsappSent = await mailer.sendDirectWhatsAppOtp(formattedPhone, otp);
            if (whatsappSent) {
                delivery.whatsapp = true;
                console.log(`WhatsApp OTP sent to ${formattedPhone}`);
            }
        } catch (err) {
            console.error('WhatsApp OTP error:', err.message);
        }

        // Send mobile OTP (Twilio / SMS providers)
        sendOTPSMS(formattedPhone, otp, 'signup').then(smsResult => {
            if (smsResult.success) {
                delivery.sms = true;
                console.log(`SMS OTP sent via ${smsResult.provider} to ${formattedPhone}`);
            }
        }).catch(err => {
            console.error('SMS OTP error:', err.message);
        });

        return res.json({
            success: true,
            message: delivery.email && (delivery.whatsapp || delivery.sms)
                ? 'Verification code sent to your email and mobile'
                : delivery.email
                ? 'Verification code sent to your email. Mobile OTP may take a moment.'
                : (delivery.whatsapp || delivery.sms)
                ? 'Verification code sent to your mobile'
                : 'Verification code generated, but email/mobile delivery failed. Please check server config.',
            channels: delivery,
            ...(process.env.NODE_ENV === 'development' && { demoOtp: otp })
        });
    } catch (error) {
        console.error('signup/request-otp error:', error);
        return res.status(500).json({ message: 'Unable to send verification code', error: error.message });
    }
});

// Verify OTP and complete signup (create user + KYC record + send credentials)
router.post('/signup/verify-and-create', async (req, res) => {
    try {
        const firstName = (req.body.firstName || '').toString().trim();
        const lastName = (req.body.lastName || '').toString().trim();
        const email = (req.body.email || '').toString().trim().toLowerCase();
        const phone = (req.body.phone || '').toString().trim();
        const password = (req.body.password || '').toString();
        const otp = (req.body.otp || '').toString().trim();

        if (!firstName || !email || !phone || !password || !otp) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const otpEntry = signupOtpStore.get(email);
        if (!otpEntry) {
            return res.status(401).json({ message: 'Verification code expired or not requested' });
        }
        if (Date.now() > otpEntry.expiresAt) {
            signupOtpStore.delete(email);
            return res.status(401).json({ message: 'Verification code has expired' });
        }
        if (otpEntry.otp !== otp) {
            return res.status(401).json({ message: 'Invalid verification code' });
        }

        const pending = otpEntry.payload || {};
        if (
            pending.email !== email ||
            pending.phone !== phone ||
            pending.password !== password ||
            pending.firstName !== firstName ||
            (pending.lastName || '') !== lastName
        ) {
            return res.status(400).json({ message: 'Signup details changed. Request a new verification code.' });
        }

        const existing = await User.findOne({ $or: [{ email }, { phone }] });
        if (existing) {
            signupOtpStore.delete(email);
            return res.status(400).json({ message: 'Email or phone already registered' });
        }

        const fullName = `${firstName} ${lastName}`.trim();
        const loginId = email;
        const userRole = 'tenant';

        const user = await User.create({
            name: fullName,
            email,
            phone,
            password,
            role: userRole,
            loginId
        });

        const signupId = `roomhyweb${String(Date.now()).slice(-6)}`;
        await KYCVerification.findOneAndUpdate(
            { email },
            {
                $set: {
                    loginId,
                    firstName,
                    lastName,
                    phone,
                    role: userRole,
                    status: 'pending',
                    kycStatus: 'pending',
                    password: user.password
                },
                $setOnInsert: {
                    id: signupId,
                    createdAt: new Date()
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        try {
            await notifySuperadmin({
                type: 'new_signup',
                from: 'website',
                subject: 'New Signup Verified',
                message: 'A new user completed signup verification.',
                meta: { userId: loginId, firstName, lastName, email, phone }
            });
        } catch (notifyErr) {
            console.warn('new signup notification failed:', notifyErr.message);
        }

        const credentialsHtml = `
            <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #2563eb;">Welcome to Roomhy</h2>
                        <p>Hi ${firstName}, your account is created successfully.</p>
                        <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 16px; margin: 20px 0;">
                            <p style="margin: 0 0 8px 0;"><strong>User ID:</strong> ${loginId}</p>
                            <p style="margin: 0;"><strong>Password:</strong> ${password}</p>
                        </div>
                        <p>Please keep these credentials secure.</p>
                    </div>
                </body>
            </html>
        `;
        await mailer.sendMail(
            email,
            'Roomhy - Your Login Credentials',
            `User ID: ${loginId}\nPassword: ${password}`,
            credentialsHtml
        );

        signupOtpStore.delete(email);

        const token = generateToken(user);
        return res.status(201).json({
            success: true,
            message: 'Signup verified and account created successfully',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                loginId: user.loginId
            }
        });
    } catch (error) {
        console.error('signup/verify-and-create error:', error);
        return res.status(500).json({ message: 'Unable to complete signup', error: error.message });
    }
});

// Request OTP for website login using email from new signups
router.post('/login/request-otp', otpLimiter, captchaProtection({ required: false }), async (req, res) => {
    try {
        const email = (req.body.email || '').toString().trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const signup = await KYCVerification.findOne({ email });
        if (!signup) {
            return res.status(404).json({ message: 'This Gmail is not available in new signups' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'Account is not ready for login yet. Please complete signup first.' });
        }

        if (user.isActive === false) {
            return res.status(403).json({ message: 'Account disabled' });
        }

        const otp = generateSignupOtp();
        loginOtpStore.set(email, {
            otp,
            expiresAt: Date.now() + 10 * 60 * 1000,
            email
        });

        const delivery = {
            email: false,
            whatsapp: false,
            sms: false
        };

        delivery.email = await mailer.sendMail(
            email,
            'Roomhy - Your Login Verification Code',
            `Your Roomhy login verification code is ${otp}. It is valid for 10 minutes.`,
            renderLoginOtpHtml(signup.firstName || user.name, otp)
        );

        // Send WhatsApp OTP
        if (user.phone) {
            const formattedPhone = formatPhoneNumber(user.phone);
            try {
                const whatsappSent = await mailer.sendDirectWhatsAppOtp(formattedPhone, otp);
                if (whatsappSent) {
                    delivery.whatsapp = true;
                    console.log(`WhatsApp login OTP sent to ${formattedPhone}`);
                }
            } catch (err) {
                console.error('WhatsApp login OTP error:', err.message);
            }

            // Send mobile OTP (Twilio / SMS providers)
            sendOTPSMS(formattedPhone, otp, 'login').then(smsResult => {
                if (smsResult.success) {
                    delivery.sms = true;
                    console.log(`Login SMS OTP sent via ${smsResult.provider} to ${formattedPhone}`);
                }
            }).catch(err => {
                console.error('Login SMS OTP error:', err.message);
            });
        }

        return res.json({
            success: true,
            message: delivery.email && (delivery.whatsapp || delivery.sms)
                ? 'Login verification code sent to your email and mobile'
                : delivery.email
                ? 'Login verification code sent to your email. Mobile OTP may take a moment.'
                : (delivery.whatsapp || delivery.sms)
                ? 'Login verification code sent to your mobile'
                : 'Verification code generated, but email/mobile delivery failed. Please check server config.',
            channels: delivery,
            ...(process.env.NODE_ENV === 'development' && { demoOtp: otp })
        });
    } catch (error) {
        console.error('login/request-otp error:', error);
        return res.status(500).json({ message: 'Unable to send login verification code', error: error.message });
    }
});

// Verify OTP and login website user using email from new signups
router.post('/login/verify-otp', async (req, res) => {
    try {
        const email = (req.body.email || '').toString().trim().toLowerCase();
        const otp = (req.body.otp || '').toString().trim();

        if (!email || !otp) {
            return res.status(400).json({ message: 'Email and verification code are required' });
        }

        const otpEntry = loginOtpStore.get(email);
        if (!otpEntry) {
            return res.status(401).json({ message: 'Verification code expired or not requested' });
        }
        if (Date.now() > otpEntry.expiresAt) {
            loginOtpStore.delete(email);
            return res.status(401).json({ message: 'Verification code has expired' });
        }
        if (otpEntry.otp !== otp) {
            return res.status(401).json({ message: 'Invalid verification code' });
        }

        const signup = await KYCVerification.findOne({ email });
        if (!signup) {
            loginOtpStore.delete(email);
            return res.status(404).json({ message: 'Signup record not found for this email' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            loginOtpStore.delete(email);
            return res.status(404).json({ message: 'Account is not ready for login yet. Please contact support.' });
        }

        if (user.isActive === false) {
            loginOtpStore.delete(email);
            return res.status(403).json({ message: 'Account disabled' });
        }

        loginOtpStore.delete(email);

        const token = generateToken(user);
        return res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                role: user.role,
                loginId: user.loginId
            }
        });
    } catch (error) {
        console.error('login/verify-otp error:', error);
        return res.status(500).json({ message: 'Unable to verify login code', error: error.message });
    }
});

// Get all signups from MongoDB
router.get('/', async (req, res) => {
    try {
        const signups = await KYCVerification.find().select('-password');
        console.log(`✓ Retrieved ${signups.length} signups from MongoDB`);
        res.json(signups);
    } catch (error) {
        console.error('Error fetching signups:', error);
        res.status(500).json({ message: 'Error fetching signups', error: error.message });
    }
});

// Submit new signup
router.post('/submit', formLimiter, captchaProtection({ required: false }), async (req, res) => {
    try {
        const signupData = req.body;

        // Check if email already exists
        const existing = await KYCVerification.findOne({ email: signupData.email });
        if (existing) {
            return res.status(400).json({ message: 'Email already registered' });
        }

        // Create new signup in MongoDB
        const newSignup = new KYCVerification({
            id: signupData.id,
            loginId: signupData.loginId,
            firstName: signupData.firstName,
            lastName: signupData.lastName,
            email: signupData.email,
            phone: signupData.phone,
            password: signupData.password,
            role: signupData.role || 'tenant',
            kycStatus: signupData.kycStatus || 'pending',
            status: signupData.status || 'pending',
            createdAt: new Date()
        });

        await newSignup.save();
        try {
            await notifySuperadmin({
                type: 'new_signup',
                from: 'website',
                subject: 'New User Signup - Account Created',
                message: 'A new signup was created and is pending verification.',
                meta: {
                    userId: signupData.id || signupData.loginId || signupData.email,
                    firstName: signupData.firstName,
                    lastName: signupData.lastName,
                    email: signupData.email,
                    phone: signupData.phone
                }
            });
        } catch (notifyErr) {
            console.warn('signup submit notification failed:', notifyErr.message);
        }
        console.log(`✓ New signup saved to MongoDB: ${signupData.email}`);

        // Send email notification to superadmin
        try {
            const mailer = require('../utils/mailer');
            const superadminEmail = process.env.SUPERADMIN_EMAIL || process.env.MAILJET_FROM_EMAIL || 'roomhy01@gmail.com';
            const subject = 'New User Signup - Account Created';
            const html = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">New User Account Created</h2>
                    <p>A new user has created an account and is pending verification.</p>
                    <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                        <p><strong>Name:</strong> ${signupData.firstName} ${signupData.lastName || ''}</p>
                        <p><strong>Email:</strong> ${signupData.email}</p>
                        <p><strong>Phone:</strong> ${signupData.phone || 'Not provided'}</p>
                        <p><strong>User ID:</strong> ${signupData.id}</p>
                        <p><strong>Status:</strong> ${signupData.status}</p>
                        <p><strong>Created:</strong> ${new Date().toLocaleString()}</p>
                    </div>
                    <p>Please review and verify this user in the superadmin new signups panel.</p>
                </div>
            `;
            await mailer.sendMail(superadminEmail, subject, '', html);
            console.log('✓ Signup notification email sent successfully');
        } catch (emailError) {
            console.error('Failed to send signup notification email:', emailError);
        }

        res.status(201).json({ message: 'Signup submitted successfully', data: newSignup });
    } catch (error) {
        console.error('Error submitting signup:', error);
        res.status(500).json({ message: 'Error submitting signup', error: error.message });
    }
});

// Get signup by ID
router.get('/:id', async (req, res) => {
    try {
        const signup = await KYCVerification.findById(req.params.id).select('-password');
        if (!signup) {
            return res.status(404).json({ message: 'Signup not found' });
        }
        res.json(signup);
    } catch (error) {
        console.error('Error fetching signup:', error);
        res.status(500).json({ message: 'Error fetching signup', error: error.message });
    }
});

// Update signup status
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, kycStatus } = req.body;

        const signup = await KYCVerification.findByIdAndUpdate(
            id,
            {
                status: status || undefined,
                kycStatus: kycStatus || undefined,
                verifiedAt: (kycStatus === 'verified') ? new Date() : undefined
            },
            { new: true }
        ).select('-password');

        if (!signup) {
            return res.status(404).json({ message: 'Signup not found' });
        }

        console.log(`✓ Signup updated: ${signup.email}`);
        res.json({ message: 'Signup updated successfully', data: signup });
    } catch (error) {
        console.error('Error updating signup:', error);
        res.status(500).json({ message: 'Error updating signup', error: error.message });
    }
});

// Verify signup by email
router.put('/verify-by-email/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const { status, kycStatus, verifiedAt } = req.body;

        const signup = await KYCVerification.findOneAndUpdate(
            { email: email },
            {
                status: status || 'verified',
                kycStatus: kycStatus || 'verified',
                verifiedAt: verifiedAt || new Date()
            },
            { new: true }
        ).select('-password');

        if (!signup) {
            return res.status(404).json({ message: 'Signup not found' });
        }

        console.log(`✅ Signup verified via email: ${email}`);
        res.json({ message: 'Signup verified successfully', data: signup });
    } catch (error) {
        console.error('Error verifying signup:', error);
        res.status(500).json({ message: 'Error verifying signup', error: error.message });
    }
});

// Alternative verify endpoint (simpler POST)
router.post('/verify', async (req, res) => {
    try {
        const { email, status, kycStatus } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const signup = await KYCVerification.findOneAndUpdate(
            { email: email },
            {
                status: status || 'verified',
                kycStatus: kycStatus || 'verified',
                verifiedAt: new Date()
            },
            { new: true }
        ).select('-password');

        if (!signup) {
            return res.status(404).json({ message: 'Signup not found for email: ' + email });
        }

        console.log(`✅ Signup verified: ${email}`);
        res.json({ message: 'Signup verified successfully', data: signup });
    } catch (error) {
        console.error('Error verifying signup:', error);
        res.status(500).json({ message: 'Error verifying signup', error: error.message });
    }
});

// Delete signup (Admin only)
router.delete('/:id', async (req, res) => {
    try {
        const signup = await KYCVerification.findByIdAndDelete(req.params.id);
        if (!signup) {
            return res.status(404).json({ message: 'Signup not found' });
        }
        console.log(`✓ Signup deleted: ${signup.email}`);
        res.json({ message: 'Signup deleted successfully' });
    } catch (error) {
        console.error('Error deleting signup:', error);
        res.status(500).json({ message: 'Error deleting signup', error: error.message });
    }
});

module.exports = router;
