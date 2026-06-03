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
    app.get('/metrics', (req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(register.metrics());
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
