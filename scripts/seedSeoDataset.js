const dns = require('dns');
if (!dns.getServers().includes('8.8.8.8')) {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
}

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const SeoPage = require('../models/SeoPage');
const SeoRedirect = require('../models/SeoRedirect');

// Load exact metadata extracted from Roomhy_Website_Work.xlsx sheet
let sheetMetadataMap = new Map();
const sheetJsonPath = path.join(__dirname, 'seoSheetData.json');

if (fs.existsSync(sheetJsonPath)) {
    try {
        const rawSheetData = JSON.parse(fs.readFileSync(sheetJsonPath, 'utf8'));
        rawSheetData.forEach(item => {
            if (item.slug !== undefined) {
                sheetMetadataMap.set(item.slug.toLowerCase().trim(), item);
            }
        });
        console.log(`📋 Loaded ${sheetMetadataMap.size} exact SEO metadata records from Roomhy_Website_Work.xlsx`);
    } catch (e) {
        console.warn('⚠️ Could not load seoSheetData.json:', e.message);
    }
}

// Location dataset of 52 areas across 10 target cities
const locationDataset = [
    // Kota (7 areas)
    { city: 'Kota', area: 'Talwandi' },
    { city: 'Kota', area: 'Vigyan Nagar' },
    { city: 'Kota', area: 'Mahaveer Nagar' },
    { city: 'Kota', area: 'Rajeev Gandhi Nagar' },
    { city: 'Kota', area: 'Kunhari' },
    { city: 'Kota', area: 'Indra Vihar' },
    { city: 'Kota', area: 'Landmark City' },

    // Jaipur (5 areas)
    { city: 'Jaipur', area: 'Malviya Nagar' },
    { city: 'Jaipur', area: 'Mansarovar' },
    { city: 'Jaipur', area: 'Vaishali Nagar' },
    { city: 'Jaipur', area: 'C-Scheme' },
    { city: 'Jaipur', area: 'Jagatpura' },

    // Delhi (7 areas)
    { city: 'Delhi', area: 'Karol Bagh' },
    { city: 'Delhi', area: 'Laxmi Nagar' },
    { city: 'Delhi', area: 'Mukherjee Nagar' },
    { city: 'Delhi', area: 'Kamla Nagar' },
    { city: 'Delhi', area: 'GTB Nagar' },
    { city: 'Delhi', area: 'South Extension' },
    { city: 'Delhi', area: 'Dwarka' },

    // Indore (5 areas)
    { city: 'Indore', area: 'Vijay Nagar' },
    { city: 'Indore', area: 'Palasia' },
    { city: 'Indore', area: 'Bhawarkuan' },
    { city: 'Indore', area: 'Rau' },
    { city: 'Indore', area: 'Rajendra Nagar' },

    // Bhopal (5 areas)
    { city: 'Bhopal', area: 'MP Nagar' },
    { city: 'Bhopal', area: 'Arera Colony' },
    { city: 'Bhopal', area: 'New Market' },
    { city: 'Bhopal', area: 'Kolar Road' },
    { city: 'Bhopal', area: 'Habibganj' },

    // Nagpur (5 areas)
    { city: 'Nagpur', area: 'Civil Lines' },
    { city: 'Nagpur', area: 'Dharampeth' },
    { city: 'Nagpur', area: 'Sadar' },
    { city: 'Nagpur', area: 'Ramdaspeth' },
    { city: 'Nagpur', area: 'Sitabuldi' },

    // Sikar (3 areas)
    { city: 'Sikar', area: 'Piprali Road' },
    { city: 'Sikar', area: 'Subhash Chowk' },
    { city: 'Sikar', area: 'Station Road' },

    // Bangalore (5 areas)
    { city: 'Bangalore', area: 'BTM Layout' },
    { city: 'Bangalore', area: 'Electronic City' },
    { city: 'Bangalore', area: 'HSR Layout' },
    { city: 'Bangalore', area: 'Koramangala' },
    { city: 'Bangalore', area: 'Indiranagar' },

    // Pune (5 areas)
    { city: 'Pune', area: 'Viman Nagar' },
    { city: 'Pune', area: 'Kothrud' },
    { city: 'Pune', area: 'Hinjewadi' },
    { city: 'Pune', area: 'Baner' },
    { city: 'Pune', area: 'Wakad' },

    // Hyderabad (5 areas)
    { city: 'Hyderabad', area: 'Gachibowli' },
    { city: 'Hyderabad', area: 'HITECH City' },
    { city: 'Hyderabad', area: 'Madhapur' },
    { city: 'Hyderabad', area: 'Ameerpet' },
    { city: 'Hyderabad', area: 'Kukatpally' }
];

const targetCities = [
    'Kota', 'Jaipur', 'Delhi', 'Indore', 'Bhopal',
    'Nagpur', 'Sikar', 'Bangalore', 'Pune', 'Hyderabad'
];

const propertyTypes = [
    { key: 'pg', typeName: 'PG', pluralName: 'PGs' },
    { key: 'hostels', typeName: 'Hostel', pluralName: 'Hostels' },
    { key: 'co-living', typeName: 'Co-living', pluralName: 'Co-living Spaces' },
    { key: 'apartments', typeName: 'Apartment', pluralName: 'Apartments' }
];

const staticPagesDataset = [
    { slug: '', pageKey: 'home', pageName: 'Home', title: 'Roomhy - Broker-Free PGs, Hostels & Apartments', desc: 'Find verified PGs, Hostels & Co-living spaces directly from owners with zero brokerage on Roomhy.', h1: 'Find Your Next Stay Without Brokerage', isIndexed: true, robots: 'index, follow' },
    { slug: 'about-us', pageKey: 'about', pageName: 'About Us', title: 'About Us | Roomhy', desc: 'Learn more about Roomhy, our mission to simplify student & professional living without brokers.', h1: 'About Roomhy', isIndexed: true, robots: 'index, follow' },
    { slug: 'contact-us', pageKey: 'contact', pageName: 'Contact Us', title: 'Contact Us | Roomhy', desc: 'Get in touch with the Roomhy team for help, support, or partnership inquiries.', h1: 'Contact Us', isIndexed: true, robots: 'index, follow' },
    { slug: 'list-property', pageKey: 'list-property', pageName: 'List Your Property', title: 'List Your Property | Roomhy', desc: 'Property owners can list PGs, Hostels & Apartments for free on Roomhy and get verified tenants.', h1: 'List Your Property Free', isIndexed: true, robots: 'index, follow' },
    { slug: 'blogs', pageKey: 'blogs', pageName: 'Blogs', title: 'Blogs & Guides | Roomhy', desc: 'Read helpful guides, student living tips, and neighborhood insights on the Roomhy blog.', h1: 'Blogs & Articles', isIndexed: true, robots: 'index, follow' },
    { slug: 'careers', pageKey: 'careers', pageName: 'Careers', title: 'Careers | Roomhy', desc: 'Join the Roomhy team and help reshape accommodation search across India.', h1: 'Careers at Roomhy', isIndexed: true, robots: 'index, follow' },
    { slug: 'faq', pageKey: 'faq', pageName: 'FAQ', title: 'Frequently Asked Questions | Roomhy', desc: 'Find answers to common questions about booking, safety, payments, and property listing on Roomhy.', h1: 'Frequently Asked Questions', isIndexed: true, robots: 'index, follow' },
    { slug: 'privacy-policy', pageKey: 'privacy', pageName: 'Privacy Policy', title: 'Privacy Policy | Roomhy', desc: 'Read Roomhy privacy policy regarding data collection and security.', h1: 'Privacy Policy', isIndexed: true, robots: 'index, follow' },
    { slug: 'terms-and-conditions', pageKey: 'terms', pageName: 'Terms & Conditions', title: 'Terms & Conditions | Roomhy', desc: 'Terms and conditions governing the use of Roomhy web platform and services.', h1: 'Terms & Conditions', isIndexed: true, robots: 'index, follow' },
    { slug: 'login', pageKey: 'login', pageName: 'Login', title: 'Login | Roomhy', desc: 'Log in to your Roomhy account.', h1: 'Log In to Roomhy', isIndexed: false, robots: 'noindex, nofollow' },
    { slug: 'register', pageKey: 'register', pageName: 'Register', title: 'Register | Roomhy', desc: 'Create a new Roomhy user or tenant account.', h1: 'Create Your Account', isIndexed: false, robots: 'noindex, nofollow' },
    { slug: 'owner-dashboard', pageKey: 'owner-dashboard', pageName: 'Owner Dashboard', title: 'Owner Dashboard | Roomhy', desc: 'Manage your listed properties and tenant requests.', h1: 'Owner Dashboard', isIndexed: false, robots: 'noindex, nofollow' },
    { slug: 'tenant-dashboard', pageKey: 'tenant-dashboard', pageName: 'Tenant Dashboard', title: 'Tenant Dashboard | Roomhy', desc: 'View your active stays, rent payments, and support requests.', h1: 'Tenant Dashboard', isIndexed: false, robots: 'noindex, nofollow' },
    
    // Top-Level Property Category Pages
    { slug: 'pg', pageKey: 'cat-pg', pageName: 'Browse PGs', title: 'Best PGs in India - Verified & Broker-Free | Roomhy', desc: 'Explore top rated Paying Guest accommodations with modern amenities, food, and zero brokerage.', h1: 'Paying Guest (PG) Accommodation', propertyType: 'PG', isIndexed: true, robots: 'index, follow' },
    { slug: 'hostels', pageKey: 'cat-hostels', pageName: 'Browse Hostels', title: 'Best Student Hostels in India | Roomhy', desc: 'Find comfortable student hostels near top colleges and coaching institutes with zero brokerage.', h1: 'Student Hostels', propertyType: 'Hostel', isIndexed: true, robots: 'index, follow' },
    { slug: 'co-living', pageKey: 'cat-co-living', pageName: 'Browse Co-living', title: 'Modern Co-living Spaces in India | Roomhy', desc: 'Discover premium co-living spaces with community living, WiFi, housekeeping, and flexible stays.', h1: 'Co-living Spaces', propertyType: 'Co-living', isIndexed: true, robots: 'index, follow' },
    { slug: 'apartments', pageKey: 'cat-apartments', pageName: 'Browse Apartments', title: 'Flats & Apartments for Rent in India | Roomhy', desc: 'Find furnished & semi-furnished 1BHK, 2BHK, 3BHK flats and apartments for rent without brokers.', h1: 'Flats & Apartments for Rent', propertyType: 'Apartment', isIndexed: true, robots: 'index, follow' },
    { slug: 'properties', pageKey: 'cat-properties', pageName: 'Browse All Properties', title: 'Browse Rental Properties | Roomhy', desc: 'Search all verified PGs, Hostels, Co-living spaces, and Apartments across top Indian cities.', h1: 'All Rental Properties', propertyType: 'All', isIndexed: true, robots: 'index, follow' }
];

function slugify(text) {
    if (!text) return '';
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-');
}

async function seedSeoData() {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/roomhy';
    console.log(`🔗 Connecting to MongoDB: ${mongoUri.substring(0, 50)}...`);

    try {
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 15000,
            family: 4
        });
        console.log('✅ Connected to Database');

        let pagesCount = 0;
        let redirectsCount = 0;

        // A. Seed Static & Category Pages (18 URLs)
        console.log('🌱 Seeding Static & Category SEO Pages...');
        for (const item of staticPagesDataset) {
            const sheetMeta = sheetMetadataMap.get(item.slug.toLowerCase());
            
            const metaTitle = sheetMeta?.metaTitle || item.title;
            const metaDescription = sheetMeta?.metaDescription || item.desc;
            const h1 = sheetMeta?.h1 || item.h1;
            const primaryKeyword = sheetMeta?.primaryKeyword || item.pageName;
            const secondaryKeywords = sheetMeta?.secondaryKeywords || [];
            const metaKeywords = sheetMeta?.metaKeywords || `${item.pageName}, roomhy, student housing`;

            await SeoPage.findOneAndUpdate(
                { slug: item.slug },
                {
                    $set: {
                        pageKey: item.pageKey,
                        pageName: item.pageName,
                        slug: item.slug,
                        city: item.city || '',
                        area: item.area || '',
                        propertyType: item.propertyType || '',
                        metaTitle,
                        metaDescription,
                        metaKeywords,
                        primaryKeyword,
                        secondaryKeywords,
                        h1,
                        canonicalUrl: `https://roomhy.com/${item.slug}`.replace(/\/+$/, ''),
                        robots: item.robots,
                        isIndexed: item.isIndexed,
                        sitemapPriority: item.isIndexed ? 0.9 : 0.1,
                        sitemapChangefreq: 'weekly'
                    }
                },
                { upsert: true, new: true }
            );
            pagesCount++;
        }

        // B. Seed City-Level Landing Pages (40 URLs: 10 Cities x 4 Property Types)
        console.log('🌱 Seeding City-Level SEO Pages...');
        for (const city of targetCities) {
            const citySlug = slugify(city);
            for (const pt of propertyTypes) {
                const cityPageSlug = `${pt.key}/${citySlug}`;
                const sheetMeta = sheetMetadataMap.get(cityPageSlug.toLowerCase());

                const metaTitle = sheetMeta?.metaTitle || `Best ${pt.pluralName} in ${city} - Verified & Broker Free | Roomhy`;
                const metaDescription = sheetMeta?.metaDescription || `Find top rated ${pt.pluralName} in ${city} with furnished rooms, food, WiFi, zero brokerage and verified options on Roomhy.`;
                const h1 = sheetMeta?.h1 || `${pt.pluralName} in ${city}`;
                const primaryKeyword = sheetMeta?.primaryKeyword || `${pt.typeName} in ${city}`;
                const secondaryKeywords = sheetMeta?.secondaryKeywords || [`${pt.pluralName} in ${city}`, `hostels in ${city}`];
                const metaKeywords = sheetMeta?.metaKeywords || `${pt.typeName} in ${city}, ${pt.pluralName} in ${city}, student hostel ${city}`;

                await SeoPage.findOneAndUpdate(
                    { slug: cityPageSlug },
                    {
                        $set: {
                            pageKey: `city-${pt.key}-${citySlug}`,
                            pageName: `${pt.typeName} in ${city}`,
                            slug: cityPageSlug,
                            city: city,
                            area: '',
                            propertyType: pt.typeName,
                            metaTitle,
                            metaDescription,
                            metaKeywords,
                            primaryKeyword,
                            secondaryKeywords,
                            h1,
                            canonicalUrl: `https://roomhy.com/${cityPageSlug}`,
                            robots: 'index, follow',
                            isIndexed: true,
                            sitemapPriority: 0.85,
                            sitemapChangefreq: 'weekly'
                        }
                    },
                    { upsert: true, new: true }
                );
                pagesCount++;
            }
        }

        // C. Seed SEO Area Landing Pages (208 URLs: 52 Areas x 4 Property Types)
        console.log('🌱 Seeding SEO Area Landing Pages & 301 Redirect Rules...');
        for (const loc of locationDataset) {
            const citySlug = slugify(loc.city);
            const areaSlug = slugify(loc.area);

            for (const pt of propertyTypes) {
                const seoSlug = `${pt.key}-in-${areaSlug}-${citySlug}`;
                const pageKey = `${pt.key}-${areaSlug}-${citySlug}`;
                const sheetMeta = sheetMetadataMap.get(seoSlug.toLowerCase());

                const metaTitle = sheetMeta?.metaTitle || `${pt.typeName} in ${loc.area} ${loc.city} | Roomhy`;
                const metaDescription = sheetMeta?.metaDescription || `Find the best ${pt.typeName} in ${loc.area} ${loc.city} with furnished rooms, modern amenities, zero brokerage and verified options on Roomhy.`;
                const h1 = sheetMeta?.h1 || `${pt.typeName} in ${loc.area}, ${loc.city}`;
                const primaryKeyword = sheetMeta?.primaryKeyword || `${pt.typeName} in ${loc.area} ${loc.city}`;
                const secondaryKeywords = sheetMeta?.secondaryKeywords || [`${pt.typeName} in ${loc.area}`, `${pt.pluralName} in ${loc.city}`];
                const metaKeywords = sheetMeta?.metaKeywords || `${pt.typeName} in ${loc.area}, ${pt.pluralName} in ${loc.city}, broker free pg ${loc.city}`;
                const canonical = `https://roomhy.com/${seoSlug}`;

                // 1. Seed SeoPage (Idempotent upsert by unique slug)
                await SeoPage.findOneAndUpdate(
                    { slug: seoSlug },
                    {
                        $set: {
                            pageKey,
                            pageName: `${pt.typeName} in ${loc.area}, ${loc.city}`,
                            slug: seoSlug,
                            city: loc.city,
                            area: loc.area,
                            propertyType: pt.typeName,
                            metaTitle,
                            metaDescription,
                            metaKeywords,
                            primaryKeyword,
                            secondaryKeywords,
                            h1,
                            canonicalUrl: canonical,
                            robots: 'index, follow',
                            isIndexed: true,
                            sitemapPriority: 0.8,
                            sitemapChangefreq: 'weekly'
                        }
                    },
                    { upsert: true, new: true }
                );
                pagesCount++;

                // 2. Seed SeoRedirect for legacy path patterns (Idempotent upsert by unique oldUrl)
                const legacyPaths = [
                    `/${pt.key}/${citySlug}/${areaSlug}`,
                    `/${pt.key}/${areaSlug}/${citySlug}`,
                    `${pt.key}/${citySlug}/${areaSlug}`,
                    `${pt.key}/${areaSlug}/${citySlug}`
                ];

                for (const oldPath of legacyPaths) {
                    const cleanOld = oldPath.replace(/^\/+|\/+$/g, '').toLowerCase();
                    await SeoRedirect.findOneAndUpdate(
                        { oldUrl: cleanOld },
                        { $set: { oldUrl: cleanOld, newUrl: `/${seoSlug}`, statusCode: 301 } },
                        { upsert: true }
                    );
                    redirectsCount++;
                }
            }
        }

        // D. Perform Audit of Metadata Completeness across all 266 documents
        const allPages = await SeoPage.find({});
        let h1Present = 0;
        let titlePresent = 0;
        let descPresent = 0;
        let primaryKwPresent = 0;
        let secKwPresent = 0;
        let canonicalPresent = 0;
        let robotsPresent = 0;
        let missingCount = 0;

        allPages.forEach(p => {
            let complete = true;
            if (p.h1) h1Present++; else complete = false;
            if (p.metaTitle) titlePresent++; else complete = false;
            if (p.metaDescription) descPresent++; else complete = false;
            if (p.primaryKeyword) primaryKwPresent++;
            if (p.secondaryKeywords && p.secondaryKeywords.length > 0) secKwPresent++;
            if (p.canonicalUrl) canonicalPresent++; else complete = false;
            if (p.robots) robotsPresent++; else complete = false;
            if (!complete) missingCount++;
        });

        const finalPages = await SeoPage.countDocuments();
        const finalRedirects = await SeoRedirect.countDocuments();
        const indexablePages = await SeoPage.countDocuments({ isIndexed: true, robots: /index/i });

        console.log(`\n======================================================`);
        console.log(`✅ SEO Seeding Finished Successfully!`);
        console.log(`   - Total SeoPage documents in DB: ${finalPages}`);
        console.log(`   - Total SeoRedirect documents in DB: ${finalRedirects}`);
        console.log(`   - Indexable URLs ready for Sitemap: ${indexablePages}`);
        console.log(`\n📊 METADATA AUDIT REPORT (${finalPages} Total SeoPages):`);
        console.log(`   - H1 Present: ${h1Present} / ${finalPages}`);
        console.log(`   - Meta Title Present: ${titlePresent} / ${finalPages}`);
        console.log(`   - Meta Description Present: ${descPresent} / ${finalPages}`);
        console.log(`   - Primary Keyword Present: ${primaryKwPresent} / ${finalPages}`);
        console.log(`   - Secondary Keywords Present: ${secKwPresent} / ${finalPages}`);
        console.log(`   - Canonical URL Present: ${canonicalPresent} / ${finalPages}`);
        console.log(`   - Robots Present: ${robotsPresent} / ${finalPages}`);
        console.log(`   - Missing Core Metadata Documents: ${missingCount}`);
        console.log(`======================================================\n`);

        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB');
    } catch (err) {
        console.error('❌ Error during SEO seeding:', err);
        process.exit(1);
    }
}

seedSeoData();
