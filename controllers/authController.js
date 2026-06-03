const User = require('../models/user');
const Tenant = require('../models/Tenant');
const AreaManager = require('../models/AreaManager');
const Employee = require('../models/Employee');
const Owner = require('../models/Owner');
const KYCVerification = require('../models/KYCVerification');
const jwt = require('jsonwebtoken');
const mailer = require('../utils/mailer');
const { sendTemplateToResolvedUser } = require('../utils/whatsappBot');
const OWNER_LOGIN_ID_REGEX = /^ROOMHY\d{4}$/i;

// OTP storage (in production, use Redis or database)
const otpStore = new Map();

function generateToken(user) {
    return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
}

// Generate 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send email
async function sendEmail(to, subject, html) {
    try {
        if (!to) {
            console.warn('[Email] No recipient email provided');
            return true; // Allow to continue in development
        }

        const sent = await mailer.sendMail(to, subject, '', html);
        if (!sent) {
            console.warn('[Email] Mailjet delivery failed or not configured; continuing request flow.');
            return true; // Keep auth flow non-blocking in development
        }

        console.log('[Email] Successfully sent email via Mailjet to:', to);
        return true;
    } catch (err) {
        console.warn('[Email] Failed to send email - continuing anyway for development:', err.message);
        return true; // Allow to continue even if email fails (for development)
    }
}

// Forgot Password: Request OTP
exports.forgotPasswordRequestOTP = async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        console.log('[ForgotPassword] Request OTP for email:', email);

        // Check if email exists in staff users
        let user = null;
        
        try {
            // Try MongoDB User model first (superadmin, managers, etc.)
            user = await User.findOne({ 
                email, 
                $or: [
                    { role: 'superadmin' },
                    { role: 'areamanager' },
                    { role: 'manager' },
                    { role: 'admin' }
                ]
            });
            
            if (user) {
                console.log('[ForgotPassword] Found user in User collection:', user.email);
            }
        } catch (dbErr) {
            console.warn('[ForgotPassword] Error checking User collection:', dbErr.message);
        }

        // If not found in User collection, check AreaManager collection
        if (!user) {
            try {
                user = await AreaManager.findOne({ 
                    email: email.toLowerCase(),
                    isActive: true
                });
                
                if (user) {
                    console.log('[ForgotPassword] Found user in AreaManager collection:', user.email);
                }
            } catch (dbErr) {
                console.warn('[ForgotPassword] Error checking AreaManager collection:', dbErr.message);
            }
        }

        // If not found, check Employee collection
        if (!user) {
            try {
                user = await Employee.findOne({ 
                    email: email.toLowerCase(),
                    isActive: true
                });
                
                if (user) {
                    console.log('[ForgotPassword] Found user in Employee collection:', user.email);
                }
            } catch (dbErr) {
                console.warn('[ForgotPassword] Error checking Employee collection:', dbErr.message);
            }
        }

        if (!user) {
            console.log('[ForgotPassword] Email not found in any staff system');
            return res.status(404).json({ message: 'Email not found in staff management system. Please verify the email address.' });
        }

        if (user.isActive === false) {
            return res.status(403).json({ message: 'Account is disabled' });
        }

        // Generate OTP
        const otp = generateOTP();
        const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes

        // Store OTP with email and expiry
        otpStore.set(email, { otp, expiryTime });
        console.log('[ForgotPassword] Generated OTP for:', email);

        // Send OTP email
        const emailHtml = `
            <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #4f46e5;">Password Reset Request</h2>
                        <p>You have requested to reset your RoomHy account password.</p>
                        
                        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
                            <p style="color: #666; margin: 0 0 10px 0;">Your OTP code is:</p>
                            <h1 style="color: #4f46e5; margin: 0; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
                            <p style="color: #999; margin: 10px 0 0 0; font-size: 14px;">Valid for 10 minutes</p>
                        </div>

                        <p style="color: #666; font-size: 14px;">
                            If you did not request this password reset, please ignore this email.
                        </p>
                        
                        <p style="color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                            RoomHy Management System<br/>
                            This is an automated email. Please do not reply.
                        </p>
                    </div>
                </body>
            </html>
        `;

        // Try to send email
        await sendEmail(email, 'RoomHy - Password Reset OTP', emailHtml);

        try {
            await sendTemplateToResolvedUser({
                email,
                templateName: 'roomhy_otp_verification',
                variables: [otp],
                options: { urlButtons: [[otp]] }
            });
        } catch (whatsAppErr) {
            console.warn('[ForgotPassword] WhatsApp OTP send failed:', whatsAppErr.message);
        }

        // Always return success (email may fail in development)
        res.json({ 
            success: true, 
            message: 'OTP sent to your email and WhatsApp. Please check your inbox and spam folder.',
            // In development mode, return OTP for testing
            ...(process.env.NODE_ENV === 'development' && { demo_otp: otp })
        });

    } catch (err) {
        console.error('[ForgotPassword] Error in forgotPasswordRequestOTP:', err);
        res.status(500).json({ message: 'Server error. Please try again.' });
    }
};

// Forgot Password: Verify OTP
exports.forgotPasswordVerifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ message: 'Email and OTP are required' });
        }

        // Check OTP
        const otpData = otpStore.get(email);

        if (!otpData) {
            return res.status(401).json({ message: 'OTP expired or not requested. Please request a new OTP.' });
        }

        if (Date.now() > otpData.expiryTime) {
            otpStore.delete(email);
            return res.status(401).json({ message: 'OTP has expired. Please request a new OTP.' });
        }

        if (otpData.otp !== otp) {
            return res.status(401).json({ message: 'Invalid OTP. Please try again.' });
        }

        // OTP verified - generate reset token (valid for 15 minutes)
        const resetToken = jwt.sign({ email, type: 'forgot-password' }, process.env.JWT_SECRET || 'secret', { expiresIn: '15m' });

        // Clear OTP after successful verification
        otpStore.delete(email);

        res.json({ 
            success: true, 
            message: 'OTP verified successfully',
            token: resetToken
        });

    } catch (err) {
        console.error('forgotPasswordVerifyOTP error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Forgot Password: Reset Password
exports.forgotPasswordReset = async (req, res) => {
    try {
        const { email, token, newPassword } = req.body;

        if (!email || !token || !newPassword) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        // Verify reset token
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
            if (decoded.type !== 'forgot-password' || decoded.email !== email) {
                return res.status(401).json({ message: 'Invalid reset token' });
            }
        } catch (err) {
            return res.status(401).json({ message: 'Reset token expired or invalid. Please request a new OTP.' });
        }

        // Find user and update password - check User, AreaManager, and Employee collections
        let user = await User.findOne({ email });
        let userType = 'User';

        if (!user) {
            // Check AreaManager collection
            user = await AreaManager.findOne({ email: email.toLowerCase() });
            if (user) {
                userType = 'AreaManager';
            }
        }

        if (!user) {
            // Check Employee collection
            user = await Employee.findOne({ email: email.toLowerCase() });
            if (user) {
                userType = 'Employee';
            }
        }

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Update password (will be hashed by pre-save hook)
        user.password = newPassword;
        await user.save();

        console.log('[ForgotPassword] Password reset for', userType, 'email:', email);

        // Send confirmation email
        const confirmHtml = `
            <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #4f46e5;">Password Reset Successful</h2>
                        <p>Your RoomHy account password has been successfully reset.</p>
                        
                        <div style="background-color: #f0fdf4; padding: 15px; border-left: 4px solid #22c55e; margin: 20px 0;">
                            <p style="margin: 0; color: #166534;">✓ You can now login with your new password</p>
                        </div>

                        <p style="color: #666; font-size: 14px;">
                            If you did not perform this action, please contact our support team immediately.
                        </p>
                        
                        <p style="color: #999; font-size: 12px; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                            RoomHy Management System<br/>
                            This is an automated email. Please do not reply.
                        </p>
                    </div>
                </body>
            </html>
        `;

        await sendEmail(email, 'RoomHy - Password Reset Successful', confirmHtml);

        res.json({ 
            success: true, 
            message: 'Password reset successful. You can now login with your new password.',
            redirect: '/website/index'
        });

    } catch (err) {
        console.error('forgotPasswordReset error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Owner Forgot Password: Request OTP using loginId
exports.ownerForgotPasswordRequestOTP = async (req, res) => {
    try {
        const loginId = (req.body.loginId || '').toString().trim().toUpperCase();
        if (!loginId) return res.status(400).json({ message: 'Login ID is required' });
        if (!OWNER_LOGIN_ID_REGEX.test(loginId)) return res.status(400).json({ message: 'Invalid Owner Login ID format. Use ROOMHY1234' });

        const owner = await Owner.findOne({ loginId });
        if (!owner) return res.status(404).json({ message: 'Owner login ID not found' });

        const email = (owner.profile && owner.profile.email) || owner.email || '';
        if (!email) return res.status(400).json({ message: 'No email found for this owner. Please contact support.' });

        const otp = generateOTP();
        const expiryTime = Date.now() + 10 * 60 * 1000;
        const otpKey = `owner:${loginId}`;
        otpStore.set(otpKey, { otp, expiryTime, loginId, email });

        const emailHtml = `
            <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #4f46e5;">Owner Password Reset OTP</h2>
                        <p>Login ID: <strong>${loginId}</strong></p>
                        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
                            <p style="color: #666; margin: 0 0 10px 0;">Your OTP code is:</p>
                            <h1 style="color: #4f46e5; margin: 0; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
                            <p style="color: #999; margin: 10px 0 0 0; font-size: 14px;">Valid for 10 minutes</p>
                        </div>
                        <p style="color: #666; font-size: 14px;">If you did not request this reset, please ignore this email.</p>
                    </div>
                </body>
            </html>
        `;

        await sendEmail(email, 'RoomHy Owner Password Reset OTP', emailHtml);

        try {
            const ownerPhone = owner.phone || owner.profile?.phone || owner.checkinPhone || '';
            console.log('[OwnerOTP] Resolved phone for WhatsApp:', ownerPhone || 'NOT FOUND');
            await sendTemplateToResolvedUser({
                phone: ownerPhone,
                email,
                templateName: 'roomhy_otp_verification',
                variables: [otp],
                options: { urlButtons: [[otp]] }
            });
            console.log('[OwnerOTP] WhatsApp OTP sent successfully');
        } catch (whatsAppErr) {
            console.warn('[OwnerOTP] WhatsApp send failed:', whatsAppErr.message);
        }

        res.json({
            success: true,
            message: 'OTP sent to your registered email and WhatsApp',
            email,
            ...(process.env.NODE_ENV === 'development' && { demo_otp: otp })
        });
    } catch (err) {
        console.error('ownerForgotPasswordRequestOTP error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Owner Forgot Password: Verify OTP
exports.ownerForgotPasswordVerifyOTP = async (req, res) => {
    try {
        const loginId = (req.body.loginId || '').toString().trim().toUpperCase();
        const otp = (req.body.otp || '').toString().trim();
        if (!loginId || !otp) return res.status(400).json({ message: 'Login ID and OTP are required' });
        if (!OWNER_LOGIN_ID_REGEX.test(loginId)) return res.status(400).json({ message: 'Invalid Owner Login ID format. Use ROOMHY1234' });

        const otpKey = `owner:${loginId}`;
        const otpData = otpStore.get(otpKey);
        if (!otpData) return res.status(401).json({ message: 'OTP expired or not requested' });
        if (Date.now() > otpData.expiryTime) {
            otpStore.delete(otpKey);
            return res.status(401).json({ message: 'OTP has expired' });
        }
        if (otpData.otp !== otp) return res.status(401).json({ message: 'Invalid OTP' });

        const resetToken = jwt.sign(
            { loginId, type: 'owner-forgot-password' },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '15m' }
        );

        otpStore.delete(otpKey);
        res.json({ success: true, token: resetToken, message: 'OTP verified' });
    } catch (err) {
        console.error('ownerForgotPasswordVerifyOTP error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Owner Forgot Password: Reset password after OTP verify
exports.ownerForgotPasswordReset = async (req, res) => {
    try {
        const loginId = (req.body.loginId || '').toString().trim().toUpperCase();
        const token = (req.body.token || '').toString().trim();
        const newPassword = (req.body.newPassword || '').toString();

        if (!loginId || !token || !newPassword) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        if (!OWNER_LOGIN_ID_REGEX.test(loginId)) return res.status(400).json({ message: 'Invalid Owner Login ID format. Use ROOMHY1234' });
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
            if (decoded.type !== 'owner-forgot-password' || decoded.loginId !== loginId) {
                return res.status(401).json({ message: 'Invalid reset token' });
            }
        } catch (e) {
            return res.status(401).json({ message: 'Reset token expired or invalid' });
        }

        const owner = await Owner.findOne({ loginId });
        if (!owner) return res.status(404).json({ message: 'Owner not found' });

        owner.credentials = owner.credentials || {};
        owner.credentials.password = newPassword;
        owner.credentials.firstTime = false;
        owner.passwordSet = true;
        await owner.save();

        // Keep User collection in sync if owner also exists there
        try {
            const ownerUser = await User.findOne({ loginId, role: 'owner' });
            if (ownerUser) {
                ownerUser.password = newPassword; // User model hashes on save
                await ownerUser.save();
            }
        } catch (e) {
            console.warn('ownerForgotPasswordReset sync user warning:', e.message);
        }

        const email = (owner.profile && owner.profile.email) || owner.email || '';
        if (email) {
            const html = `
                <html>
                    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                            <h2 style="color: #4f46e5;">Password Reset Successful</h2>
                            <p>Your owner account password has been successfully updated.</p>
                            <p><strong>Login ID:</strong> ${loginId}</p>
                        </div>
                    </body>
                </html>
            `;
            await sendEmail(email, 'RoomHy Owner Password Reset Successful', html);
        }

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.error('ownerForgotPasswordReset error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Tenant Forgot Password: Request OTP using loginId
exports.tenantForgotPasswordRequestOTP = async (req, res) => {
    try {
        const loginId = (req.body.loginId || '').toString().trim().toUpperCase();
        if (!loginId) return res.status(400).json({ message: 'Login ID is required' });

        const tenant = await Tenant.findOne({ loginId });
        if (!tenant) return res.status(404).json({ message: 'Tenant login ID not found' });

        const user = await User.findOne({ loginId, role: 'tenant' });
        if (!user) return res.status(404).json({ message: 'Tenant account not found' });
        if (user.isActive === false) return res.status(403).json({ message: 'Account disabled' });

        const email = (tenant.email || user.email || '').toString().trim();
        if (!email) return res.status(400).json({ message: 'No email found for this tenant. Please contact support.' });

        const otp = generateOTP();
        const expiryTime = Date.now() + 10 * 60 * 1000;
        const otpKey = `tenant:${loginId}`;
        otpStore.set(otpKey, { otp, expiryTime, loginId, email });

        const emailHtml = `
            <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #4f46e5;">Tenant Password Reset OTP</h2>
                        <p>Login ID: <strong>${loginId}</strong></p>
                        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
                            <p style="color: #666; margin: 0 0 10px 0;">Your OTP code is:</p>
                            <h1 style="color: #4f46e5; margin: 0; letter-spacing: 5px; font-size: 32px;">${otp}</h1>
                            <p style="color: #999; margin: 10px 0 0 0; font-size: 14px;">Valid for 10 minutes</p>
                        </div>
                        <p style="color: #666; font-size: 14px;">If you did not request this reset, please ignore this email.</p>
                    </div>
                </body>
            </html>
        `;

        await sendEmail(email, 'RoomHy Tenant Password Reset OTP', emailHtml);

        res.json({
            success: true,
            message: 'OTP sent to your registered email',
            email,
            ...(process.env.NODE_ENV === 'development' && { demo_otp: otp })
        });
    } catch (err) {
        console.error('tenantForgotPasswordRequestOTP error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Tenant Forgot Password: Verify OTP
exports.tenantForgotPasswordVerifyOTP = async (req, res) => {
    try {
        const loginId = (req.body.loginId || '').toString().trim().toUpperCase();
        const otp = (req.body.otp || '').toString().trim();
        if (!loginId || !otp) return res.status(400).json({ message: 'Login ID and OTP are required' });

        const otpKey = `tenant:${loginId}`;
        const otpData = otpStore.get(otpKey);
        if (!otpData) return res.status(401).json({ message: 'OTP expired or not requested' });
        if (Date.now() > otpData.expiryTime) {
            otpStore.delete(otpKey);
            return res.status(401).json({ message: 'OTP has expired' });
        }
        if (otpData.otp !== otp) return res.status(401).json({ message: 'Invalid OTP' });

        const resetToken = jwt.sign(
            { loginId, type: 'tenant-forgot-password' },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '15m' }
        );

        otpStore.delete(otpKey);
        res.json({ success: true, token: resetToken, message: 'OTP verified' });
    } catch (err) {
        console.error('tenantForgotPasswordVerifyOTP error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Tenant Forgot Password: Reset password after OTP verify
exports.tenantForgotPasswordReset = async (req, res) => {
    try {
        const loginId = (req.body.loginId || '').toString().trim().toUpperCase();
        const token = (req.body.token || '').toString().trim();
        const newPassword = (req.body.newPassword || '').toString();

        if (!loginId || !token || !newPassword) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
            if (decoded.type !== 'tenant-forgot-password' || decoded.loginId !== loginId) {
                return res.status(401).json({ message: 'Invalid reset token' });
            }
        } catch (e) {
            return res.status(401).json({ message: 'Reset token expired or invalid' });
        }

        const user = await User.findOne({ loginId, role: 'tenant' });
        if (!user) return res.status(404).json({ message: 'Tenant not found' });

        user.password = newPassword;
        await user.save();

        const tenant = await Tenant.findOne({ loginId });
        if (tenant) {
            tenant.tempPassword = null;
            await tenant.save();
        }

        const email = (tenant && tenant.email) || user.email || '';
        if (email) {
            const html = `
                <html>
                    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
                            <h2 style="color: #4f46e5;">Password Reset Successful</h2>
                            <p>Your tenant account password has been successfully updated.</p>
                            <p><strong>Login ID:</strong> ${loginId}</p>
                        </div>
                    </body>
                </html>
            `;
            await sendEmail(email, 'RoomHy Tenant Password Reset Successful', html);
        }

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        console.error('tenantForgotPasswordReset error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Login using email, loginId, or phone number
exports.login = async (req, res) => {
    try {
        const { identifier, password } = req.body; // identifier = email, loginId, or phone
        const normalizedIdentifier = String(identifier || '').trim();
        
        // Determine identifier type
        const isEmail = normalizedIdentifier.includes('@');
        const isPhone = /^\d{10}$/.test(normalizedIdentifier); // 10 digit phone
        const isLoginId = /^roomhy/i.test(normalizedIdentifier);
        
        if (!normalizedIdentifier || !password) return res.status(400).json({ message: 'Missing credentials' });
        
        // Build query based on identifier type
        let query = {};
        if (isEmail) {
            query = { email: normalizedIdentifier.toLowerCase() };
        } else if (isPhone) {
            query = { phone: normalizedIdentifier };
        } else if (isLoginId) {
            query = { loginId: normalizedIdentifier.toUpperCase() };
        } else {
            // Try all three
            query = { 
                $or: [
                    { email: normalizedIdentifier.toLowerCase() }, 
                    { loginId: normalizedIdentifier.toUpperCase() },
                    { phone: normalizedIdentifier }
                ] 
            };
        }
        
        let user = await User.findOne(query);
        let isMatch = false;

        if (user) {
            // Block disabled users
            if (user.isActive === false) {
                return res.status(403).json({ message: 'Account disabled' });
            }

            // Owners can login using loginId or phone (not email)
            if (user.role === 'owner' && isEmail) {
                return res.status(403).json({ message: 'Owners must login using Owner ID or Phone Number' });
            }

            isMatch = await user.matchPassword(password);
            
            if (isMatch) {
                // Check if Owner model or User model requires reset
                let reqReset = user.requirePasswordReset || false;
                if (user.role === 'owner') {
                    const owner = await Owner.findOne({ loginId: user.loginId });
                    if (owner?.credentials?.firstTime) {
                        // If password is already bcrypt-hashed, owner already set their password — clear firstTime
                        const isTemp = owner.credentials.password && String(owner.credentials.password) === String(password);
                        if (isTemp) {
                            reqReset = true;
                        } else {
                            await Owner.findOneAndUpdate(
                                { loginId: user.loginId },
                                { $set: { 'credentials.firstTime': false } }
                            );
                        }
                    }
                }
                if (reqReset) {
                    return res.status(200).json({
                        success: true,
                        requireReset: true,
                        message: 'Password reset required',
                        loginId: user.loginId,
                        role: user.role
                    });
                }
            }
        } else {
            // Fallback for AreaManager
            const areaManager = await AreaManager.findOne(query);
            if (areaManager) {
                if (areaManager.isActive === false) return res.status(403).json({ message: 'Account disabled' });
                isMatch = (areaManager.password === password);
                
                if (isMatch) {
                    user = {
                        _id: areaManager._id,
                        name: areaManager.name,
                        email: areaManager.email,
                        phone: areaManager.phone,
                        role: 'areamanager',
                        loginId: areaManager.loginId
                    };
                }
            } else {
                // Fallback for Employee
                const employee = await Employee.findOne(query);
                if (employee) {
                    if (employee.isActive === false) return res.status(403).json({ message: 'Account disabled' });
                    isMatch = (employee.password === password);
                    
                    if (isMatch) {
                        if (employee.requirePasswordReset) {
                            return res.status(200).json({
                                success: true,
                                requireReset: true,
                                message: 'Password reset required',
                                loginId: employee.loginId,
                                role: employee.role && employee.role.toLowerCase() === 'manager' ? 'manager' : 'employee'
                            });
                        }
                        user = {
                            _id: employee._id,
                            name: employee.name,
                            email: employee.email,
                            phone: employee.phone,
                            team: employee.role,
                            role: employee.role && employee.role.toLowerCase() === 'manager' ? 'manager' : 'employee',
                            loginId: employee.loginId,
                            permissions: employee.permissions
                        };
                    }
                }
            }
        }

        if (!user || !isMatch) return res.status(401).json({ message: 'Invalid credentials' });

        const token = generateToken(user);
        res.json({ 
            token, 
            user: { 
                id: user._id || user.id, 
                name: user.name, 
                email: user.email,
                phone: user.phone,
                role: user.role,
                team: user.team,
                loginId: user.loginId,
                permissions: user.permissions 
            } 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Validate current token and return current user
exports.me = async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ message: 'Not authorized' });
        res.json({
            user: {
                id: req.user._id,
                name: req.user.name,
                email: req.user.email,
                phone: req.user.phone,
                role: req.user.role,
                team: req.user.team,
                loginId: req.user.loginId,
                permissions: req.user.permissions
            }
        });
    } catch (err) {
        console.error('me error:', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Verify owner temporary password (used by owner login UI)
exports.verifyOwnerTemp = async (req, res) => {
    try {
        const { loginId, tempPassword } = req.body;
        if (!loginId || !tempPassword) return res.status(400).json({ message: 'Missing fields' });

        const normalizedLoginId = String(loginId || '').trim().toUpperCase();
        let user = await User.findOne({ loginId: normalizedLoginId, role: 'owner' });

        // Backward-compat: owner record exists but auth user row missing.
        if (!user) {
            const owner = await Owner.findOne({ loginId: normalizedLoginId });
            if (!owner) return res.status(404).json({ message: 'Owner not found' });

            const ownerTempPassword = owner?.credentials?.password || owner?.checkinPassword || '';
            if (!ownerTempPassword) {
                return res.status(404).json({ message: 'Owner credentials not initialized' });
            }
            if (String(ownerTempPassword) !== String(tempPassword)) {
                return res.status(401).json({ message: 'Invalid temporary password' });
            }

            const seedPhone = owner?.phone || owner?.profile?.phone || '0000000000';
            const seedEmail = owner?.email || owner?.profile?.email || '';
            const seedName = owner?.name || owner?.profile?.name || normalizedLoginId;

            try {
                user = await User.create({
                    name: seedName,
                    email: seedEmail,
                    phone: seedPhone,
                    password: ownerTempPassword,
                    role: 'owner',
                    loginId: normalizedLoginId
                });
            } catch (createErr) {
                // In race/duplicate cases, fetch again.
                user = await User.findOne({ loginId: normalizedLoginId, role: 'owner' });
                if (!user) throw createErr;
            }
        }

        if (user.isActive === false) return res.status(403).json({ message: 'Account disabled' });

        const ok = await user.matchPassword(tempPassword);
        if (!ok) return res.status(401).json({ message: 'Invalid temporary password' });

        // Verified — return success (no token yet)
        res.json({ success: true, message: 'Verified' });
    } catch (err) {
        console.error('verifyOwnerTemp error', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Set new password for owner after verifying temp password
exports.setOwnerPassword = async (req, res) => {
    try {
        const { loginId, tempPassword, newPassword } = req.body;
        if (!loginId || !tempPassword || !newPassword) return res.status(400).json({ message: 'Missing fields' });

        const normalizedLoginId = String(loginId || '').trim().toUpperCase();
        let user = await User.findOne({ loginId: normalizedLoginId, role: 'owner' });

        // Backward-compat: create missing auth user from Owner record.
        if (!user) {
            const owner = await Owner.findOne({ loginId: normalizedLoginId });
            if (!owner) return res.status(404).json({ message: 'Owner not found' });

            const ownerTempPassword = owner?.credentials?.password || owner?.checkinPassword || '';
            if (!ownerTempPassword) {
                return res.status(404).json({ message: 'Owner credentials not initialized' });
            }
            if (String(ownerTempPassword) !== String(tempPassword)) {
                return res.status(401).json({ message: 'Invalid temporary password' });
            }

            const seedPhone = owner?.phone || owner?.profile?.phone || '0000000000';
            const seedEmail = owner?.email || owner?.profile?.email || '';
            const seedName = owner?.name || owner?.profile?.name || normalizedLoginId;

            try {
                user = await User.create({
                    name: seedName,
                    email: seedEmail,
                    phone: seedPhone,
                    password: ownerTempPassword,
                    role: 'owner',
                    loginId: normalizedLoginId
                });
            } catch (createErr) {
                user = await User.findOne({ loginId: normalizedLoginId, role: 'owner' });
                if (!user) throw createErr;
            }
        }

        const ok = await user.matchPassword(tempPassword);
        if (!ok) return res.status(401).json({ message: 'Invalid temporary password' });

        user.password = newPassword; // will be hashed by pre-save hook
        await user.save();

        // Clear firstTime flag so next login works normally
        const Owner = require('../models/Owner');
        await Owner.findOneAndUpdate(
            { loginId: normalizedLoginId },
            { $set: { 'credentials.firstTime': false } }
        );

        // Auto-login: return JWT on successful password set
        const token = generateToken(user);
        res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, loginId: user.loginId } });
    } catch (err) {
        console.error('setOwnerPassword error', err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Verify tenant temporary password (used by tenant login UI)
exports.verifyTenantTemp = async (req, res) => {
    try {
        const loginId = String(req.body.loginId || '').trim().toUpperCase();
        const tempPassword = String(req.body.tempPassword || '');
        if (!loginId || !tempPassword) return res.status(400).json({ message: 'Missing fields' });

        const user = await User.findOne({ loginId, role: 'tenant' });
        if (!user) return res.status(404).json({ success: false, message: 'Tenant not found' });

        if (user.isActive === false) return res.status(403).json({ success: false, message: 'Account disabled' });

        const tenant = await Tenant.findOne({ loginId });
        const ok = await user.matchPassword(tempPassword);
        const plainTempMatch =
            tenant &&
            tenant.tempPassword &&
            String(tenant.tempPassword).trim() &&
            String(tenant.tempPassword).trim() === tempPassword.trim();

        const verified = ok || plainTempMatch;
        if (!verified) return res.status(401).json({ success: false, message: 'Invalid temporary password' });

        if (!ok && plainTempMatch) {
            user.password = tempPassword;
            await user.save();
        }

        res.json({ 
            success: true, 
            message: 'Verified',
            tenant: {
                id: tenant ? tenant._id : null,
                loginId: user.loginId,
                name: user.name,
                email: user.email,
                phone: user.phone
            }
        });
    } catch (err) {
        console.error('verifyTenantTemp error', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Set new password for tenant after verifying temp password
exports.setTenantPassword = async (req, res) => {
    try {
        const loginId = String(req.body.loginId || '').trim().toUpperCase();
        const tempPassword = String(req.body.tempPassword || '');
        const newPassword = String(req.body.newPassword || '');
        if (!loginId || !tempPassword || !newPassword) return res.status(400).json({ success: false, message: 'Missing fields' });

        const user = await User.findOne({ loginId, role: 'tenant' });
        if (!user) return res.status(404).json({ success: false, message: 'Tenant not found' });

        const tenant = await Tenant.findOne({ loginId });
        const ok = await user.matchPassword(tempPassword);
        const plainTempMatch =
            tenant &&
            tenant.tempPassword &&
            String(tenant.tempPassword).trim() &&
            String(tenant.tempPassword).trim() === tempPassword.trim();
        if (!ok && !plainTempMatch) return res.status(401).json({ success: false, message: 'Invalid temporary password' });

        user.password = newPassword; // will be hashed by pre-save hook
        user.requirePasswordReset = false;
        await user.save();

        if (tenant) {
            tenant.tempPassword = null;
            tenant.status = tenant.status === 'pending' ? 'active' : tenant.status;
            await tenant.save();
        }

        // Auto-login: return JWT on successful password set
        const token = generateToken(user);
        res.json({ 
            success: true, 
            token, 
            user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, loginId: user.loginId } 
        });
    } catch (err) {
        console.error('setTenantPassword error', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Simple register (for testing). Admin should create owners in approval flow.
exports.register = async (req, res) => {
    try {
        const { name, firstName, lastName, email, phone, password, role } = req.body;
        if (!name || !email || !phone || !password) return res.status(400).json({ message: 'Missing fields' });
        const existing = await User.findOne({ $or: [{ email }, { phone }] });
        if (existing) return res.status(400).json({ message: 'User exists' });

        const normalizedEmail = (email || '').toString().trim().toLowerCase();
        const normalizedRole = role || 'tenant';
        const derivedLoginId = normalizedEmail;

        const user = await User.create({
            name,
            email: normalizedEmail,
            phone,
            password,
            role: normalizedRole,
            loginId: derivedLoginId
        });

        // Keep New Signups in MongoDB Atlas in sync with website registrations
        const splitName = (name || '').trim().split(/\s+/);
        const safeFirstName = (firstName || splitName[0] || 'User').trim();
        const safeLastName = (lastName || splitName.slice(1).join(' ') || '').trim();
        const signupId = `roomhyweb${String(Date.now()).slice(-6)}`;

        await KYCVerification.findOneAndUpdate(
            { email: normalizedEmail },
            {
                $set: {
                    loginId: derivedLoginId,
                    firstName: safeFirstName,
                    lastName: safeLastName,
                    phone,
                    role: normalizedRole === 'owner' ? 'propertyowner' : normalizedRole,
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

        const token = generateToken(user);
        res.status(201).json({
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Reset initial password for Employee, Manager, Owner, User
exports.resetInitialPasswordAll = async (req, res) => {
    try {
        const { loginId, oldPassword, newPassword } = req.body;
        if (!loginId || !oldPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }

        const normalizedLoginId = String(loginId).trim().toUpperCase();
        let matched = false;

        // 1. Check User model (superadmin, owner, employee, etc.)
        const user = await User.findOne({ loginId: normalizedLoginId });
        if (user) {
            const isMatch = await user.matchPassword(oldPassword);
            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid old password' });

            user.password = newPassword;
            user.requirePasswordReset = false;
            await user.save();
            matched = true;
            console.log(`[ResetInitial] Password reset for User: ${normalizedLoginId}`);
        }

        // 2. Check Employee model (fallback/sync)
        const employee = await Employee.findOne({ loginId: normalizedLoginId });
        if (employee) {
            if (!matched || employee.password === oldPassword) {
                employee.password = newPassword;
                employee.requirePasswordReset = false;
                await employee.save();
                matched = true;
                console.log(`[ResetInitial] Password reset for Employee: ${normalizedLoginId}`);
            }
        }

        // 3. Check Owner model (fallback/sync)
        const owner = await Owner.findOne({ loginId: normalizedLoginId });
        if (owner) {
            owner.credentials = owner.credentials || {};
            owner.credentials.password = newPassword;
            owner.credentials.firstTime = false;
            owner.passwordSet = true;
            await owner.save();
            matched = true;
            console.log(`[ResetInitial] Password reset for Owner: ${normalizedLoginId}`);
        }

        // 4. Check PropertyManager model
        const PropertyManager = require('../models/PropertyManager');
        const manager = await PropertyManager.findOne({ loginId: normalizedLoginId });
        if (manager) {
            const bcrypt = require('bcrypt');
            const isMatch = await bcrypt.compare(oldPassword, manager.password);
            if (isMatch) {
                const hashedPassword = await bcrypt.hash(newPassword, 10);
                manager.password = hashedPassword;
                manager.requirePasswordReset = false;
                manager.updatedAt = Date.now();
                await manager.save();
                matched = true;
                console.log(`[ResetInitial] Password reset for PropertyManager: ${normalizedLoginId}`);
            }
        }

        if (!matched) {
            return res.status(404).json({ success: false, message: 'Account not found or password incorrect' });
        }

        return res.json({
            success: true,
            message: 'Password updated successfully! Please login with your new password.'
        });
    } catch (err) {
        console.error('resetInitialPasswordAll error:', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
};
