const express = require('express');
const router = express.Router();
const { sendMail } = require('../utils/mailer');
const { formLimiter } = require('../middleware/security');

const WEBSITE_URL = process.env.WEBSITE_URL || 'https://roomhy.com';

// POST: Send an email
router.post('/send', formLimiter, async (req, res) => {
    try {
        const { to, subject, html, text } = req.body;

        if (!to || !subject || (!html && !text)) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: to, subject, and html or text'
            });
        }

        const sent = await sendMail(to, subject, text, html);
        if (!sent) {
            return res.status(500).json({
                success: false,
                message: 'Email transporter is not configured or delivery failed'
            });
        }

        res.json({
            success: true,
            message: 'Email sent successfully'
        });

    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending email',
            error: error.message
        });
    }
});

// POST: Send signup email with credentials
router.post('/signup', async (req, res) => {
    try {
        const { email, firstName, userId, password } = req.body;

        if (!email || !firstName || !userId || !password) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email, firstName, userId, password'
            });
        }

        const subject = '🎉 Welcome to Roomhy - Your Account Credentials';
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
                    .header { background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                    .header h1 { margin: 0; font-size: 28px; }
                    .content { padding: 30px; background: #f8fafc; }
                    .credentials { background: white; border-left: 4px solid #2563eb; padding: 15px; margin: 20px 0; border-radius: 4px; }
                    .credentials p { margin: 10px 0; }
                    .label { font-weight: bold; color: #2563eb; }
                    .footer { text-align: center; padding: 20px; font-size: 12px; color: #999; border-top: 1px solid #eee; }
                    .button { display: inline-block; background: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; margin-top: 15px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>🏠 Welcome to Roomhy!</h1>
                    </div>
                    <div class="content">
                        <p>Hi <strong>${firstName}</strong>,</p>
                        <p>Thank you for signing up with Roomhy! Your account has been created successfully. Here are your login credentials:</p>
                        
                        <div class="credentials">
                            <p><span class="label">Username/User ID:</span> <strong>${userId}</strong></p>
                            <p><span class="label">Email:</span> <strong>${email}</strong></p>
                            <p><span class="label">Password:</span> <strong>${password}</strong></p>
                        </div>

                        <p style="color: #d32f2f; font-weight: bold;">⚠️ Important: Keep your credentials safe and do not share them with anyone.</p>

                        <p>You can now log in to your account and start exploring properties, making bookings, and connecting with property owners.</p>

                        <a href="${WEBSITE_URL}/website/signup" class="button">Go to Roomhy</a>

                        <p style="margin-top: 30px;">If you have any questions, feel free to contact our support team at <strong>hello@roomhy.com</strong></p>
                    </div>
                    <div class="footer">
                        <p>&copy; 2025 Roomhy. All rights reserved. | Made with ❤️ for students</p>
                    </div>
                </div>
            </body>
            </html>
        `;

        const text = `
Welcome to Roomhy, ${firstName}!

Your account has been created successfully.

Login Credentials:
Username/User ID: ${userId}
Email: ${email}
Password: ${password}

Keep your credentials safe and do not share them with anyone.

You can now log in to your account and start exploring properties.

Questions? Contact us at hello@roomhy.com

© 2025 Roomhy. All rights reserved.
        `;

        const sent = await sendMail(email, subject, text, html);
        if (!sent) {
            return res.status(500).json({
                success: false,
                message: 'Email transporter is not configured or delivery failed'
            });
        }

        res.json({
            success: true,
            message: 'Signup email sent successfully'
        });

    } catch (error) {
        console.error('Error sending signup email:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending signup email',
            error: error.message
        });
    }
});

module.exports = router;
