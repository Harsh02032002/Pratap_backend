/**
 * Prometheus Metrics Integration for Roomhy Backend
 * 
 * This module sets up Prometheus monitoring for the Node.js backend.
 * Collects metrics on HTTP requests, database operations, and system health.
 * 
 * Installation:
 *   npm install prom-client
 * 
 * Usage in server.js:
 *   const metricsManager = require('./utils/prometheusMetrics');
 *   metricsManager.init(app);
 * 
 * Access metrics at:
 *   GET /metrics (Prometheus format)
 * 
 * Metrics exposed:
 *   - http_requests_total: Total HTTP requests by method, route, status
 *   - http_request_duration_seconds: Request latency histogram
 *   - nodejs_memory_heap_used_bytes: Memory usage
 *   - nodejs_gc_duration_seconds: Garbage collection timing
 *   - mongodb_connections: MongoDB connection pool status
 *   - errors_total: Application errors
 */

const promClient = require('prom-client');

// ============================================================================
// Metrics Registry & Default Metrics
// ============================================================================

// Create a custom registry to avoid duplicate registrations
const register = new promClient.Registry();

// Collect default metrics (CPU, memory, gc, etc)
promClient.collectDefaultMetrics({ register });

// ============================================================================
// Custom Metrics
// ============================================================================

// HTTP Request Counter
const httpRequestCounter = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register]
});

// HTTP Request Duration Histogram
const httpRequestDuration = new promClient.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5], // milliseconds
    registers: [register]
});

// Application Errors Counter
const appErrorCounter = new promClient.Counter({
    name: 'app_errors_total',
    help: 'Total application errors',
    labelNames: ['error_type', 'route'],
    registers: [register]
});

// MongoDB Connection Pool Gauge
const mongoConnectionGauge = new promClient.Gauge({
    name: 'mongodb_connections_active',
    help: 'Active MongoDB connections',
    registers: [register]
});

// Active Requests Gauge
const activeRequestsGauge = new promClient.Gauge({
    name: 'http_requests_active',
    help: 'Number of active HTTP requests',
    registers: [register]
});

// Database Query Duration Histogram
const dbQueryDuration = new promClient.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query duration in seconds',
    labelNames: ['operation', 'collection'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1],
    registers: [register]
});

// Rate Limite Hits Counter
const rateLimitCounter = new promClient.Counter({
    name: 'rate_limit_hits_total',
    help: 'Total rate limit hits',
    labelNames: ['endpoint'],
    registers: [register]
});

// ============================================================================
// Redis / Cache
// ============================================================================
// Labels are bounded enums only: panel (owner|sa|staff), resource, op, reason,
// limiter. Never a user/owner/employee id or a raw cache key — those are
// unbounded and would blow up the series count.

const cacheMetrics = {
    hits: new promClient.Counter({
        name: 'cache_hits_total',
        help: 'Cache reads served from Redis',
        labelNames: ['panel', 'resource'],
        registers: [register]
    }),
    misses: new promClient.Counter({
        name: 'cache_misses_total',
        help: 'Cache reads not found in Redis (served from MongoDB)',
        labelNames: ['panel', 'resource'],
        registers: [register]
    }),
    errors: new promClient.Counter({
        name: 'cache_errors_total',
        help: 'Cache operations that failed and fell back to MongoDB',
        labelNames: ['panel', 'op'],
        registers: [register]
    }),
    bypass: new promClient.Counter({
        name: 'cache_bypass_total',
        help: 'Requests that skipped the cache (disabled, no_scope, redis_unavailable, too_large)',
        labelNames: ['panel', 'resource', 'reason'],
        registers: [register]
    })
};

const redisMetrics = {
    commandDuration: new promClient.Histogram({
        name: 'redis_command_duration_seconds',
        help: 'Redis command latency in seconds',
        labelNames: ['op'],
        buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
        registers: [register]
    }),
    connectionErrors: new promClient.Counter({
        name: 'redis_connection_errors_total',
        help: 'Redis client error events (connection refused, reset, timeout, auth)',
        registers: [register]
    }),
    rateLimitFallback: new promClient.Counter({
        name: 'rate_limit_store_fallback_total',
        help: 'Rate-limit operations counted in process memory because Redis failed',
        labelNames: ['limiter', 'op'],
        registers: [register]
    }),
    up: new promClient.Gauge({
        name: 'redis_up',
        help: '1 when this process has a ready Redis connection',
        registers: [register]
    })
};

// Memory and evictions come from Redis INFO (cached 10s in redisClient), read
// at scrape time. Lazy require: redisClient requires this module too.
async function readRedisInfo() {
    try {
        return await require('./redisClient').getInfoSnapshot();
    } catch (_) {
        return null;
    }
}

new promClient.Gauge({
    name: 'redis_memory_used_bytes',
    help: 'Redis used_memory as reported by INFO',
    registers: [register],
    async collect() {
        const info = await readRedisInfo();
        if (info) this.set(info.usedMemoryBytes);
    }
});

new promClient.Gauge({
    name: 'redis_evicted_keys',
    help: 'Redis evicted_keys since the Redis server started (INFO); any rise means memory pressure',
    registers: [register],
    async collect() {
        const info = await readRedisInfo();
        if (info) this.set(info.evictedKeys);
    }
});

// ============================================================================
// Middleware
// ============================================================================

/**
 * Express middleware to track HTTP request metrics
 */
function metricsMiddleware(req, res, next) {
    const start = Date.now();
    
    // Track active requests
    activeRequestsGauge.inc();
    
    // Capture original res.end
    const originalEnd = res.end;
    res.end = function(...args) {
        // Calculate duration
        const duration = (Date.now() - start) / 1000;
        
        // Get route name (normalize for better grouping)
        let route = req.route?.path || req.path;
        
        // Simplify dynamic routes
        if (route.includes(':')) {
            route = route.replace(/:[^/]+/g, ':id');
        }
        
        // Skip metrics endpoint itself
        if (!route.includes('/metrics')) {
            // Record metrics
            httpRequestCounter
                .labels(req.method, route, res.statusCode)
                .inc();
            
            httpRequestDuration
                .labels(req.method, route, res.statusCode)
                .observe(duration);
        }
        
        // Decrement active requests
        activeRequestsGauge.dec();
        
        // Call original end
        return originalEnd.apply(res, args);
    };
    
    next();
}

/**
 * Track errors
 */
function errorTrackingMiddleware(err, req, res, next) {
    const errorType = err.constructor.name || 'UnknownError';
    const route = req.route?.path || req.path;
    
    appErrorCounter
        .labels(errorType, route)
        .inc();
    
    next(err);
}

/**
 * Track rate limit hits
 */
function trackRateLimit(endpoint) {
    rateLimitCounter.labels(endpoint).inc();
}

// ============================================================================
// Database Metrics Wrapper
// ============================================================================

/**
 * Wrap MongoDB operations to track query duration
 * Usage: dbMetrics.trackQuery(collection, operation, async () => {...})
 */
const dbMetrics = {
    async trackQuery(collection, operation, queryFn) {
        const start = Date.now();
        try {
            const result = await queryFn();
            const duration = (Date.now() - start) / 1000;
            
            dbQueryDuration
                .labels(operation, collection)
                .observe(duration);
            
            return result;
        } catch (err) {
            const duration = (Date.now() - start) / 1000;
            dbQueryDuration
                .labels(operation, collection)
                .observe(duration);
            throw err;
        }
    },
    
    updateConnectionPool(activeConnections, availableConnections) {
        mongoConnectionGauge.set(activeConnections);
    }
};

// ============================================================================
// Health Check
// ============================================================================

function healthCheckMetrics() {
    return {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        pid: process.pid
    };
}

// ============================================================================
// Initialization
// ============================================================================

function init(app) {
    console.log('📊 Initializing Prometheus metrics...');
    
    // Add metrics middleware (should be added early)
    app.use(metricsMiddleware);
    
    // Expose metrics endpoint
    // register.metrics() returns a Promise in prom-client 15 — without the
    // await this endpoint served the literal text "[object Promise]".
    // Now that it returns real data it must not be public: it needs
    // METRICS_TOKEN as a bearer token (Prometheus `authorization` config), and
    // is a 404 when METRICS_TOKEN is unset. A loopback check would not work —
    // behind nginx every request arrives from 127.0.0.1.
    app.get('/metrics', async (req, res) => {
        const token = process.env.METRICS_TOKEN || '';
        const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        const expected = Buffer.from(token);
        const ok = token.length >= 16 && given.length === expected.length &&
            require('crypto').timingSafeEqual(given, expected);
        if (!ok) return res.status(404).send('Not Found');
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });
    
    // Health endpoint with metrics
    app.get('/health/metrics', (req, res) => {
        res.json(healthCheckMetrics());
    });
    
    console.log('✅ Prometheus metrics enabled at /metrics');
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    register,
    init,
    middleware: metricsMiddleware,
    errorMiddleware: errorTrackingMiddleware,
    counters: {
        httpRequest: httpRequestCounter,
        appError: appErrorCounter,
        rateLimit: rateLimitCounter
    },
    gauges: {
        mongoConnection: mongoConnectionGauge,
        activeRequests: activeRequestsGauge
    },
    histograms: {
        httpDuration: httpRequestDuration,
        dbQuery: dbQueryDuration
    },
    db: dbMetrics,
    cache: cacheMetrics,
    redis: redisMetrics,
    health: healthCheckMetrics,
    track: {
        rateLimit: trackRateLimit
    }
};

/**
 * Example Integration in AuthController:
 * 
 * const metricsManager = require('../utils/prometheusMetrics');
 * 
 * exports.login = async (req, res) => {
 *     try {
 *         const user = await metricsManager.db.trackQuery(
 *             'users',
 *             'findOne',
 *             () => User.findOne({ email: req.body.email })
 *         );
 *         // ... rest of logic
 *     } catch (err) {
 *         // Error tracking handled by middleware
 *         throw err;
 *     }
 * }
 * 
 * ============================================================================
 * Prometheus Scrape Configuration (prometheus.yml):
 * 
 * scrape_configs:
 *   - job_name: 'roomhy-backend'
 *     static_configs:
 *       - targets: ['localhost:5001']
 *     metrics_path: '/metrics'
 *     scrape_interval: 15s
 * 
 * ============================================================================
 * Grafana Dashboard Queries:
 * 
 * 1. Request Rate (req/sec):
 *    rate(http_requests_total[1m])
 * 
 * 2. Error Rate:
 *    rate(http_requests_total{status_code=~"5.."}[1m])
 * 
 * 3. P95 Latency:
 *    histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[1m]))
 * 
 * 4. Memory Usage:
 *    nodejs_memory_heap_used_bytes / 1024 / 1024  (in MB)
 * 
 * 5. MongoDB Connections:
 *    mongodb_connections_active
 * 
 * ============================================================================
 */
