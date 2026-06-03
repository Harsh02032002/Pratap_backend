const https = require("https");
const nodemailer = require('nodemailer');
const fs = require('fs');

function parseBooleanEnv(value, fallback = false) {
    if (typeof value === 'undefined' || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getMailerConfig() {
    return {
        fromEmail: process.env.FROM_EMAIL || 'no-reply@roomhy.com',
        fromName: process.env.FROM_NAME || 'RoomHy',
        smtpHost: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
        smtpPort: Number(process.env.SMTP_PORT || 587),
        smtpSecure: parseBooleanEnv(process.env.SMTP_SECURE, false),
        smtpUser: (process.env.SMTP_USER || '').trim(),
        smtpPass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
        smtpDebug: parseBooleanEnv(process.env.SMTP_DEBUG, false),
        smtpLogger: parseBooleanEnv(process.env.SMTP_LOGGER, false),
        smtpRequireTls: parseBooleanEnv(process.env.SMTP_REQUIRE_TLS, false),
        smtpIgnoreTls: parseBooleanEnv(process.env.SMTP_IGNORE_TLS, false),
        smtpTlsRejectUnauthorized: parseBooleanEnv(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, false),
        smtpConnectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 30000),
        smtpGreetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 30000),
        smtpSocketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30000),
        smtpName: (process.env.SMTP_NAME || '').trim(),
        smtpService: (process.env.SMTP_SERVICE || '').trim(),
        mailjetHost: (process.env.MAILJET_SMTP_HOST || 'in-v3.mailjet.com').trim(),
        mailjetPort: Number(process.env.MAILJET_SMTP_PORT || 587),
        mailjetSecure: parseBooleanEnv(process.env.MAILJET_SMTP_SECURE, false),
        mailjetUser: (process.env.MAILJET_API_KEY || '').trim(),
        mailjetPass: (process.env.MAILJET_SECRET_KEY || '').trim(),
        whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
        whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        whatsappApiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
        whatsappDefaultCountryCode: process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91',
        whatsappOtpTemplateName: (process.env.WHATSAPP_OTP_TEMPLATE_NAME || '').trim(),
        whatsappOtpTemplateLanguage: (process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE || 'en_US').trim()
    };
}

function isSmtpConfigured(cfg) {
    return Boolean(cfg.smtpHost && cfg.smtpUser && cfg.smtpPass);
}

function isWhatsAppConfigured(cfg) {
    return Boolean(cfg.whatsappAccessToken && cfg.whatsappPhoneNumberId);
}

function isMailjetConfigured(cfg) {
    return Boolean(cfg.mailjetHost && cfg.mailjetUser && cfg.mailjetPass);
}

function normalizeRecipients(to) {
    if (!to) return [];
    if (Array.isArray(to)) {
        return to
            .map((x) => (x || '').toString().trim())
            .filter(Boolean)
            .map((email) => ({ Email: email }));
    }
    return to
        .toString()
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((email) => ({ Email: email }));
}

function postJson(urlString, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const payload = JSON.stringify(body);
        const req = https.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || 443,
                path: `${url.pathname}${url.search}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...headers
                }
            },
            (res) => {
                const chunks = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode || 500,
                        body: Buffer.concat(chunks).toString('utf8')
                    });
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function normalizePhoneNumber(rawPhone, defaultCountryCode = '91') {
    if (!rawPhone) return '';
    const cleaned = String(rawPhone).trim().replace(/[^0-9+]/g, '');
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (!digitsOnly) return '';

    if (digitsOnly.length === 10) {
        return `${defaultCountryCode}${digitsOnly}`;
    }

    if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
        return `${defaultCountryCode}${digitsOnly.slice(1)}`;
    }

    if (digitsOnly.length >= 11 && digitsOnly.length <= 15) {
        return digitsOnly;
    }

    return '';
}

function stripHtmlTags(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildWhatsAppMessage(subject, text, html) {
    const plain = String(text || '').trim() || stripHtmlTags(html);
    const heading = String(subject || 'RoomHy Notification').trim();
    const body = plain ? `${heading}\n\n${plain}` : heading;
    return body.slice(0, 3900);
}

async function resolvePhoneByEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return '';

    try {
        const User = require('../models/user');
        const userDoc = await User.findOne({ email: normalizedEmail }).select('phone').lean();
        if (userDoc && userDoc.phone) return userDoc.phone;
    } catch (_) {}

    try {
        const Tenant = require('../models/Tenant');
        const tenantDoc = await Tenant.findOne({ email: normalizedEmail }).select('phone').lean();
        if (tenantDoc && tenantDoc.phone) return tenantDoc.phone;
    } catch (_) {}

    return '';
}

async function sendWhatsAppMessage(toPhone, body, cfg) {
    if (!toPhone || !body) return false;

    const endpoint = `https://graph.facebook.com/${cfg.whatsappApiVersion}/${cfg.whatsappPhoneNumberId}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'text',
        text: {
            preview_url: false,
            body
        }
    };

    const response = await postJson(endpoint, payload, {
        Authorization: `Bearer ${cfg.whatsappAccessToken}`
    });

    if (response.status >= 200 && response.status < 300) {
        console.log('WhatsApp sent to', toPhone);
        return true;
    }

    console.warn('WhatsApp send failed:', response.status, response.body);
    return false;
}

async function sendWhatsAppByEmailRecipients(recipients, subject, text, html, cfg) {
    if (!isWhatsAppConfigured(cfg) || !Array.isArray(recipients) || !recipients.length) {
        return 0;
    }

    const message = buildWhatsAppMessage(subject, text, html);
    const deliveredPhones = new Set();

    for (const recipient of recipients) {
        const email = recipient && recipient.Email ? recipient.Email : '';
        if (!email) continue;

        try {
            const resolvedPhone = await resolvePhoneByEmail(email);
            const toPhone = normalizePhoneNumber(resolvedPhone, cfg.whatsappDefaultCountryCode);
            if (!toPhone || deliveredPhones.has(toPhone)) continue;

            const delivered = await sendWhatsAppMessage(toPhone, message, cfg);
            if (delivered) deliveredPhones.add(toPhone);
        } catch (err) {
            console.warn('WhatsApp dispatch error for recipient', email, '-', err && err.message);
        }
    }

    return deliveredPhones.size;
}

function buildTransportOptions({ host, port, secure, user, pass, cfg, service = '', name = '' }) {
    const isGmail = service === 'gmail' || (host && host.toLowerCase().includes('gmail'));
    
    if (isGmail) {
        return {
            service: 'gmail',
            auth: { user, pass },
            debug: cfg.smtpDebug,
            logger: cfg.smtpLogger
        };
    }

    const options = {
        host,
        port,
        secure,
        connectionTimeout: cfg.smtpConnectionTimeout,
        greetingTimeout: cfg.smtpGreetingTimeout,
        socketTimeout: cfg.smtpSocketTimeout,
        requireTLS: cfg.smtpRequireTls,
        ignoreTLS: cfg.smtpIgnoreTls,
        tls: {
            rejectUnauthorized: cfg.smtpTlsRejectUnauthorized
        },
        auth: {
            user,
            pass
        },
        debug: cfg.smtpDebug,
        logger: cfg.smtpLogger
    };

    if (service) options.service = service;
    if (name) options.name = name;
    if (host) options.tls.servername = host;

    return options;
}

async function sendViaSmtp({ cfg, host, port, secure, user, pass, label, service = '', name = '' }, mailOptions) {
    const transporter = nodemailer.createTransport(
        buildTransportOptions({ host, port, secure, user, pass, cfg, service, name })
    );

    await transporter.verify();
    await transporter.sendMail(mailOptions);
    console.log(`Email sent via ${label} to`, mailOptions.to);
    return true;
}

async function sendViaMailjetApi(recipients, subject, text, html, cfg, attachments = []) {
    const endpoint = 'https://api.mailjet.com/v3.1/send';
    const message = {
        From: { Email: cfg.fromEmail, Name: cfg.fromName },
        To: recipients,
        Subject: subject,
        TextPart: text,
        HTMLPart: html
    };

    // Convert Buffer/base64 attachments to Mailjet format
    if (Array.isArray(attachments) && attachments.length) {
        message.Attachments = attachments.map((att) => {
            const content = att.content || att.data || '';
            const base64 = Buffer.isBuffer(content)
                ? content.toString('base64')
                : Buffer.isBuffer(att.path)
                    ? att.path.toString('base64')
                    : String(content);
            return {
                ContentType: att.contentType || att.ContentType || 'application/octet-stream',
                Filename: att.filename || att.Filename || 'attachment',
                Base64Content: base64
            };
        });
    }

    const payload = { Messages: [message] };

    const auth = Buffer.from(`${cfg.mailjetUser}:${cfg.mailjetPass}`).toString('base64');
    const response = await postJson(endpoint, payload, {
        Authorization: `Basic ${auth}`
    });

    if (response.status >= 200 && response.status < 300) {
        console.log('Email sent via Mailjet API to', recipients.map(r => r.Email).join(', '));
        return true;
    }

    console.warn('Mailjet API failed:', response.status, response.body);
    return false;
}

async function sendMail(to, subject, text, html, options = {}) {
    const cfg = getMailerConfig();
    
    const recipients = normalizeRecipients(to);
    const hasSmtp = isSmtpConfigured(cfg);
    const hasMailjet = isMailjetConfigured(cfg);

    if (!recipients.length) {
        console.warn('sendMail skipped: no valid recipients');
        return false;
    }
    let emailSent = false;
    const toStr = recipients.map((x) => x.Email).join(', ');
    const attachments = options.attachments || [];
    const mailOptions = {
        from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
        to: toStr,
        subject: subject || 'RoomHy Notification',
        text: text || '',
        html: html || '',
        ...(attachments.length ? { attachments } : {})
    };

    // Priority 1: Mailjet API (More reliable than SMTP, bypasses port blocks)
    if (!emailSent && isMailjetConfigured(cfg)) {
        try {
            emailSent = await sendViaMailjetApi(recipients, subject, text, html, cfg, attachments);
            if (emailSent) {
                fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] SUCCESS: Email to ${toStr} via Mailjet API\n`);
            } else {
                fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] FAILED: Mailjet API rejected the request (Check keys)\n`);
            }
        } catch (err) {
            console.error('Mailjet API failed:', err && err.message);
            fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] FAILED: Email to ${toStr} via Mailjet API. Error: ${err.message}\n`);
        }
    }

    // Priority 2: Primary SMTP (Gmail/Custom)
    if (!emailSent && isSmtpConfigured(cfg)) {
        try {
            const isGmail = cfg.smtpHost.toLowerCase().includes('gmail');
            await sendViaSmtp({
                cfg,
                host: cfg.smtpHost,
                port: cfg.smtpPort,
                secure: cfg.smtpSecure,
                user: cfg.smtpUser,
                pass: cfg.smtpPass,
                label: 'SMTP',
                service: '',
                name: cfg.smtpName
            }, mailOptions);
            emailSent = true;
            fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] SUCCESS: Email to ${toStr} via SMTP\n`);
        } catch (err) {
            console.error('SMTP Delivery failed:', err && err.message);
            fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] FAILED: Email to ${toStr} via SMTP. Error: ${err.message}\n`);
        }
    }

    // WhatsApp copy
    let whatsappSent = false;
    try {
        const whatsappDeliveredCount = await sendWhatsAppByEmailRecipients(recipients, subject, text, html, cfg);
        whatsappSent = whatsappDeliveredCount > 0;
        fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] WHATSAPP: Delivered to ${whatsappDeliveredCount} recipients\n`);
    } catch (err) {
        console.warn('WhatsApp notification copy failed:', err && err.message);
        fs.appendFileSync('mail_log.txt', `[${new Date().toISOString()}] WHATSAPP FAILED: ${err.message}\n`);
    }

    return emailSent || whatsappSent;
}

function getLoginUrlForRole(role, originUrl = '') {
    let frontendUrl = (process.env.FRONTEND_URL || process.env.WEB_APP_URL || 'https://admin.roomhy.com').replace(/\/$/, '');
    
    if (originUrl) {
        frontendUrl = originUrl.replace(/\/$/, '');
    }

    const r = String(role || '').toLowerCase();
    if (r.includes('owner')) {
        return `${frontendUrl}/propertyowner/ownerlogin`;
    }
    if (r.includes('tenant')) {
        return `${frontendUrl}/tenant/tenantlogin`;
    }
    if (r.includes('manager') || r.includes('employee') || r.includes('staff') || r.includes('warden') || r.includes('electrician') || r.includes('plumber') || r.includes('security') || r.includes('housekeeping')) {
        return `${frontendUrl}/employee/index`;
    }
    return `${frontendUrl}/superadmin/index`;
}

function credentialsHtml(loginId, password, role = 'Account', originUrl = '') {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RoomHy Login Credentials</title>
    <style>
        body { margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5; }
        .container { max-width: 500px; margin: 40px auto; padding: 20px; }
        .card { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; }
        .header h1 { margin: 0; color: white; font-size: 28px; font-weight: 600; }
        .header p { margin: 10px 0 0; color: rgba(255,255,255,0.9); font-size: 14px; }
        .content { padding: 30px; }
        .greeting { color: #333; font-size: 16px; margin-bottom: 20px; }
        .credential-card { background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%); border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #667eea; }
        .credential-item { margin: 15px 0; }
        .credential-label { color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
        .credential-value { color: #333; font-size: 18px; font-weight: 600; background: white; padding: 10px 15px; border-radius: 8px; display: inline-block; }
        .copy-hint { color: #999; font-size: 11px; margin-top: 4px; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee; }
        .footer p { margin: 0; color: #999; font-size: 12px; }
        .warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-top: 20px; font-size: 13px; color: #856404; }
        .btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; margin-top: 20px; font-weight: 500; }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="header">
                <h1>🏠 RoomHy</h1>
                <p>Your Account Has Been Created</p>
            </div>
            <div class="content">
                <p class="greeting">Hello! Your <strong>${role}</strong> account has been created successfully. Here are your login credentials:</p>
                
                <div class="credential-card">
                    <div class="credential-item">
                        <div class="credential-label">Login ID / Username</div>
                        <div class="credential-value">${loginId}</div>
                        <div class="copy-hint">Use this to login to RoomHy</div>
                    </div>
                    <div class="credential-item">
                        <div class="credential-label">Password</div>
                        <div class="credential-value">${password}</div>
                        <div class="copy-hint">Keep this secure</div>
                    </div>
                </div>
                
                <div class="warning">
                    ⚠️ <strong>Important:</strong> Please change your password after first login for security.
                </div>
                
                <div style="text-align: center;">
                    <a href="${getLoginUrlForRole(role, originUrl)}" class="btn">Login to RoomHy</a>
                </div>
            </div>
            <div class="footer">
                <p>© 2025 RoomHy. All rights reserved.</p>
                <p>Need help? Contact us at support@roomhy.com</p>
            </div>
        </div>
    </div>
</body>
</html>`;
}

async function sendCredentials(toEmail, loginId, password, role = 'Account', originUrl = '') {
    if (!toEmail) return;
    const loginUrl = getLoginUrlForRole(role, originUrl);
    const subject = `${role} credentials for RoomHy`;
    const html = credentialsHtml(loginId, password, role, originUrl);
    const text = `Your ${role} credentials\nLogin ID: ${loginId}\nPassword: ${password}\n\nLogin here: ${loginUrl}`;
    return sendMail(toEmail, subject, text, html);
}

async function sendKycLinkEmail(toEmail, name, portalName, kycLink) {
    if (!toEmail || !kycLink) return false;
    const displayName = name || 'there';
    const portal = portalName || 'RoomHy';
    const subject = `Complete Your KYC - ${portal}`;
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KYC Verification - ${portal}</title>
  <style>
    body { margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5; }
    .container { max-width: 500px; margin: 40px auto; padding: 20px; }
    .card { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); overflow: hidden; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; }
    .header h1 { margin: 0; color: white; font-size: 28px; font-weight: 600; }
    .header p { margin: 10px 0 0; color: rgba(255,255,255,0.9); font-size: 14px; }
    .content { padding: 30px; }
    .greeting { color: #333; font-size: 16px; margin-bottom: 20px; }
    .info-box { background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%); border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #667eea; color: #444; font-size: 14px; line-height: 1.6; }
    .btn { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white !important; padding: 14px 36px; text-decoration: none; border-radius: 8px; margin-top: 20px; font-weight: 600; font-size: 15px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eee; }
    .footer p { margin: 4px 0; color: #999; font-size: 12px; }
    .link-fallback { word-break: break-all; color: #667eea; font-size: 12px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <h1>🏠 RoomHy</h1>
        <p>KYC Verification Required</p>
      </div>
      <div class="content">
        <p class="greeting">Hello <strong>${displayName}</strong>,</p>
        <p style="color:#555;font-size:14px;line-height:1.7;">
          Welcome to <strong>${portal}</strong>! To activate your account and get started,
          please complete your KYC (Know Your Customer) verification by clicking the button below.
        </p>
        <div class="info-box">
          <strong>What you'll need:</strong><br>
          ✅ Your personal details &amp; address<br>
          ✅ A government-issued ID (Aadhaar / PAN)<br>
          ✅ Bank account details<br>
          ✅ Property details (if applicable)
        </div>
        <div style="text-align:center;">
          <a href="${kycLink}" class="btn">Complete KYC Verification</a>
        </div>
        <p class="link-fallback">
          If the button doesn't work, copy and paste this link in your browser:<br>
          <a href="${kycLink}" style="color:#667eea;">${kycLink}</a>
        </p>
        <p style="color:#999;font-size:12px;margin-top:20px;">
          This link is unique to your account. Please do not share it with anyone.
        </p>
      </div>
      <div class="footer">
        <p>© 2025 RoomHy. All rights reserved.</p>
        <p>Need help? Contact us at support@roomhy.com</p>
      </div>
    </div>
  </div>
</body>
</html>`;
    const text = `Hello ${displayName},\n\nWelcome to ${portal}! Please complete your KYC verification by visiting the link below:\n\n${kycLink}\n\nThis link is unique to your account. Do not share it.\n\n© 2025 RoomHy`;
    return sendMail(toEmail, subject, text, html);
}

async function sendDirectWhatsAppOtp(toPhone, otp) {
    const cfg = getMailerConfig();
    if (!isWhatsAppConfigured(cfg) || !cfg.whatsappOtpTemplateName) {
        console.warn('WhatsApp OTP skip: not configured or template name missing');
        return false;
    }

    const endpoint = `https://graph.facebook.com/${cfg.whatsappApiVersion}/${cfg.whatsappPhoneNumberId}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'template',
        template: {
            name: cfg.whatsappOtpTemplateName,
            language: {
                code: cfg.whatsappOtpTemplateLanguage || 'en_US'
            },
            components: [
                {
                    type: 'body',
                    parameters: [
                        {
                            type: 'text',
                            text: String(otp)
                        }
                    ]
                },
                {
                    type: 'button',
                    sub_type: 'url',
                    index: 0,
                    parameters: [
                        {
                            type: 'text',
                            text: String(otp)
                        }
                    ]
                }
            ]
        }
    };

    const response = await postJson(endpoint, payload, {
        Authorization: `Bearer ${cfg.whatsappAccessToken}`
    });

    if (response.status >= 200 && response.status < 300) {
        return true;
    }

    console.warn('WhatsApp Direct OTP failed:', response.status, response.body);
    return false;
}

module.exports = { sendCredentials, sendMail, sendWhatsAppMessage, sendDirectWhatsAppOtp, sendKycLinkEmail };
