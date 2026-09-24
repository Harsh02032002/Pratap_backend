const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const dns = require('dns');
const { startCronJobs } = require('./services/cronJobs');
const { registerAllCronJobs } = require('./jobs/dailyRentEvaluator');
const { registerAutoMarkAbsentJob } = require('./jobs/autoMarkAbsentJob');
const { registerOwnerPropertyHealJob } = require('./jobs/ownerPropertyHealJob');
const { registerUnreadChatReminderJob } = require('./jobs/unreadChatReminderJob');
const { startEscalationJob } = require('./controllers/complaintController');
let escalationJobStarted = false;
const initChatSocket = require('./socket/chatSocket');
const { globalApiLimiter } = require('./middleware/security');
const { apiCache, getCacheStats, clearCache } = require('./middleware/apiCache');
const { MONGO, MONGOOSE_BUFFER_TIMEOUT_MS, HTTP } = require('./config/timeouts');
const { installGlobalQueryDeadline } = require('./utils/queryDeadline');

// Installed before any route or model require below, so every schema compiled
// from here on carries a default operation deadline. Without it the request
// deadline can free the HTTP request but not the query behind it, and the pool
// slot stays occupied — see utils/queryDeadline.js.
installGlobalQueryDeadline(mongoose);
const {
    requestDeadline,
    dbTimeoutResponseNormalizer,
    dbTimeoutErrorHandler,
    getTimeoutCounters
} = require('./middleware/requestDeadline');
const { attachPoolMonitor, getPoolStats, isSaturated } = require('./utils/poolMonitor');
const {
    compressionMiddleware,
    hppMiddleware,
    mongoSanitizeMiddleware,
    requestHardening
} = require('./middleware/requestHardening');
let metricsManager = null;
try {
    metricsManager = require('./utils/prometheusMetrics');
} catch (err) {
    console.warn('⚠️ Prometheus metrics disabled:', err.message);
}

console.log('🚀 Starting server...');

// DNS Fix for MongoDB Atlas SRV lookups on Linux VPS (systemd-resolved uses 127.0.0.53)
try {
    const currentServers = dns.getServers();
    console.log('🌐 Current DNS Servers:', currentServers);
    if (!currentServers || currentServers.length === 0 || currentServers.some(s => s.startsWith('127.') || s === '::1')) {
        console.warn('⚠️ Local/stub DNS resolver detected — setting Google/Cloudflare public DNS for Atlas SRV lookups');
        dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
    }
} catch (dnsErr) {
    console.warn('⚠️ Could not override DNS servers:', dnsErr.message);
}

// Always load env from this folder, regardless of where the process was started.
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);

// 1. Robust CORS Middleware - Handles preflight and credentials for all our environments
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isAllowedOrigin = !origin ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('roomhy.com') ||
        origin === 'https://roohmy-frontend-ux44.vercel.app';

    if (isAllowedOrigin && origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// 2. Socket.io initialization with CORS — same origin rules as REST API
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            const allowed = !origin ||
                origin.includes('localhost') ||
                origin.includes('127.0.0.1') ||
                origin.includes('roomhy.com') ||
                origin === 'https://roohmy-frontend-ux44.vercel.app';
            if (allowed) callback(null, true);
            else callback(new Error('Socket.io: origin not allowed'));
        },
        credentials: true,
        methods: ["GET", "POST"]
    }
});
// Expose the Socket.IO server to non-socket code paths. chatController and
// chatManagementController broadcast through `global.io` when a message is sent
// over REST (the owner panel and the accept-bid flow both send that way).
// Without this assignment those guards were always false, so REST-sent messages
// were saved but never pushed — the recipient had to refresh to see them.
global.io = io;

initChatSocket(io);

// 3. Security & Optimization Middlewares
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https:"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "https:", "http://localhost:*", "ws://localhost:*"],
            fontSrc: ["'self'", "https:", "data:"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'", "https:"],
            frameSrc: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// Additional Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(compressionMiddleware);

// Body Parsers
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Security Hardening
app.use(mongoSanitizeMiddleware);
app.use(hppMiddleware);
app.use(requestHardening);

const ROOT_DIR = path.resolve(__dirname, '..');
app.use('/api', globalApiLimiter);

// Bounded lifetime for user-facing API requests. Mounted before apiCache so a
// slow cache miss is covered too. Payment/upload/webhook/report/chat prefixes
// are exempt — see DEADLINE_EXEMPT_PREFIXES in config/timeouts.js.
app.use('/api', requestDeadline);
// Runs before the routes so it can wrap res.json; converts a database timeout a
// controller already answered with 500 into the classified 503 + Retry-After.
app.use('/api', dbTimeoutResponseNormalizer);

// API Response Caching - Speeds up frequently accessed data
app.use('/api', apiCache);

// Connection Keep-Alive for better performance
app.use((req, res, next) => {
    res.setHeader('Keep-Alive', 'timeout=5, max=1000');
    next();
});

if (metricsManager && typeof metricsManager.init === 'function') {
    metricsManager.init(app);
}

console.log('✅ Middleware configured');

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.path}`);
    next();
});

// ── HTTP 301 Redirect Middleware for Legacy SEO URLs (Server-Level) ─────────
const SeoRedirect = require('./models/SeoRedirect');
const seoController = require('./controllers/seoController');

app.use(async (req, res, next) => {
    if (req.method !== 'GET') return next();
    const reqPath = req.path;
    if (reqPath.startsWith('/api/') ||
        reqPath.startsWith('/assets/') ||
        reqPath.startsWith('/images/') ||
        reqPath.startsWith('/js/') ||
        reqPath === '/sitemap.xml' ||
        reqPath.includes('.')) {
        return next();
    }

    try {
        const cleanReqPath = reqPath.replace(/^\/+|\/+$/g, '').toLowerCase();
        if (!cleanReqPath) return next();

        const redirectMatch = await SeoRedirect.findOne({
            $or: [
                { oldUrl: cleanReqPath },
                { oldUrl: '/' + cleanReqPath },
                { oldUrl: reqPath }
            ]
        }).lean();

        if (redirectMatch && redirectMatch.newUrl) {
            const destination = redirectMatch.newUrl.startsWith('/') ? redirectMatch.newUrl : '/' + redirectMatch.newUrl;
            console.log(`🔀 Server HTTP 301 Redirect: ${req.originalUrl} -> ${destination}`);
            return res.redirect(redirectMatch.statusCode || 301, destination);
        }
    } catch (err) {
        console.warn('⚠️ Redirect middleware error:', err.message);
    }
    next();
});

// Root XML Sitemap Route (Dynamic single source of truth from MongoDB)
app.get('/sitemap.xml', seoController.generateSitemapXml);

// Database connection options come from config/timeouts.js, which documents
// why each value is what it is and keeps the whole hierarchy in one place.
// Previously these were inline and inverted relative to the 12s client
// timeout: a request could wait 30s for a pool connection and 45s on the
// socket long after the browser had given up.
const mongoOptions = { ...MONGO };

// Mongoose buffers operations while the connection is down. The 10s default
// silently ate the entire request budget during a reconnect.
mongoose.set('bufferTimeoutMS', MONGOOSE_BUFFER_TIMEOUT_MS);

console.log('🔗 Connecting to MongoDB...');

// Check if MONGO_URI is defined and fix encoding issues
let mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
    console.log('⚠️  MONGO_URI not found in .env file');
    console.error('❌ Please set MONGO_URI in your .env file');
} else {
    console.log('📍 URI length:', mongoUri.length);
    // Host only. The first 50 characters of a mongodb+srv URI are the username
    // and password, so the old preview wrote working credentials into every log
    // sink, crash report and terminal scrollback this process touches.
    console.log('🔍 Cluster:', mongoUri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@]*@/, '$1<redacted>@').split('?')[0]);
}



// Connect to MongoDB.
//
// startServer() is called from HERE and nowhere else. It used to also be
// invoked unconditionally at the bottom of this file, at module load, which
// won the race every time: `if (server.listening) return` then turned the
// call below into a no-op. The result was that the HTTP server and every cron
// job started while mongoose was still opening its first connection, so
// initDemoOwner's Owner.findOne() had nothing to run against, sat in
// mongoose's buffer for the full bufferTimeoutMS and reported
// "buffering timed out after 9000ms" — a startup ordering bug being
// reported as a database timeout. Both outcomes below still start the
// server, so nothing is lost by waiting for the connection to settle first.
(async () => {
    try {
        await mongoose.connect(mongoUri, mongoOptions);
        console.log('✅ MongoDB Connected');
        // Pool saturation is the failure mode behind "random" API timeouts —
        // observe it rather than inferring it.
        attachPoolMonitor(mongoose.connection);
        try {
            const { healChatModerationAndUnblockAccounts } = require('./utils/moderationHelper');
            await healChatModerationAndUnblockAccounts();
        } catch (healErr) {
            console.warn('⚠️ healChatModeration error:', healErr.message);
        }
    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
        console.warn('⚠️ Starting server anyway; API calls may fail until DB reconnects');
    }
    startServer();
})();

// Database connection middleware to ensure connection on every request without creating duplicate pools
app.use(async (req, res, next) => {
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    if (mongoose.connection.readyState === 0) {
        console.log('🔌 Mongoose disconnected, attempting reconnection...');
        try {
            await mongoose.connect(mongoUri, mongoOptions);
            console.log('✅ MongoDB Reconnected (via request middleware)');
        } catch (err) {
            console.error('❌ MongoDB connection error in middleware:', err.message);
            return res.status(500).json({
                success: false,
                message: 'Database connection failed'
            });
        }
    } else if (mongoose.connection.readyState !== 1) {
        return res.status(500).json({
            success: false,
            message: 'Database is reconnecting, please try again shortly.'
        });
    }
    next();
});

async function seedSuperAdminIfMissing() {
    try {
        const User = require('./models/user');
        const count = await User.countDocuments({ role: 'superadmin' });
        if (count === 0) {
            console.log('👤 No superadmin found in DB — auto-seeding default superadmin...');
            const superAdmin = new User({
                name: 'Super Admin',
                email: 'roomhyadmin@gmail.com',
                phone: '9999999999',
                password: 'admin@123',
                role: 'superadmin',
                loginId: 'roomhyadmin@gmail.com',
                status: 'active',
                isActive: true,
                isDeleted: false
            });
            await superAdmin.save();

            const adminUser = new User({
                name: 'Super Admin',
                email: 'admin@roomhy.com',
                phone: '9876543210',
                password: 'admin@123',
                role: 'superadmin',
                loginId: 'superadmin',
                status: 'active',
                isActive: true,
                isDeleted: false
            });
            await adminUser.save();

            console.log('✅ Superadmin accounts auto-seeded successfully!');
            console.log('   ID: roomhyadmin@gmail.com | Password: admin@123');
            console.log('   ID: superadmin            | Password: admin@123');
        }
    } catch (err) {
        console.warn('⚠️ Auto-seed superadmin error:', err.message);
    }
}

async function fixFalselyVerifiedTenants() {
    try {
        const Tenant = require('./models/Tenant');
        const res = await Tenant.updateMany(
            {
                isDeleted: { $ne: true },
                kycStatus: 'verified',
                kycVerificationResult: { $exists: false },
                'digitalCheckin.submittedAt': { $exists: false },
                'digitalCheckin.kyc.aadhaarNumber': { $exists: false }
            },
            {
                $set: { kycStatus: 'pending', status: 'pending' }
            }
        );
        if (res.modifiedCount > 0) {
            console.log(`🔧 Corrected ${res.modifiedCount} falsely auto-verified tenant records back to pending.`);
        }
    } catch (err) {
        console.warn('⚠️ Fix falsely verified tenants warning:', err.message);
    }
}

async function syncCompletedDigitalCheckinTenants() {
    try {
        const Tenant = require('./models/Tenant');
        const res = await Tenant.updateMany(
            {
                isDeleted: { $ne: true },
                kycStatus: { $in: ['audit_pending', 'pending', 'pending_verification'] },
                'digitalCheckin.submittedAt': { $exists: true }
            },
            {
                $set: { kycStatus: 'verified' }
            }
        );
        if (res.modifiedCount > 0) {
            console.log(`✅ Synced ${res.modifiedCount} completed digital check-in tenants to kycStatus: verified.`);
        }
    } catch (err) {
        console.warn('⚠️ Sync completed digital check-in tenants warning:', err.message);
    }
}

async function fixFalselyApprovedOwners() {
    try {
        const Owner = require('./models/Owner');
        const res = await Owner.updateMany(
            {
                isDeleted: { $ne: true },
                status: { $ne: 'approved' },
                $or: [
                    { isEmployeeSubmitted: true },
                    { createdByStaffId: { $exists: true, $ne: '' } },
                    { addedByStaffId: { $exists: true, $ne: '' } }
                ],
                'kyc.verifiedAt': { $exists: false },
                checkinAadhaarNumber: { $exists: false }
            },
            {
                $set: { isActive: false, status: 'pending_approval', isEmployeeSubmitted: true }
            }
        );
        if (res.modifiedCount > 0) {
            console.log(`🔧 Corrected ${res.modifiedCount} falsely approved employee-submitted owner records back to pending_approval.`);
        }
    } catch (err) {
        console.warn('⚠️ Fix falsely approved owners warning:', err.message);
    }
}

let startupJobsRan = false;
async function runStartupJobs() {
    if (startupJobsRan) return;
    startupJobsRan = true;
    try {
        await seedSuperAdminIfMissing();
        await fixFalselyVerifiedTenants();
        await syncCompletedDigitalCheckinTenants();
        await fixFalselyApprovedOwners();
    } catch (err) {
        console.warn('⚠️ Error executing startup tasks:', err.message);
    }
}

mongoose.connection.on('connected', () => {
    console.log('✅ Mongoose connected');
    runStartupJobs();
    if (!escalationJobStarted) {
        escalationJobStarted = true;
        startEscalationJob();
    }
});
mongoose.connection.on('error', (err) => console.error('❌ Mongoose error', err && err.message));
mongoose.connection.on('disconnected', () => {
    if (mongoose.connection.readyState === 0) {
        console.warn('⚠️ Mongoose connection lost (all sockets closed)');
    }
});
mongoose.connection.on('reconnected', () => console.log('✅ Mongoose reconnected'));

// Routes (API Endpoints)
console.log('📍 Loading routes...');

try {
    app.use('/api/auth', require('./routes/authRoutes'));
    console.log('  ✓ authRoutes');
    app.use('/api/properties', require('./routes/propertyRoutes'));
    console.log('  ✓ propertyRoutes');
    app.use('/api/admin', require('./routes/adminRoutes'));
    console.log('  ✓ adminRoutes');
    app.use('/api/tenants', require('./routes/tenantRoutes'));
    console.log('  ✓ tenantRoutes');
    app.use('/api/visits', require('./routes/visitDataRoutes'));
    console.log('  ✓ visitDataRoutes');
    app.use('/api/bank', require('./routes/bankRoutes'));
    console.log('  ✓ bankRoutes');
    app.use('/api/rooms', require('./routes/roomRoutes'));
    console.log('  ✓ roomRoutes');
    app.use('/api/notifications', require('./routes/notificationRoutes'));
    console.log('  ✓ notificationRoutes');
    app.use('/api/owners', require('./routes/ownerRoutes'));
    console.log('  ✓ ownerRoutes');
    app.use('/api/dashboard', require('./routes/dashboardRoutes'));
    console.log('  ✓ dashboardRoutes');
    app.use('/api/owner-change-requests', require('./routes/ownerChangeRequestRoutes'));
    console.log('  ✓ ownerChangeRequestRoutes');
    app.use('/api/tenant-kyc-requests', require('./routes/tenantKycRequestRoutes'));
    console.log('  ✓ tenantKycRequestRoutes');
    app.use('/api/employees', require('./routes/employeeRoutes'));
    console.log('  ✓ employeeRoutes');
    app.use('/api/complaints', require('./routes/complaintRoutes'));
    console.log('  ✓ complaintRoutes');
    app.use('/api/booking', require('./routes/bookingRoutes'));
    console.log('  ✓ bookingRoutes (as /api/booking)');
    app.use('/api/bookings', require('./routes/bookingRoutes'));
    console.log('  ✓ bookingRoutes (as /api/bookings)');
    app.use('/api/favorites', require('./routes/favoritesRoutes'));
    console.log('  ✓ favoritesRoutes');
    app.use('/api/bids', require('./routes/bidsRoutes'));
    console.log('  ✓ bidsRoutes');
    app.use('/api/kyc', require('./routes/kycRoutes'));
    console.log('  ✓ kycRoutes');
    app.use('/api/signups', require('./routes/kycRoutes'));
    console.log('  ✓ kycRoutes (as /api/signups)');
    app.use('/api/cities', require('./routes/citiesRoutes'));
    console.log('  ✓ citiesRoutes');
    app.use('/api/property-types', require('./routes/propertyTypeRoutes'));
    console.log('  ✓ propertyTypeRoutes');
    app.use('/api/locations', require('./routes/locationRoutes'));
    console.log('  ✓ locationRoutes');
    app.use('/api/website-enquiry', require('./routes/websiteEnquiryRoutes'));
    console.log('  ✓ websiteEnquiryRoutes (as /api/website-enquiry)');
    app.use('/api/website-enquiries', require('./routes/websiteEnquiryRoutes'));
    console.log('  ✓ websiteEnquiryRoutes (as /api/website-enquiries)');
    app.use('/api/property-enquiries', require('./routes/propertyEnquiryRoutes'));
    console.log('  ✓ propertyEnquiryRoutes');
    app.use('/api/approved-properties', require('./routes/approvedPropertiesRoutes'));
    console.log('  ✓ approvedPropertiesRoutes');
    app.use('/api/approvals', require('./routes/approvedPropertiesRoutes'));
    console.log('  ✓ approvedPropertiesRoutes (as /api/approvals)');
    app.use('/api/website-property-data', require('./routes/websitePropertyDataRoutes'));
    console.log('  ✓ websitePropertyDataRoutes');

    try {
        app.use('/api/website-properties', require('./routes/websitePropertyRoutes'));
        console.log('  ✓ websitePropertyRoutes');
    } catch (e) {
        console.log('  ⚠️  websitePropertyRoutes not loaded:', e.message);
    }

    app.use('/api/chat', require('./routes/chatRoutes'));
    console.log('  ✓ chatRoutes');
    app.use('/api/email', require('./routes/emailRoutes'));
    console.log('  ✓ emailRoutes');
    app.use('/api/checkin', require('./routes/checkinRoutes'));
    console.log('  ✓ checkinRoutes');
    app.use('/api/whatsapp', require('./routes/whatsappRoutes'));
    console.log('  ✓ whatsappRoutes');
    app.use('/webhook', require('./routes/whatsappWebhookRoutes'));
    console.log('  ✓ whatsappWebhookRoutes');
    app.use('/zoho', require('./routes/zohoRoutes'));
    console.log('  ✓ zohoRoutes');
    app.use('/api/colleges', require('./routes/collegeRoutes'));
    console.log('  ✓ collegeRoutes');
    app.use('/api/property-colleges', require('./routes/propertyColleges'));
    console.log('  ✓ propertyColleges');
    app.use('/api/reviews', require('./routes/reviewRoutes'));
    console.log('  ✓ reviewRoutes');
    app.use('/api/rents', require('./routes/rentRoutes'));
    console.log('  ✓ rentRoutes');
    app.use('/api/wallet', require('./routes/walletRoutes'));
    console.log('  ✓ walletRoutes');
    app.use('/api/rent-collection', require('./routes/rentCollectionRoutes'));
    console.log('  ✓ rentCollectionRoutes');
    app.use('/api/electricity', require('./routes/electricityRoutes'));
    console.log('  ✓ electricityRoutes');
    app.use('/api/payments/payu', require('./routes/payuPaymentRoutes'));
    app.use('/api/payments', require('./routes/payuPaymentRoutes'));
    console.log('  ✓ payuPaymentRoutes (mounted at /api/payments/payu and /api/payments)');
    app.use('/api/tickets', require('./routes/ticketRoutes'));
    console.log('  ✓ ticketRoutes');

    // Direct Browser Link to seed Tenant for Owner ROOMHY6120
    app.get('/api/seed-tenant-6120-direct', async (req, res) => {
        try {
            const bcrypt = require('bcryptjs');
            const Owner = require('./models/Owner');
            const Property = require('./models/Property');
            const ApprovedProperty = require('./models/ApprovedProperty');
            const Room = require('./models/Room');
            const Tenant = require('./models/Tenant');
            const Rent = require('./models/Rent');
            const User = require('./models/user');
            const BookingRequest = require('./models/BookingRequest');

            const targetOwnerId = 'ROOMHY6120';
            let ownerDoc = await Owner.findOne({ loginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
            if (!ownerDoc) {
                const hashedPassword = await bcrypt.hash('Roomhy@123', 10);
                ownerDoc = await Owner.create({
                    loginId: targetOwnerId,
                    name: 'Live Owner 6120',
                    phone: '9876543210',
                    email: 'owner6120@roomhy.com',
                    status: 'approved',
                    isApproved: true,
                    isActive: true,
                    password: hashedPassword
                });
            }

            let ownerUser = await User.findOne({ loginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
            if (!ownerUser) {
                const hashedPassword = await bcrypt.hash('Roomhy@123', 10);
                ownerUser = await User.create({
                    name: ownerDoc.name || 'Live Owner 6120',
                    loginId: targetOwnerId,
                    phone: ownerDoc.phone || '9876543210',
                    email: ownerDoc.email || 'owner6120@roomhy.com',
                    role: 'owner',
                    password: hashedPassword,
                    status: 'active',
                    isActive: true
                });
            }

            let property = await Property.findOne({ ownerLoginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
            if (!property) {
                property = await ApprovedProperty.findOne({ ownerLoginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
            }
            if (!property) {
                property = await Property.create({
                    title: 'Roomhy Premium Stay (6120)',
                    ownerLoginId: targetOwnerId,
                    owner_id: targetOwnerId,
                    owner: ownerDoc._id,
                    status: 'approved',
                    isApproved: true,
                    city: 'Jaipur',
                    address: 'Sector 6, Main Road',
                    propertyType: 'PG'
                });
                await ApprovedProperty.create({
                    title: 'Roomhy Premium Stay (6120)',
                    ownerLoginId: targetOwnerId,
                    owner_id: targetOwnerId,
                    owner: ownerDoc._id,
                    status: 'approved',
                    city: 'Jaipur',
                    address: 'Sector 6, Main Road',
                    propertyType: 'PG'
                }).catch(() => null);
            }

            const roomNumber = '101';
            let room = await Room.findOne({ property: property._id, title: roomNumber });
            if (!room) {
                room = await Room.create({
                    property: property._id,
                    title: roomNumber,
                    type: 'Single Sharing',
                    beds: 1,
                    price: 8500,
                    status: 'available',
                    isAvailable: false
                });
            } else {
                room.status = 'available';
                room.isAvailable = false;
                await room.save();
            }

            const tenantPhone = '9876506120';
            const tenantEmail = 'tenant6120@roomhy.com';
            const tenantLoginId = 'ROOMHYTNT6120';
            const tenantName = 'Amit Verma (Live)';
            const tenantPasswordRaw = 'Tenant@123';
            const hashedPassword = await bcrypt.hash(tenantPasswordRaw, 10);

            await User.deleteMany({ loginId: tenantLoginId });
            await Tenant.deleteMany({ loginId: tenantLoginId });

            const tenantUser = await User.create({
                name: tenantName,
                phone: tenantPhone,
                email: tenantEmail,
                loginId: tenantLoginId,
                password: hashedPassword,
                role: 'tenant',
                status: 'active',
                isActive: true
            });

            await Tenant.create({
                name: tenantName,
                phone: tenantPhone,
                email: tenantEmail,
                property: property._id,
                room: room._id,
                roomNo: roomNumber,
                baseRoomRent: 8500,
                agreedRent: 8500,
                ownerLoginId: targetOwnerId,
                propertyTitle: property.title,
                status: 'active',
                moveInDate: new Date(),
                loginId: tenantLoginId,
                user: tenantUser._id,
                tempPassword: tenantPasswordRaw
            });

            await BookingRequest.create({
                user_id: tenantUser._id.toString(),
                name: tenantName,
                phone: tenantPhone,
                email: tenantEmail,
                property_id: property._id.toString(),
                property_name: property.title,
                owner_id: targetOwnerId,
                owner_name: ownerDoc.name || 'Live Owner 6120',
                request_type: 'direct',
                rent_amount: 8500,
                total_amount: 500,
                status: 'confirmed',
                booking_status: 'confirmed',
                bookingStatus: 'confirmed',
                move_in_date: new Date(),
                check_in_date: new Date()
            });

            const collectionMonth = new Date().toLocaleString('default', { month: 'short', year: 'numeric' });
            await Rent.deleteMany({ tenantLoginId });

            await Rent.create({
                propertyName: property.title,
                roomNumber: roomNumber,
                tenantName: tenantName,
                tenantPhone: tenantPhone,
                tenantLoginId: tenantLoginId,
                ownerLoginId: targetOwnerId,
                ownerName: ownerDoc.name || 'Live Owner 6120',
                rentAmount: 8500,
                totalDue: 8500,
                paidAmount: 8500,
                dueAmount: 0,
                paymentStatus: 'paid',
                collectionMonth: collectionMonth,
                moveInDate: new Date()
            });

            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Tenant Seeded - Roomhy</title>
                    <style>
                        body { font-family: Arial, sans-serif; background: #f4f6f8; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                        .card { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); max-width: 480px; width: 100%; border: 1px solid #e2e8f0; }
                        h2 { color: #16a34a; margin-top: 0; }
                        .item { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px dashed #cbd5e1; font-size: 14px; }
                        .label { font-weight: bold; color: #475569; }
                        .val { font-weight: bold; color: #0f172a; }
                        .badge { background: #dcfce7; color: #15803d; padding: 4px 8px; border-radius: 6px; font-weight: bold; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h2>✅ Tenant Created Successfully!</h2>
                        <p style="color:#64748b;font-size:13px;">Tenant is assigned to Owner ID: <b>${targetOwnerId}</b></p>
                        
                        <div class="item"><span class="label">Owner Login ID</span><span class="val">${targetOwnerId}</span></div>
                        <div class="item"><span class="label">Tenant Name</span><span class="val">${tenantName}</span></div>
                        <div class="item"><span class="label">Tenant Login ID</span><span class="val">${tenantLoginId}</span></div>
                        <div class="item"><span class="label">Tenant Phone</span><span class="val">${tenantPhone}</span></div>
                        <div class="item"><span class="label">Tenant Password</span><span class="val" style="color:#2563eb;">${tenantPasswordRaw}</span></div>
                        <div class="item"><span class="label">Property</span><span class="val">${property.title}</span></div>
                        <div class="item"><span class="label">Room Number</span><span class="val">#${roomNumber}</span></div>
                        <div class="item"><span class="label">Agreed Rent</span><span class="val">₹8,500</span></div>
                        <div class="item"><span class="label">Rent Status</span><span class="badge">Paid (₹8,500)</span></div>
                    </div>
                </body>
                </html>
            `);
        } catch (err) {
            res.status(500).send(`<h3>Error Seeding Tenant: ${err.message}</h3>`);
        }
    });
    app.use('/api/complaints', require('./routes/complaintRoutes'));
    console.log('  ✓ complaintRoutes');
    app.use('/api/maintenance', require('./routes/maintenanceRoutes'));
    console.log('  ✓ maintenanceRoutes');
    app.use('/api/property-managers', require('./routes/propertyManagerRoutes'));
    console.log('  ✓ propertyManagerRoutes');
    app.use('/api/employees', require('./routes/employeeRoutes'));
    console.log('  ✓ employeeRoutes');
    app.use('/api/hr', require('./routes/hrRoutes'));
    console.log('  ✓ hrRoutes');
    app.use('/api/visitors', require('./routes/visitorRoutes'));
    console.log('  ✓ visitorRoutes');
    app.use('/api/leaves', require('./routes/leaveRequestRoutes'));
    console.log('  ✓ leaveRequestRoutes');
    app.use('/api/tenant-attendance', require('./routes/tenantAttendanceRoutes'));
    console.log('  ✓ tenantAttendanceRoutes');
    app.use('/api/gates', require('./routes/gateRoutes'));
    console.log('  ✓ gateRoutes');
    app.use('/api/announcements', require('./routes/announcementRoutes'));
    console.log('  ✓ announcementRoutes');
    app.use('/api/coupons', require('./routes/couponRoutes'));
    console.log('  ✓ couponRoutes');
    app.use('/api/marketing-assets', require('./routes/marketingAssetRoutes'));
    console.log('  ✓ marketingAssetRoutes');
    app.use('/api/reports', require('./routes/reportRoutes'));
    console.log('  ✓ reportRoutes');
    app.use('/api/tasks', require('./routes/taskRoutes'));
    console.log('  ✓ taskRoutes');
    app.use('/api/tenant-gate', require('./routes/tenantGateRoutes'));
    console.log('  ✓ tenantGateRoutes');
    app.use('/api/user', require('./routes/userRoutes'));
    app.use('/api/superadmin', require('./routes/superadminRoutes'));
    app.use('/api/superadmin/finance', require('./routes/financeRoutes'));
    app.use('/api/finance', require('./routes/financeRoutes'));
    console.log('  ✓ financeRoutes');
    app.use('/api/amenities', require('./routes/amenityRoutes'));
    console.log('  ✓ amenityRoutes');
    app.use('/api/pricing', require('./routes/pricingRoutes'));
    console.log('  ✓ pricingRoutes');
    app.use('/api/featured', require('./routes/featuredRoutes'));
    console.log('  ✓ featuredRoutes');
    app.use('/api', require('./routes/uploadRoutes'));
    console.log('  ✓ uploadRoutes');

    // ── Content & SEO routes (NEW) ──────────────────────────────────────────
    app.use('/api/seo', require('./routes/seoRoutes'));
    console.log('  ✓ seoRoutes');
    app.use('/api/page-layouts', require('./routes/pageLayoutRoutes'));
    console.log('  ✓ pageLayoutRoutes');
    app.use('/api/blogs', require('./routes/blogRoutes'));
    console.log('  ✓ blogRoutes');
    app.use('/api/testimonials', require('./routes/testimonialRoutes'));
    console.log('  ✓ testimonialRoutes');
    app.use('/api/banners', require('./routes/bannerRoutes'));
    console.log('  ✓ bannerRoutes');
    app.use('/api/media', require('./routes/mediaRoutes'));
    console.log('  ✓ mediaRoutes');

    // ── PayU PG Gateway Routes ────────�// ── Quick Seed: Add test tenants to vacant rooms for owner ROOMHY9602 ────────
app.get('/api/seed-test-tenants-9602', async (req, res) => {
    try {
        const Room     = require('./models/Room');
        const Tenant   = require('./models/Tenant');
        const Property = require('./models/Property');
        const bcrypt   = require('bcryptjs');
        const ownerLoginId = 'ROOMHY9602';

        // Find owner's properties first (Room has no ownerLoginId field)
        const properties = await Property.find({ ownerLoginId: { $regex: new RegExp(`^${ownerLoginId}$`, 'i') } }).lean();
        if (properties.length === 0) {
            return res.json({ success: false, message: `No properties found for owner ${ownerLoginId}` });
        }
        const propIds = properties.map(p => p._id);

        // Find all rooms for these properties
        const rooms = await Room.find({ property: { $in: propIds }, isDeleted: { $ne: true } }).lean();
        if (rooms.length === 0) {
            return res.json({ success: false, message: 'No rooms found for this owner' });
        }

        // Filter rooms that have at least one vacant bed slot
        const vacantRooms = rooms.filter(r => {
            const assignments = r.bedAssignments || [];
            const totalBeds = Math.max(r.beds || 1, 1);
            for (let b = 0; b < totalBeds; b++) {
                if (!assignments[b] || !assignments[b].tenantId) return true;
            }
            return false;
        });

        if (vacantRooms.length === 0) {
            return res.json({ success: true, message: `All ${rooms.length} room(s) are fully occupied — no vacant beds!` });
        }

        const hashedPwd = await bcrypt.hash('Test@123', 10);
        const created = [];

        for (let i = 0; i < vacantRooms.length; i++) {
            const room = vacantRooms[i];
            const assignments = room.bedAssignments || [];
            const totalBeds = Math.max(room.beds || 1, 1);
            let bedIndex = 0;
            for (let b = 0; b < totalBeds; b++) {
                if (!assignments[b] || !assignments[b].tenantId) { bedIndex = b; break; }
            }
            const suffix = `${Date.now()}${i}`.slice(-6);
            const loginId = `TEST${suffix}`;
            const tenantName = `Test Tenant ${i + 1}`;

            const tenant = await Tenant.create({
                name: tenantName,
                phone: `9900${String(Date.now()).slice(-6)}`,
                email: `test${suffix}@roomhy.test`,
                loginId, password: hashedPwd,
                ownerLoginId, property: room.property, room: room._id,
                roomNo: room.title, bedNo: bedIndex + 1,
                agreedRent: room.price || 2000,
                status: 'active', moveInDate: new Date(), kycStatus: 'pending',
            });

            const updatedAssignments = [...assignments];
            while (updatedAssignments.length <= bedIndex) updatedAssignments.push({});
            updatedAssignments[bedIndex] = { tenantId: tenant._id, tenantName, tenantLoginId: loginId, assignedAt: new Date() };
            await Room.findByIdAndUpdate(room._id, { $set: { bedAssignments: updatedAssignments } });

            created.push({ room: room.title, bed: bedIndex + 1, tenant: tenantName, loginId });
        }

        res.json({ success: true, message: `✅ ${created.length} test tenant(s) added!`, created, note: 'Password: Test@123' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

antLoginId: loginId, assignedAt: new Date() };
            await Room.findByIdAndUpdate(room._id, { $set: { bedAssignments: updatedAssignments } });
            created.push({ room: room.title || room.number, bed: bedIndex + 1, tenant: tenant.name, loginId });
        }

        res.json({ success: true, message: `${created.length} test tenant(s) added!`, created, note: 'Password: Test@123' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/health', (req, res) => {
    const pool = getPoolStats();
    const saturated = isSaturated(mongoOptions.maxPoolSize);
    res.json({
        success: true,
        service: 'roomhy-backend',
        env: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        cache: getCacheStats(),
        // Timeout + pool observability. Counters are per-process and reset on
        // restart; they exist to tell "too many requests" apart from "queries
        // too slow", which need opposite fixes.
        timeouts: getTimeoutCounters(),
        pool: {
            ...pool,
            maxPoolSize: mongoOptions.maxPoolSize,
            saturated
        }
    });
});

// ── TEST ENDPOINT: Trigger agreement expiry for a tenant (remove in production) ──
app.get('/api/test/agreement-expiry/:loginId', async (req, res) => {
    try {
        const Tenant = require('./models/Tenant');
        const Notification = require('./models/Notification');
        const { sendMail } = require('./utils/mailer');

        const tenant = await Tenant.findOne({ loginId: req.params.loginId });
        if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

        const originalDate = tenant.moveInDate;
        const originalStatus = tenant.status;

        // Set moveInDate to 11 months + 4 days ago
        const testDate = new Date();
        testDate.setMonth(testDate.getMonth() - 11);
        testDate.setDate(testDate.getDate() - 4);
        tenant.moveInDate = testDate;
        await tenant.save();

        const now = new Date(); now.setHours(0, 0, 0, 0);
        const start = new Date(testDate); start.setHours(0, 0, 0, 0);
        const daysSince = Math.floor((now - start) / 86400000);
        const monthDiff = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
        const dayInMonthDiff = now.getDate() - start.getDate();
        const isGraceExpired = monthDiff > 11 || (monthDiff === 11 && dayInMonthDiff >= 3);

        let actions = [];

        if (isGraceExpired && tenant.status === 'active') {
            tenant.status = 'inactive';
            await tenant.save();
            actions.push('status_changed_to_inactive');

            if (tenant.loginId) {
                await Notification.create({ toLoginId: tenant.loginId, type: 'system', title: '⚠️ Agreement Expired — Account Suspended', message: 'Your 11-month agreement has expired and the 3-day grace period is over. Your account has been marked inactive.', read: false });
                actions.push('tenant_notified');
            }
            if (tenant.ownerLoginId) {
                await Notification.create({ toLoginId: tenant.ownerLoginId, type: 'system', title: `🚨 Tenant ${tenant.name} — Agreement Expired`, message: `Tenant ${tenant.name} (Room: ${tenant.roomNo || 'N/A'}) agreement has expired. They have been marked inactive.`, read: false });
                actions.push('owner_notified');
            }
            if (tenant.email) {
                await sendMail(tenant.email, '⚠️ Your Roomhy Agreement Has Expired', `Dear ${tenant.name}, your agreement has expired.`, `<h2>Agreement Expired</h2><p>Your account is now inactive. Contact your property owner.</p>`).catch(() => { });
                actions.push('email_sent');
            }
        }

        res.json({
            success: true,
            tenant: tenant.name,
            loginId: tenant.loginId,
            originalMoveInDate: originalDate,
            testMoveInDate: testDate,
            originalStatus,
            newStatus: tenant.status,
            daysSince,
            monthDiff,
            dayInMonthDiff,
            isGraceExpired,
            actions
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── TEST ENDPOINT: Reactivate move-out / inactive tenant for testing ──
app.get('/api/test/reactivate-tenant/:loginId', async (req, res) => {
    try {
        const Tenant = require('./models/Tenant');
        const User = require('./models/user');
        const loginId = String(req.params.loginId || '').trim().toUpperCase();

        const tenant = await Tenant.findOne({ loginId });
        if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

        tenant.status = 'active';
        tenant.kycStatus = 'verified';
        tenant.isDeleted = false;
        tenant.moveoutRequest = { status: 'none', requestedDate: null, reason: '', submittedAt: null, duesAtMoveout: 0, refundAmount: 0, refundStatus: '' };
        await tenant.save();

        const user = await User.findOne({ loginId });
        if (user) {
            user.status = 'active';
            user.isActive = true;
            user.isDeleted = false;
            await user.save();
        }

        res.json({
            success: true,
            message: `Tenant ${loginId} (${tenant.name}) reactivated successfully!`,
            tenantStatus: tenant.status,
            userActive: user ? user.isActive : false
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Cache management endpoints (admin only - add auth later)
app.get('/api/admin/cache-stats', (req, res) => {
    res.json({
        success: true,
        cache: getCacheStats()
    });
});

app.post('/api/admin/clear-cache', (req, res) => {
    const { path } = req.body || {};
    clearCache(path);
    res.json({
        success: true,
        message: path ? `Cache cleared for: ${path}` : 'All cache cleared',
        cache: getCacheStats()
    });
});

// Root route handler for Vercel
app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'roomhy-backend API',
        version: '1.0.1',
        status: 'running - CORS Fixed',
        timestamp: new Date().toISOString(),
        cors: 'All origins allowed'
    });
});

// Favicon handler
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// End of manual CORS middleware removed - handled by cors() at line 164

// Static File Serving (MUST come AFTER API routes)
console.log('📁 Configuring static files...');
app.use(express.static(ROOT_DIR));
app.use('/Areamanager', express.static(path.join(ROOT_DIR, 'Areamanager')));
app.use('/propertyowner', express.static(path.join(ROOT_DIR, 'propertyowner')));
app.use('/tenant', express.static(path.join(ROOT_DIR, 'tenant')));
app.use('/superadmin', express.static(path.join(ROOT_DIR, 'superadmin')));
app.use('/website', express.static(path.join(ROOT_DIR, 'website')));
app.use('/images', express.static(path.join(ROOT_DIR, 'images')));
app.use('/js', express.static(path.join(ROOT_DIR, 'js')));
console.log('✅ Static files configured');

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Database timeouts are classified into 503 + Retry-After before reaching the
// generic handler, so pool exhaustion and query timeouts are distinguishable
// in logs instead of all surfacing as an opaque 500.
app.use(dbTimeoutErrorHandler);

app.use((err, req, res, next) => {
    console.error('Express Error:', err);
    // The deadline middleware may already have responded, and the client may
    // have hung up — either way a second write would throw.
    if (res.headersSent || res.writableEnded) return next(err);
    res.status(500).json({
        success: false,
        message: err.message || 'Internal Server Error'
    });
});

// ── Admin Panel (SPA) — served at /admin ────────────────────────────────────
const fs = require('fs');
const possibleAdminPaths = [
    path.join(__dirname, '../roomhy-admin-clone/dist'),   // sibling folder
    path.join(__dirname, './admin-dist'),                  // same folder as backend
    path.join(__dirname, '../admin-dist'),                 // one level up
    '/var/www/roomhy-admin',                              // nginx default
    '/var/www/html/admin',                                // nginx default 2
];
const adminDistPath = possibleAdminPaths.find(p => fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html')));

if (adminDistPath) {
    app.use('/admin', express.static(adminDistPath, { index: false }));
    // SPA fallback — use regex to avoid path-to-regexp wildcard issues in Express 5
    app.get(/^\/admin(\/.*)?$/, (req, res) => res.sendFile(path.join(adminDistPath, 'index.html')));
    console.log(`✅ Admin panel served at /admin from: ${adminDistPath}`);
} else {
    app.get(/^\/admin(\/.*)?$/, (req, res) => res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>Admin Panel Not Built</h2>
        <p>Run: <code>cd roomhy-admin-clone && npm run build && cp -r dist ../Roomhy-Backend/admin-dist</code></p>
        </body></html>
    `));
    console.log('ℹ️  Admin panel build not found.');
}

// ── Fallback bulk room endpoints (guarantee these always work) ─────────────
const Room = require('./models/Room');
const Tenant = require('./models/Tenant');

app.post('/api/rooms/bulk-clear-tenants', async (req, res) => {
    try {
        const { roomIds } = req.body;
        if (!Array.isArray(roomIds) || roomIds.length === 0) {
            return res.status(400).json({ success: false, message: 'roomIds[] required' });
        }
        await Room.updateMany({ _id: { $in: roomIds } }, { $set: { bedAssignments: [], bedsInfo: [] } });
        return res.json({ success: true, message: `Tenant assignments cleared from ${roomIds.length} room(s)` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/rooms/bulk-delete', async (req, res) => {
    try {
        const { roomIds } = req.body;
        if (!Array.isArray(roomIds) || roomIds.length === 0) {
            return res.status(400).json({ success: false, message: 'roomIds[] required' });
        }
        const result = await Room.deleteMany({ _id: { $in: roomIds } });
        return res.json({ success: true, deleted: result.deletedCount, message: `${result.deletedCount} room(s) deleted` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/tenants/bulk-delete', async (req, res) => {
    try {
        const { tenantIds } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        const result = await Tenant.deleteMany({ _id: { $in: tenantIds } });
        return res.json({ success: true, deleted: result.deletedCount, message: `${result.deletedCount} tenant(s) deleted` });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 404 handler for unmatched routes
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({
            success: false,
            message: 'API endpoint not found'
        });
    }
    res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 5001;

function startServer() {
    // Don't start server in Vercel serverless environment
    if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
        console.log('🌐 Running in serverless environment, skipping server start');
        return;
    }

    if (server.listening) return;

    // Backstops for pathological sockets — NOT the request deadline.
    // requestTimeout covers receiving the full body, so it stays generous:
    // uploads accept up to 15MB and a slow mobile connection needs the room.
    // Node's default is 300s.
    server.requestTimeout = HTTP.requestTimeout;
    server.headersTimeout = HTTP.headersTimeout;

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`⚠️ Port ${PORT} in use. Retrying connection in 1.5s...`);
            setTimeout(() => {
                try { server.close(); } catch (_) { }
                server.listen(PORT, '0.0.0.0');
            }, 1500);
        } else {
            console.error('❌ Server error:', err);
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ Backend API running on http://localhost:${PORT}\n`);

        // Start cron jobs for automated rent reminders
        try {
            startCronJobs();
            registerAllCronJobs();
            registerAutoMarkAbsentJob();
            registerOwnerPropertyHealJob();
            registerUnreadChatReminderJob();
        } catch (err) {
            console.warn('⚠️  Cron jobs failed to start:', err.message);
        }
    });
}

// Vercel serverless function export
if (process.env.VERCEL) {
    module.exports = app;
}
// Local development does NOT call startServer() here: the mongoose.connect
// block above owns startup, on both the success and the failure path. Calling
// it at module load raced the connection and started the cron jobs before the
// database was reachable (see the note there).
module.exports = app;
