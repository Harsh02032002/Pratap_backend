const SeoPage = require('../models/SeoPage');
const SeoRedirect = require('../models/SeoRedirect');

/**
 * Helper to replace placeholders like {city} or {area} in template text
 */
function renderTemplate(template, context = {}) {
    if (!template || typeof template !== 'string') return template || '';
    return template.replace(/\{(\w+)\}/g, (match, key) => {
        if (context[key] !== undefined && context[key] !== null) {
            // Humanize slug values if they come in as lowercase with dashes
            const value = context[key];
            if (typeof value === 'string' && value.includes('-')) {
                return value
                    .split('-')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');
            }
            return value;
        }
        return ''; // Remove unresolved placeholder
    }).replace(/\s+/g, ' ').trim(); // Normalize spaces
}

/**
 * Clean path/URL to have a standard format for matching (remove leading/trailing slashes, query params)
 */
function cleanPath(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return '';
    try {
        // Handle full URLs
        let path = urlStr;
        if (urlStr.startsWith('http')) {
            const urlObj = new URL(urlStr);
            path = urlObj.pathname;
        } else {
            // Remove query params
            path = urlStr.split('?')[0];
        }
        // Normalize slashes
        return path.replace(/^\/+|\/+$/g, '').toLowerCase().trim();
    } catch (e) {
        return urlStr.replace(/^\/+|\/+$/g, '').toLowerCase().trim();
    }
}

/**
 * GET RESOLVED SEO METADATA (Route-Independent)
 * Decoupled query supporting url, slug, pageKey, or entityType + entityId
 */
exports.getSeoMetadata = async (req, res) => {
    try {
        const { url, slug, pageKey, entityType, entityId, ...context } = req.query;

        // 1. Check for database-driven redirects (URL history or alias mapping)
        const targetUrl = url || slug || '';
        if (targetUrl) {
            const cleaned = cleanPath(targetUrl);
            const redirectMatch = await SeoRedirect.findOne({
                $or: [
                    { oldUrl: cleaned },
                    { oldUrl: '/' + cleaned },
                    { oldUrl: targetUrl }
                ]
            });

            if (redirectMatch) {
                return res.status(200).json({
                    success: true,
                    redirect: true,
                    newUrl: redirectMatch.newUrl,
                    statusCode: redirectMatch.statusCode || 301
                });
            }
        }

        let seoRecord = null;

        // Resolution Sequence:
        // A. Match by specific entityType + entityId if provided
        if (entityType && entityId) {
            seoRecord = await SeoPage.findOne({ entityType, entityId });
        }

        // B. Match by clean slug/url path if no record found yet
        if (!seoRecord && (slug || url)) {
            const cleanedSlug = cleanPath(slug || url);
            seoRecord = await SeoPage.findOne({ 
                $or: [
                    { slug: cleanedSlug },
                    { slug: '/' + cleanedSlug }
                ]
            });
        }

        // C. Match by pageKey (fallback template or static page key)
        if (!seoRecord && pageKey) {
            seoRecord = await SeoPage.findOne({ pageKey, entityId: null });
        }

        // If no explicit DB record was found, check if this is an SEO URL pattern: /{type}-in-{area}-{city}
        if (!seoRecord && (slug || url)) {
            const cleanedSlug = cleanPath(slug || url);
            const seoPatternMatch = cleanedSlug.match(/^(pg|hostels|hostel|co-living|coliving|apartments|apartment)-in-(.+)$/i);
            
            if (seoPatternMatch) {
                const rawType = seoPatternMatch[1].toLowerCase();
                const rawLocation = seoPatternMatch[2]; // e.g. "talwandi-kota", "mp-nagar-bhopal", "electronic-city-bangalore"
                
                let propertyType = 'PG';
                if (rawType.startsWith('hostel')) propertyType = 'Hostel';
                else if (rawType.includes('coliving') || rawType.includes('co-living')) propertyType = 'Co-living';
                else if (rawType.startsWith('apartment')) propertyType = 'Apartment';

                // Match against known cities list for accurate multi-word area resolution
                const knownCities = [
                    'bangalore', 'bengaluru', 'bhopal', 'indore', 'delhi', 'new-delhi',
                    'jaipur', 'kota', 'sikar', 'mumbai', 'pune', 'hyderabad', 'chennai',
                    'ahmedabad', 'lucknow', 'chandigarh', 'noida', 'gurugram'
                ];

                let city = context.city || '';
                let area = context.area || '';

                if (!city || !area) {
                    const matchedCityKey = knownCities.find(c => rawLocation.endsWith('-' + c) || rawLocation === c);
                    if (matchedCityKey) {
                        city = matchedCityKey.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        if (rawLocation !== matchedCityKey) {
                            const areaPart = rawLocation.slice(0, rawLocation.length - matchedCityKey.length - 1);
                            area = areaPart.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        }
                    } else {
                        const parts = rawLocation.split('-');
                        if (parts.length >= 2) {
                            city = parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1);
                            area = parts.slice(0, parts.length - 1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        } else if (parts.length === 1) {
                            city = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
                        }
                    }
                }

                const generatedH1 = `${propertyType} in ${area ? area + ', ' : ''}${city}`;
                const generatedTitle = `${propertyType} in ${area ? area + ' ' : ''}${city} | Roomhy`;
                const generatedDesc = `Find the best ${propertyType} in ${area ? area + ' ' : ''}${city} with furnished rooms, modern amenities, zero brokerage and verified options on Roomhy.`;

                return res.status(200).json({
                    success: true,
                    data: {
                        pageKey: `dynamic-${cleanedSlug}`,
                        pageName: generatedH1,
                        slug: cleanedSlug,
                        city,
                        area,
                        propertyType,
                        metaTitle: generatedTitle,
                        metaDescription: generatedDesc,
                        metaKeywords: `${propertyType} in ${area}, ${propertyType} in ${city}, student housing ${city}`,
                        h1: generatedH1,
                        canonicalUrl: `https://roomhy.com/${cleanedSlug}`,
                        robots: 'index, follow',
                        isIndexed: true
                    }
                });
            }

            // Check if this is a general city or area route (e.g. "kota", "jaipur/malviya-nagar")
            const parts = cleanedSlug.split('/');
            const knownCities = [
                'bangalore', 'bengaluru', 'bhopal', 'indore', 'delhi', 'new-delhi',
                'jaipur', 'kota', 'sikar', 'mumbai', 'pune', 'hyderabad', 'nagpur',
                'chennai', 'ahmedabad', 'lucknow', 'chandigarh', 'noida', 'gurugram'
            ];

            if (parts.length === 1 && knownCities.includes(parts[0].toLowerCase())) {
                const city = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
                const title = `Rental Properties in ${city} | Roomhy`;
                const desc = `Browse all verified PGs, Hostels, Co-living spaces, and Apartments for rent in ${city} with zero brokerage on Roomhy.`;
                const h1 = `Properties in ${city}`;

                return res.status(200).json({
                    success: true,
                    data: {
                        pageKey: `city-general-${parts[0]}`,
                        pageName: h1,
                        slug: cleanedSlug,
                        city,
                        area: '',
                        propertyType: 'All',
                        metaTitle: title,
                        metaDescription: desc,
                        metaKeywords: `properties in ${city}, pg in ${city}, hostels in ${city}, flats for rent in ${city}`,
                        h1,
                        canonicalUrl: `https://roomhy.com/${cleanedSlug}`,
                        robots: 'index, follow',
                        isIndexed: true
                    }
                });
            }

            if (parts.length === 2 && knownCities.includes(parts[0].toLowerCase())) {
                const city = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
                const area = parts[1].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                const title = `Rental Properties in ${area}, ${city} | Roomhy`;
                const desc = `Browse all verified PGs, Hostels, Co-living spaces, and Apartments for rent in ${area}, ${city} with zero brokerage on Roomhy.`;
                const h1 = `Properties in ${area}, ${city}`;

                return res.status(200).json({
                    success: true,
                    data: {
                        pageKey: `area-general-${parts[0]}-${parts[1]}`,
                        pageName: h1,
                        slug: cleanedSlug,
                        city,
                        area,
                        propertyType: 'All',
                        metaTitle: title,
                        metaDescription: desc,
                        metaKeywords: `properties in ${area} ${city}, pg in ${area}, hostels in ${area} ${city}`,
                        h1,
                        canonicalUrl: `https://roomhy.com/${cleanedSlug}`,
                        robots: 'index, follow',
                        isIndexed: true
                    }
                });
            }

            return res.status(200).json({
                success: true,
                data: {
                    metaTitle: '',
                    metaDescription: '',
                    metaKeywords: '',
                    canonicalUrl: `https://roomhy.com/${cleanedSlug}`,
                    robots: 'index, follow',
                    isIndexed: true
                }
            });
        }

        // D. Perform dynamic placeholder rendering (template variables)
        if (!seoRecord) {
            return res.status(200).json({
                success: true,
                data: {
                    metaTitle: 'Roomhy - Premium Broker-Free Student & Professional Living',
                    metaDescription: 'Find and book verified broker-free PGs, Hostels, and Co-living spaces across top cities in India.',
                    canonicalUrl: `https://roomhy.com/${cleanedSlug}`,
                    robots: 'index, follow',
                    isIndexed: true
                }
            });
        }
        const seoObj = typeof seoRecord.toObject === 'function' ? seoRecord.toObject() : (seoRecord || {});
        const renderFields = [
            'metaTitle', 'metaDescription', 'metaKeywords', 'h1', 'seoContent',
            'openGraphTitle', 'openGraphDescription', 'twitterTitle', 'twitterDescription'
        ];

        renderFields.forEach(field => {
            if (seoObj[field]) {
                seoObj[field] = renderTemplate(seoObj[field], context);
            }
        });

        // E. Generate automatic Canonical URL if not explicitly defined
        if (!seoObj.canonicalUrl) {
            const pathForCanonical = cleanPath(url || slug || seoObj.slug || pageKey || '');
            seoObj.canonicalUrl = `https://roomhy.com/${pathForCanonical}`.replace(/\/+$/, '');
        }

        return res.status(200).json({
            success: true,
            data: seoObj
        });
    } catch (error) {
        console.error('Error in getSeoMetadata:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while resolving SEO',
            error: error.message
        });
    }
};

/**
 * GENERATE DYNAMIC XML SITEMAP
 */
exports.generateSitemapXml = async (req, res) => {
    try {
        const pages = await SeoPage.find({ isIndexed: { $ne: false } }).lean();

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

        const defaultUrls = [
            { loc: 'https://roomhy.com/', priority: '1.0', changefreq: 'daily' },
            { loc: 'https://roomhy.com/properties', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/pg', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/hostels', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/co-living', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/apartments', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/about-us', priority: '0.7', changefreq: 'monthly' },
            { loc: 'https://roomhy.com/contact-us', priority: '0.7', changefreq: 'monthly' },
            { loc: 'https://roomhy.com/list-property', priority: '0.8', changefreq: 'weekly' },
            { loc: 'https://roomhy.com/faq', priority: '0.6', changefreq: 'monthly' },
            { loc: 'https://roomhy.com/pg-in-kota', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/pg-in-jaipur', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/pg-in-delhi', priority: '0.9', changefreq: 'daily' },
            { loc: 'https://roomhy.com/pg-in-indore', priority: '0.8', changefreq: 'daily' },
            { loc: 'https://roomhy.com/pg-in-talwandi-kota', priority: '0.85', changefreq: 'weekly' },
            { loc: 'https://roomhy.com/pg-in-vigyan-nagar-kota', priority: '0.85', changefreq: 'weekly' },
            { loc: 'https://roomhy.com/pg-in-landmark-city-kota', priority: '0.85', changefreq: 'weekly' }
        ];

        const addedUrls = new Set();
        defaultUrls.forEach(item => {
            addedUrls.add(item.loc);
            xml += `  <url>\n    <loc>${item.loc}</loc>\n    <changefreq>${item.changefreq}</changefreq>\n    <priority>${item.priority}</priority>\n  </url>\n`;
        });

        pages.forEach(p => {
            if (p.robots && p.robots.toLowerCase().includes('noindex')) return;

            const path = (p.slug || '').replace(/^\/+/, '');
            const url = p.canonicalUrl || `https://roomhy.com/${path}`;

            if (url && !addedUrls.has(url)) {
                addedUrls.add(url);
                xml += `  <url>\n    <loc>${url}</loc>\n    <changefreq>${p.sitemapChangefreq || 'weekly'}</changefreq>\n    <priority>${p.sitemapPriority || 0.8}</priority>\n  </url>\n`;
            }
        });

        xml += `</urlset>`;

        res.header('Content-Type', 'application/xml');
        return res.status(200).send(xml);
    } catch (err) {
        console.error('Error generating XML sitemap:', err);
        return res.status(500).send('Error generating sitemap');
    }
};

const defaultSeoPages = [
  { pageKey: 'home', pageName: 'Home Page', slug: '', metaTitle: 'Roomhy - Premium Broker-Free Student & Professional Living', metaDescription: 'Find and book premium broker-free PGs, Hostels, and Co-living spaces across major cities in India. Zero brokerage, live bidding.', metaKeywords: 'pg, hostels, co-living, roomhy, student housing, broker free pg, hostel booking', robots: 'index, follow', isIndexed: true },
  { pageKey: 'about', pageName: 'About Us', slug: 'about-us', metaTitle: 'About Roomhy - Our Story & Mission', metaDescription: 'Roomhy is India\'s first student-centric property bidding platform. Broker-free, verified listings with live bidding for students.', metaKeywords: 'about roomhy, student housing company, roomhy story, property bidding india', robots: 'index, follow', isIndexed: true },
  { pageKey: 'contact', pageName: 'Contact Us', slug: 'contact-us', metaTitle: 'Contact Roomhy - Get in Touch', metaDescription: 'Get in touch with the Roomhy team for support, booking help, property listing, or any inquiries. We respond in 24 hours.', metaKeywords: 'contact roomhy, roomhy support, roomhy email, roomhy phone', robots: 'index, follow', isIndexed: true },
  { pageKey: 'list-property', pageName: 'List Your Property', slug: 'list-property', metaTitle: 'List Your Property on Roomhy - Zero Commission', metaDescription: 'List your PG, hostel, or co-living space on Roomhy for free. Get direct verified student inquiries with zero commission charged.', metaKeywords: 'list pg, list hostel, property owner roomhy, zero commission, add listing roomhy', robots: 'index, follow', isIndexed: true },
  { pageKey: 'faq', pageName: 'How Roomhy Works', slug: 'faq', metaTitle: 'How Roomhy Works - FAQ & Guide', metaDescription: 'Learn how to find, bid, and book verified student accommodations on Roomhy in just a few easy steps. Zero brokerage guaranteed.', metaKeywords: 'how roomhy works, roomhy faq, student booking guide, how to bid, roomhy help', robots: 'index, follow', isIndexed: true },
  { pageKey: 'privacy', pageName: 'Privacy Policy', slug: 'privacy-policy', metaTitle: 'Privacy Policy - Roomhy', metaDescription: 'Read Roomhy\'s privacy policy to understand how we collect, store, and protect your personal data and booking information.', metaKeywords: 'roomhy privacy policy, data protection, user data roomhy', robots: 'index, follow', isIndexed: true },
  { pageKey: 'terms', pageName: 'Terms & Conditions', slug: 'terms-and-conditions', metaTitle: 'Terms & Conditions - Roomhy Platform', metaDescription: 'Read the terms and conditions governing the use of Roomhy\'s booking, bidding, and listing services on our platform.', metaKeywords: 'roomhy terms, terms and conditions roomhy, user agreement', robots: 'index, follow', isIndexed: true },
  { pageKey: 'login', pageName: 'Login - Sign In', slug: 'login', metaTitle: 'Sign In to Roomhy - Student & Owner Portal', metaDescription: 'Log in to your Roomhy account to bid on PGs, manage your bookings, chat with property owners, and more.', metaKeywords: 'roomhy login, sign in roomhy, student login, owner login', robots: 'noindex, nofollow', isIndexed: false },
  { pageKey: 'register', pageName: 'Register - Sign Up', slug: 'register', metaTitle: 'Create Your Roomhy Account - Sign Up Free', metaDescription: 'Register on Roomhy for free to start bidding on verified PGs and hostels. Quick signup, no credit card required.', metaKeywords: 'roomhy signup, create account roomhy, student register, pg booking account', robots: 'noindex, nofollow', isIndexed: false },
  { pageKey: 'our-property', pageName: 'Browse Properties', slug: 'properties', metaTitle: 'Browse PGs, Hostels & Co-living Spaces - Roomhy', metaDescription: 'Explore hundreds of verified PGs, hostels, and co-living spaces across major Indian cities. Filter by city, type, and price.', metaKeywords: 'pg listing, hostel listing, co-living india, student accommodation, book pg online', robots: 'index, follow', isIndexed: true },
  { pageKey: 'property-details', pageName: 'Property Details', slug: 'property-details', metaTitle: '{propertyName} - Roomhy', metaDescription: 'View details, images, amenities, pricing, and availability for {propertyName} on Roomhy. Bid now, zero brokerage.', metaKeywords: 'pg details, hostel rooms, co-living rooms, roomhy property, book room', robots: 'index, follow', isIndexed: true }
];

const websitePageKeys = ['home', 'about', 'contact', 'list-property', 'faq', 'privacy', 'terms', 'login', 'register', 'our-property', 'property-details'];

/**
 * LIST ALL REGISTERED SEO PAGES - All pages including dynamic/custom pages
 */
exports.getPages = async (req, res) => {
    try {
        // Return ALL pages from database, including dynamic pages created by admin
        let pages = await SeoPage.find({}).sort({ createdAt: 1 }).lean();
        
        // Seed default pages if missing
        const existingKeys = pages.map(p => p.pageKey);
        const missingPages = defaultSeoPages.filter(p => !existingKeys.includes(p.pageKey));
        
        if (missingPages.length > 0) {
            await SeoPage.insertMany(missingPages);
            pages = await SeoPage.find({}).sort({ createdAt: 1 });
        }
        
        return res.status(200).json({
            success: true,
            data: pages
        });
    } catch (error) {
        console.error('Error fetching registered SEO pages:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * REGISTER OR UPSERT A PAGE DEFINITION
 */
exports.registerPage = async (req, res) => {
    try {
        const { pageKey, pageName, slug, entityType, entityId, ...rest } = req.body;

        if (!pageName) {
            return res.status(400).json({
                success: false,
                message: 'pageName is required'
            });
        }

        // Clean slug if provided
        const cleanedSlug = slug ? cleanPath(slug) : undefined;

        // Upsert by compound index `{ pageKey, entityId }`
        const query = {};
        if (pageKey) {
            query.pageKey = pageKey;
            query.entityId = entityId || null;
        } else if (cleanedSlug) {
            query.slug = cleanedSlug;
        } else {
            return res.status(400).json({
                success: false,
                message: 'Either pageKey or slug must be provided'
            });
        }

        const updatedPage = await SeoPage.findOneAndUpdate(
            query,
            {
                $set: {
                    pageKey,
                    pageName,
                    slug: cleanedSlug,
                    entityType: entityType || null,
                    entityId: entityId || null,
                    ...rest
                }
            },
            {
                new: true,
                upsert: true,
                runValidators: true
            }
        );

        return res.status(201).json({
            success: true,
            message: 'Page SEO registered successfully',
            data: updatedPage
        });
    } catch (error) {
        console.error('Error registering/upserting page:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * UPDATE PAGE SEO BY PAGEKEY
 */
exports.updatePageByKey = async (req, res) => {
    try {
        const { pageKey } = req.params;
        const updateData = req.body;

        const updatedPage = await SeoPage.findOneAndUpdate(
            { pageKey, entityId: null },
            { $set: updateData },
            { new: true, runValidators: true }
        );

        if (!updatedPage) {
            return res.status(404).json({
                success: false,
                message: `SEO settings not found for pageKey: ${pageKey}`
            });
        }

        return res.status(200).json({
            success: true,
            message: 'SEO settings updated successfully',
            data: updatedPage
        });
    } catch (error) {
        console.error('Error updating SEO page by key:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * DELETE/UNREGISTER A PAGE BY PAGEKEY
 */
exports.deletePageByKey = async (req, res) => {
    try {
        const { pageKey } = req.params;

        const deleted = await SeoPage.findOneAndDelete({ pageKey, entityId: null });

        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: `SEO settings not found for pageKey: ${pageKey}`
            });
        }

        return res.status(200).json({
            success: true,
            message: 'SEO settings deleted/unregistered successfully',
            data: deleted
        });
    } catch (error) {
        console.error('Error deleting SEO page:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * CREATE A REDIRECT RULE (Redirect Manager)
 */
exports.createRedirect = async (req, res) => {
    try {
        const { oldUrl, newUrl, statusCode } = req.body;

        if (!oldUrl || !newUrl) {
            return res.status(400).json({
                success: false,
                message: 'oldUrl and newUrl are required'
            });
        }

        const cleanedOldUrl = cleanPath(oldUrl);

        const redirect = await SeoRedirect.findOneAndUpdate(
            { oldUrl: cleanedOldUrl },
            {
                $set: {
                    oldUrl: cleanedOldUrl,
                    newUrl,
                    statusCode: statusCode || 301
                }
            },
            {
                new: true,
                upsert: true,
                runValidators: true
            }
        );

        return res.status(201).json({
            success: true,
            message: 'Redirect created successfully',
            data: redirect
        });
    } catch (error) {
        console.error('Error creating redirect rule:', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
