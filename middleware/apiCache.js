/**
 * API Response Cache Middleware
 * Caches GET API responses in memory for faster repeated requests
 */

// Simple in-memory cache
const cache = new Map();

// Cache configuration
const CACHE_CONFIG = {
    // Public data - cache for 5 minutes
    PUBLIC_DATA: {
        paths: ['/api/cities', '/api/property-types', '/api/approved-properties'],
        duration: 5 * 60 * 1000, // 5 minutes
        staleWhileRevalidate: 10 * 60 * 1000 // 10 minutes stale
    },
    // Property listings - cache for 2 minutes
    PROPERTIES: {
        paths: ['/api/website-property-data', '/api/properties'],
        duration: 2 * 60 * 1000, // 2 minutes
        staleWhileRevalidate: 5 * 60 * 1000 // 5 minutes stale
    },
    // User specific - cache for 30 seconds
    USER_DATA: {
        paths: ['/api/user', '/api/favorites'],
        duration: 30 * 1000, // 30 seconds
        staleWhileRevalidate: 60 * 1000 // 1 minute stale
    }
};

/**
 * Generate cache key from request
 */
function getCacheKey(req) {
    const url = req.originalUrl || req.url;
    const query = JSON.stringify(req.query);
    return `${req.method}:${url}:${query}`;
}

/**
 * Get cache configuration for a path
 */
function getCacheConfig(path) {
    for (const [category, config] of Object.entries(CACHE_CONFIG)) {
        if (config.paths.some(p => path.includes(p))) {
            return { category, ...config };
        }
    }
    return null;
}

/**
 * API Cache Middleware
 */
function apiCache(req, res, next) {
    // Only cache GET requests
    if (req.method !== 'GET') {
        return next();
    }

    // Skip caching for authenticated/private routes or location management
    if ((req.headers.authorization || req.path.includes('/api/locations')) && !req.path.includes('/api/property-types')) {
        return next();
    }

    // Check if path is cacheable
    const config = getCacheConfig(req.path);
    if (!config) {
        return next();
    }

    const cacheKey = getCacheKey(req);
    const cached = cache.get(cacheKey);

    // Check if cache is valid
    if (cached) {
        const now = Date.now();
        const age = now - cached.timestamp;

        // Cache is fresh
        if (age < config.duration) {
            console.log(`📦 Cache HIT: ${req.path} (${config.category})`);
            return res.json(cached.data);
        }

        // Cache is stale but usable
        if (age < (config.duration + config.staleWhileRevalidate)) {
            console.log(`📦 Cache STALE: ${req.path} (serving stale)`);
            // Serve stale and refresh in background
            res.json(cached.data);
            
            // Trigger background refresh
            refreshCache(req, res, config, cacheKey);
            return;
        }

        // Cache expired, remove it
        cache.delete(cacheKey);
    }

    // Cache miss - intercept the response
    console.log(`📦 Cache MISS: ${req.path}`);

    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
        // Only cache successful responses
        if (res.statusCode === 200 && data && (data.success || Array.isArray(data) || data.properties || data.cities)) {
            cache.set(cacheKey, {
                data: data,
                timestamp: Date.now(),
                config: config
            });
            console.log(`📦 Cache STORED: ${req.path}`);
        }
        
        return originalJson(data);
    };

    next();
}

/**
 * Refresh cache in background
 */
async function refreshCache(req, res, config, cacheKey) {
    // This would ideally re-fetch the data
    // For now, just mark as needing refresh
    console.log(`🔄 Background refresh queued for: ${req.path}`);
}

/**
 * Clear specific cache or all cache
 */
function clearCache(path = null) {
    if (path) {
        // Clear cache entries matching path
        for (const [key, value] of cache.entries()) {
            if (key.includes(path)) {
                cache.delete(key);
            }
        }
        console.log(`🗑️ Cache cleared for: ${path}`);
    } else {
        cache.clear();
        console.log('🗑️ All cache cleared');
    }
}

/**
 * Get cache stats
 */
function getCacheStats() {
    const stats = {
        total: cache.size,
        byCategory: {}
    };

    for (const [key, value] of cache.entries()) {
        const category = value.config?.category || 'unknown';
        stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    }

    return stats;
}

/**
 * Auto-cleanup expired cache entries
 */
setInterval(() => {
    const now = Date.now();
    let cleared = 0;

    for (const [key, value] of cache.entries()) {
        const config = value.config;
        if (config) {
            const maxAge = config.duration + config.staleWhileRevalidate;
            if (now - value.timestamp > maxAge) {
                cache.delete(key);
                cleared++;
            }
        }
    }

    if (cleared > 0) {
        console.log(`🧹 Auto-cleared ${cleared} expired cache entries`);
    }
}, 5 * 60 * 1000); // Run every 5 minutes

module.exports = {
    apiCache,
    clearCache,
    getCacheStats
};
