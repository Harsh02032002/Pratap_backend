const dns = require('dns');
if (!dns.getServers().includes('8.8.8.8')) {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
}

require('dotenv').config();
const mongoose = require('mongoose');
const SeoPage = require('../models/SeoPage');

// =============================================================================
//  CONFIGURATION — Edit only this section to add new cities or areas
// =============================================================================

/**
 * CITIES CONFIG
 * Add a new city here and PG + Hostel + Co-living pages will be auto-generated.
 *
 * Fields:
 *  - name      : Display name (e.g. "Kota")
 *  - slug      : URL slug  (e.g. "kota")
 *  - pgKw      : Extra city-specific keywords for PG page (comma-separated string)
 *  - hostelKw  : Extra city-specific keywords for Hostel page
 *  - colivingKw: Extra city-specific keywords for Co-living page
 *  - propKw    : Keywords for the "Properties in <City>" aggregator page
 */
const CITIES = [
  {
    name: 'Kota',
    slug: 'kota',
    pgKw:       'Allen coaching PG Kota, Resonance PG Kota, Landmark City PG, Talwandi Kota PG, Vigyan Nagar PG',
    hostelKw:   'Allen coaching hostel Kota, Resonance hostel Kota, Talwandi hostel, Vigyan Nagar hostel',
    colivingKw: 'Talwandi coliving, Vigyan Nagar coliving, coaching hub coliving Kota',
    propKw:     'PG in Kota, hostels in Kota, student accommodation Kota, rooms in Kota, flats in Kota, boys PG Kota, girls hostel Kota, Allen coaching PG Kota, Landmark City PG, Talwandi Kota PG, Vigyan Nagar PG, broker free Kota PG',
  },
  {
    name: 'Jaipur',
    slug: 'jaipur',
    pgKw:       'PG near college Jaipur, student PG Jaipur, single room PG Jaipur',
    hostelKw:   'hostel near college Jaipur, budget hostel Jaipur',
    colivingKw: 'Malviya Nagar coliving, Vaishali Nagar coliving, luxury coliving Jaipur',
    propKw:     'PG in Jaipur, hostels in Jaipur, flats in Jaipur, student rooms Jaipur, boys PG Jaipur, girls PG Jaipur, coliving Jaipur, Malviya Nagar PG, Vaishali Nagar PG, Mansarovar Jaipur PG, student accommodation Jaipur, rental flats Jaipur',
  },
  {
    name: 'Delhi',
    slug: 'delhi',
    pgKw:       'DU student PG, North Campus PG, South Campus PG, Laxmi Nagar PG, Kamla Nagar PG',
    hostelKw:   'DU hostel Delhi, student hostel near DU, North Campus hostel',
    colivingKw: 'Kamla Nagar coliving, Laxmi Nagar coliving, IT coliving Delhi',
    propKw:     'PG in Delhi, hostels in Delhi, flats in Delhi, student rooms Delhi, boys PG Delhi, girls PG Delhi, DU student PG, North Campus PG, South Campus PG, Laxmi Nagar PG, Kamla Nagar PG, coliving Delhi',
  },
  {
    name: 'Indore',
    slug: 'indore',
    pgKw:       'Bhawarkua PG, Vijay Nagar Indore PG, IIT Indore PG, coaching PG Indore',
    hostelKw:   'Bhawarkua hostel Indore, Vijay Nagar hostel, student hostel near IIT Indore',
    colivingKw: 'Vijay Nagar coliving, Bhawarkua coliving, IT coliving Indore',
    propKw:     'PG in Indore, hostels in Indore, flats in Indore, student accommodation Indore, boys PG Indore, girls PG Indore, Bhawarkua PG, Vijay Nagar Indore PG, coliving Indore, rental rooms Indore, student flats Indore, broker free Indore PG',
  },
  {
    name: 'Bhopal',
    slug: 'bhopal',
    pgKw:       'MP Nagar Bhopal PG, Arera Colony PG, student PG near NIT Bhopal',
    hostelKw:   'MP Nagar hostel, Arera Colony hostel, student hostel Bhopal',
    colivingKw: 'MP Nagar coliving, Arera Colony coliving, luxury coliving Bhopal',
    propKw:     'PG in Bhopal, hostels in Bhopal, flats in Bhopal, student rooms Bhopal, boys PG Bhopal, girls PG Bhopal, MP Nagar Bhopal PG, Arera Colony PG, coliving Bhopal, student accommodation Bhopal, rental flats Bhopal, rooms in Bhopal',
  },
  {
    name: 'Nagpur',
    slug: 'nagpur',
    pgKw:       'Dharampeth PG, Ramdaspeth PG, student PG near VNIT Nagpur',
    hostelKw:   'Ramdaspeth hostel, Dharampeth hostel, student hostel near VNIT Nagpur',
    colivingKw: 'Ramdaspeth coliving, Dharampeth coliving, luxury coliving Nagpur',
    propKw:     'PG in Nagpur, hostels in Nagpur, flats in Nagpur, student accommodation Nagpur, boys PG Nagpur, girls PG Nagpur, Dharampeth PG, Ramdaspeth PG, coliving Nagpur, rental rooms Nagpur, student flats Nagpur, broker free Nagpur PG',
  },
  {
    name: 'Sikar',
    slug: 'sikar',
    pgKw:       'Piprali Road PG Sikar, coaching PG Sikar, Station Road Sikar PG, PG near Sikar coaching',
    hostelKw:   'Piprali Road hostel Sikar, coaching hostel Sikar, Station Road hostel Sikar',
    colivingKw: 'Piprali Road coliving, coaching hub coliving Sikar, student coliving Sikar',
    propKw:     'PG in Sikar, hostels in Sikar, student rooms Sikar, Piprali Road PG Sikar, coaching PG Sikar, boys PG Sikar, girls hostel Sikar, student accommodation Sikar, Station Road Sikar PG, rooms in Sikar, budget hostel Sikar, broker free Sikar PG',
  },
  {
    name: 'Bangalore',
    slug: 'bangalore',
    pgKw:       'Koramangala PG, BTM Layout PG, HSR Layout PG, Electronic City PG, IT professional PG Bangalore',
    hostelKw:   'Koramangala hostel, HSR Layout hostel, IT hostel Bangalore, hostel near tech park Bangalore',
    colivingKw: 'Koramangala coliving, HSR Layout coliving, IT park coliving Bangalore',
    propKw:     'PG in Bangalore, coliving Bangalore, hostels in Bangalore, flats in Bangalore, boys PG Bangalore, girls PG Bangalore, Koramangala PG, BTM Layout PG, HSR Layout PG, Electronic City PG, student accommodation Bangalore, IT coliving Bangalore',
  },
  {
    name: 'Pune',
    slug: 'pune',
    pgKw:       'Hinjewadi PG, Kothrud PG, Viman Nagar PG, Wakad PG, IT professional PG Pune',
    hostelKw:   'Hinjewadi hostel, Viman Nagar hostel, IT hostel Pune, hostel near tech park Pune',
    colivingKw: 'Hinjewadi coliving, Viman Nagar coliving, IT park coliving Pune',
    propKw:     'PG in Pune, coliving Pune, hostels in Pune, flats in Pune, boys PG Pune, girls PG Pune, Hinjewadi PG, Kothrud PG, Viman Nagar PG, Wakad PG, student accommodation Pune, IT professional coliving Pune',
  },
  {
    name: 'Hyderabad',
    slug: 'hyderabad',
    pgKw:       'Gachibowli PG, HITEC City PG, Madhapur PG, Kukatpally PG, IT professional PG Hyderabad',
    hostelKw:   'HITEC City hostel, Gachibowli hostel, IT hostel Hyderabad, hostel near tech park Hyderabad',
    colivingKw: 'Gachibowli coliving, HITEC City coliving, IT park coliving Hyderabad',
    propKw:     'PG in Hyderabad, coliving Hyderabad, hostels in Hyderabad, flats in Hyderabad, boys PG Hyderabad, girls PG Hyderabad, Gachibowli PG, HITEC City coliving, Madhapur PG, Kukatpally PG, student accommodation Hyderabad, IT coliving Hyderabad',
  },
  // ✅ ADD NEW CITY BELOW — All PG, Hostel, Co-living & Properties pages auto-generate
  // Example:
  // {
  //   name: 'Mumbai',
  //   slug: 'mumbai',
  //   pgKw:       'Andheri PG, Thane PG, Navi Mumbai PG',
  //   hostelKw:   'Andheri hostel, Thane hostel',
  //   colivingKw: 'Andheri coliving, BKC coliving',
  //   propKw:     'flats in Mumbai, rooms in Mumbai, Andheri PG',
  // },
];

/**
 * AREAS CONFIG
 * Add locality/area entries here. Script auto-generates PG + Hostel + Co-living pages.
 *
 * Fields:
 *  - area      : Display name  (e.g. "Talwandi")
 *  - city      : Parent city name (must match a name in CITIES)
 *  - citySlug  : Parent city slug (e.g. "kota")
 *  - extraPgKw : Optional extra keywords for PG page only
 */
const AREAS = [
  // ── Kota ──────────────────────────────────────────────────────────────────
  { area: 'Talwandi',      citySlug: 'kota', city: 'Kota',    extraPgKw: 'Allen coaching PG Talwandi, study room PG Talwandi' },
  { area: 'Vigyan Nagar',  citySlug: 'kota', city: 'Kota',    extraPgKw: 'boys PG Vigyan Nagar Kota, girls PG Vigyan Nagar Kota' },
  { area: 'Landmark City', citySlug: 'kota', city: 'Kota',    extraPgKw: 'boys PG Landmark City, girls PG Landmark City' },
  { area: 'Mahaveer Nagar',citySlug: 'kota', city: 'Kota',    extraPgKw: 'student PG Mahaveer Nagar, furnished PG Mahaveer Nagar' },
  { area: 'Indra Vihar',   citySlug: 'kota', city: 'Kota',    extraPgKw: 'boys PG Indra Vihar, girls PG Indra Vihar' },

  // ── Jaipur ────────────────────────────────────────────────────────────────
  { area: 'Malviya Nagar', citySlug: 'jaipur', city: 'Jaipur', extraPgKw: 'student PG Malviya Nagar, furnished PG Malviya Nagar Jaipur' },
  { area: 'Vaishali Nagar',citySlug: 'jaipur', city: 'Jaipur', extraPgKw: 'boys PG Vaishali Nagar, girls PG Vaishali Nagar Jaipur' },
  { area: 'Mansarovar',    citySlug: 'jaipur', city: 'Jaipur', extraPgKw: 'student PG Mansarovar, PG near Mansarovar metro' },
  { area: 'C-Scheme',      citySlug: 'jaipur', city: 'Jaipur', extraPgKw: 'luxury PG C-Scheme Jaipur, professional PG C-Scheme' },
  { area: 'Tonk Road',     citySlug: 'jaipur', city: 'Jaipur', extraPgKw: 'student PG Tonk Road, PG near Tonk Road coaching' },

  // ── Delhi ─────────────────────────────────────────────────────────────────
  { area: 'Kamla Nagar',   citySlug: 'delhi', city: 'Delhi',   extraPgKw: 'DU student PG Kamla Nagar, PG near DU Kamla Nagar' },
  { area: 'Lajpat Nagar',  citySlug: 'delhi', city: 'Delhi',   extraPgKw: 'metro connected PG Lajpat Nagar, professional PG Lajpat Nagar' },
  { area: 'Mukherjee Nagar',citySlug: 'delhi', city: 'Delhi',  extraPgKw: 'UPSC PG Mukherjee Nagar, student PG Mukherjee Nagar' },
  { area: 'Laxmi Nagar',   citySlug: 'delhi', city: 'Delhi',   extraPgKw: 'boys PG Laxmi Nagar, girls PG Laxmi Nagar Delhi' },
  { area: 'Rohini',        citySlug: 'delhi', city: 'Delhi',   extraPgKw: 'student PG Rohini, boys PG Rohini Delhi' },

  // ── Indore ────────────────────────────────────────────────────────────────
  { area: 'Vijay Nagar',   citySlug: 'indore', city: 'Indore', extraPgKw: 'student PG Vijay Nagar Indore, furnished PG Vijay Nagar' },
  { area: 'Bhawarkua',     citySlug: 'indore', city: 'Indore', extraPgKw: 'student PG Bhawarkua, boys PG Bhawarkua Indore' },
  { area: 'Rau',           citySlug: 'indore', city: 'Indore', extraPgKw: 'student PG Rau Indore, affordable PG Rau' },
  { area: 'Palasia',       citySlug: 'indore', city: 'Indore', extraPgKw: 'luxury PG Palasia Indore, professional PG Palasia' },
  { area: 'Annapurna Road',citySlug: 'indore', city: 'Indore', extraPgKw: 'student PG Annapurna Road, boys PG Annapurna Road Indore' },

  // ── Bhopal ────────────────────────────────────────────────────────────────
  { area: 'MP Nagar',      citySlug: 'bhopal', city: 'Bhopal', extraPgKw: 'professional PG MP Nagar, student PG MP Nagar Bhopal' },
  { area: 'Kolar Road',    citySlug: 'bhopal', city: 'Bhopal', extraPgKw: 'student PG Kolar Road, affordable PG Kolar Road Bhopal' },
  { area: 'Arera Colony',  citySlug: 'bhopal', city: 'Bhopal', extraPgKw: 'furnished PG Arera Colony, boys PG Arera Colony Bhopal' },
  { area: 'Shahpura',      citySlug: 'bhopal', city: 'Bhopal', extraPgKw: 'student PG Shahpura, girls PG Shahpura Bhopal' },

  // ── Nagpur ────────────────────────────────────────────────────────────────
  { area: 'Ramdaspeth',    citySlug: 'nagpur', city: 'Nagpur', extraPgKw: 'student PG Ramdaspeth, luxury PG Ramdaspeth Nagpur' },
  { area: 'Sadar',         citySlug: 'nagpur', city: 'Nagpur', extraPgKw: 'boys PG Sadar Nagpur, affordable PG Sadar' },
  { area: 'Dharampeth',    citySlug: 'nagpur', city: 'Nagpur', extraPgKw: 'student PG Dharampeth, professional PG Dharampeth Nagpur' },
  { area: 'Manish Nagar',  citySlug: 'nagpur', city: 'Nagpur', extraPgKw: 'boys PG Manish Nagar, furnished PG Manish Nagar Nagpur' },
  { area: 'Pratap Nagar',  citySlug: 'nagpur', city: 'Nagpur', extraPgKw: 'student PG Pratap Nagar, girls PG Pratap Nagar Nagpur' },

  // ── Sikar ─────────────────────────────────────────────────────────────────
  { area: 'Piprali Road',  citySlug: 'sikar', city: 'Sikar',   extraPgKw: 'coaching PG Piprali Road Sikar, student PG near coaching Sikar' },
  { area: 'Station Road',  citySlug: 'sikar', city: 'Sikar',   extraPgKw: 'affordable PG Station Road Sikar, boys PG Station Road' },

  // ── Bangalore ─────────────────────────────────────────────────────────────
  { area: 'Koramangala',   citySlug: 'bangalore', city: 'Bangalore', extraPgKw: 'IT PG Koramangala, startup hub PG Koramangala Bangalore' },
  { area: 'HSR Layout',    citySlug: 'bangalore', city: 'Bangalore', extraPgKw: 'IT professional PG HSR Layout, furnished PG HSR Layout' },
  { area: 'BTM Layout',    citySlug: 'bangalore', city: 'Bangalore', extraPgKw: 'student PG BTM Layout, IT PG BTM Layout Bangalore' },
  { area: 'Electronic City',citySlug: 'bangalore', city: 'Bangalore',extraPgKw: 'IT PG Electronic City, tech park PG Electronic City Bangalore' },
  { area: 'Whitefield',    citySlug: 'bangalore', city: 'Bangalore', extraPgKw: 'IT professional PG Whitefield, furnished PG Whitefield Bangalore' },

  // ── Pune ──────────────────────────────────────────────────────────────────
  { area: 'Hinjewadi',     citySlug: 'pune', city: 'Pune',     extraPgKw: 'IT PG Hinjewadi, tech park PG Hinjewadi Pune' },
  { area: 'Viman Nagar',   citySlug: 'pune', city: 'Pune',     extraPgKw: 'IT professional PG Viman Nagar, furnished PG Viman Nagar Pune' },
  { area: 'Kothrud',       citySlug: 'pune', city: 'Pune',     extraPgKw: 'student PG Kothrud, college PG Kothrud Pune' },
  { area: 'Wakad',         citySlug: 'pune', city: 'Pune',     extraPgKw: 'IT PG Wakad, tech park PG Wakad Pune' },
  { area: 'Baner',         citySlug: 'pune', city: 'Pune',     extraPgKw: 'IT professional PG Baner, furnished PG Baner Pune' },

  // ── Hyderabad ─────────────────────────────────────────────────────────────
  { area: 'Gachibowli',    citySlug: 'hyderabad', city: 'Hyderabad', extraPgKw: 'IT PG Gachibowli, tech hub PG Gachibowli Hyderabad' },
  { area: 'Madhapur',      citySlug: 'hyderabad', city: 'Hyderabad', extraPgKw: 'IT professional PG Madhapur, HITEC City PG Madhapur' },
  { area: 'Kukatpally',    citySlug: 'hyderabad', city: 'Hyderabad', extraPgKw: 'student PG Kukatpally, college PG Kukatpally Hyderabad' },
  { area: 'Kondapur',      citySlug: 'hyderabad', city: 'Hyderabad', extraPgKw: 'IT PG Kondapur, tech park PG Kondapur Hyderabad' },
  { area: 'Miyapur',       citySlug: 'hyderabad', city: 'Hyderabad', extraPgKw: 'student PG Miyapur, affordable PG Miyapur Hyderabad' },

  // ✅ ADD NEW AREA BELOW — PG, Hostel, Co-living pages auto-generate
  // Example:
  // { area: 'Andheri',  citySlug: 'mumbai', city: 'Mumbai', extraPgKw: 'working professional PG Andheri, IT PG Andheri Mumbai' },
];

// =============================================================================
//  STATIC CORE PAGES — Home, About, Contact, etc. (rarely changes)
// =============================================================================
const staticPages = [
  // Core
  { pageKey: 'home',         pageName: 'Home',             slug: '',                  metaTitle: 'Top PGs, Hostels & Co-living in India | Roomhy.com',                   metaDescription: 'Discover 100% verified student PGs, hostels, and flats across India. Enjoy zero brokerage, fully furnished rooms, homemade meals, and easy budget bidding.',                   robots: 'index, follow', isIndexed: true, sitemapPriority: 1.0, sitemapChangefreq: 'daily',   metaKeywords: 'PG, Hostels, Co-living, Student Housing, PG in India, hostels in India, coliving spaces, room rent, shared accommodation, student PG, zero brokerage PG, rental rooms' },
  { pageKey: 'about',        pageName: 'About Us',         slug: 'about-us',          metaTitle: 'About Us | Zero Brokerage Student Stays | Roomhy.com',                  metaDescription: "Learn about Roomhy.com's mission to provide 100% verified, broker-free student and professional living across India with transparent budget bidding.",              robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'monthly', metaKeywords: 'about Roomhy, student housing platform, broker free PG platform, roomhy story, student living India, verified PG portal, coliving company India, rental housing platform, zero brokerage accommodation, student PG finder' },
  { pageKey: 'contact',      pageName: 'Contact Us',       slug: 'contact-us',        metaTitle: 'Contact Us | 24/7 Support & Help | Roomhy.com',                         metaDescription: 'Get in touch with the Roomhy.com support team. Contact us for booking assistance, owner listings, cancellations, refunds, or general queries.',                robots: 'index, follow', isIndexed: true, sitemapPriority: 0.7, sitemapChangefreq: 'monthly', metaKeywords: 'Roomhy contact number, Roomhy customer care, student housing support, PG booking support, Roomhy helpline, roomhy office address, hostel inquiry, PG customer care, contact roomhy, student stay support' },
  { pageKey: 'list-property',pageName: 'List Property',    slug: 'list-property',     metaTitle: 'List Your Property for Free | Hostels & PGs | Roomhy.com',              metaDescription: 'List your PG, hostel, co-living space, or apartment on Roomhy.com for free. Connect directly with verified student tenants and maximize your occupancy.',    robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'weekly',  metaKeywords: 'list PG for free, list hostel online, property owner listing, rent PG to students, list coliving space, free property listing site, student accommodation listing, rent room to students, PG owner portal, list room online' },
  { pageKey: 'login',        pageName: 'Login',            slug: 'login',             metaTitle: 'Login to Your Account | Tenant & Owner | Roomhy.com',                   metaDescription: 'Login to your Roomhy.com account to manage bookings, track live bids, connect directly with property owners, or access your owner dashboard.',               robots: 'index, follow', isIndexed: true, sitemapPriority: 0.5, sitemapChangefreq: 'monthly', metaKeywords: 'Roomhy login, PG tenant login, student housing login, owner dashboard login, roomhy portal login, PG booking login, sign in roomhy, landlord login, hostel management login, roomhy account' },
  { pageKey: 'register',     pageName: 'Register',         slug: 'register',          metaTitle: 'Create an Account | Sign Up on Roomhy.com',                             metaDescription: 'Sign up on Roomhy.com to discover verified student stays, place live bids on your budget, and connect directly with verified property owners.',                robots: 'index, follow', isIndexed: true, sitemapPriority: 0.5, sitemapChangefreq: 'monthly', metaKeywords: 'Roomhy registration, sign up roomhy, create PG account, tenant signup, student housing registration, owner registration, register on roomhy, PG booking register, coliving signup, join roomhy' },
  { pageKey: 'blogs',        pageName: 'Blogs',            slug: 'blogs',             metaTitle: 'Student Housing Guides, Tips & Insights | Roomhy.com Blog',             metaDescription: 'Read helpful guides, city living tips, rent breakdowns, and student housing advice on the Roomhy.com blog to make your next move effortless.',                   robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly',  metaKeywords: 'student housing blog, PG tips and guide, hostel vs PG guide, student living tips, Kota PG guide, rent breakdown blog, student accommodation tips, coliving guide, roommate advice, college living guide' },
  { pageKey: 'privacy',      pageName: 'Privacy Policy',   slug: 'privacy-policy',    metaTitle: 'Privacy Policy | User Data Protection | Roomhy.com',                    metaDescription: "Read Roomhy.com's privacy policy to understand how we collect, use, and protect your personal data, booking details, and browsing information securely.",     robots: 'index, follow', isIndexed: true, sitemapPriority: 0.3, sitemapChangefreq: 'yearly',  metaKeywords: 'Roomhy privacy policy, user data protection, privacy terms, roomhy terms, student data security, booking privacy policy, user agreement privacy, data privacy policy, portal terms' },
  { pageKey: 'terms',        pageName: 'Terms',            slug: 'terms-and-conditions',metaTitle: 'Terms and Conditions | User Agreement | Roomhy.com',                  metaDescription: "Review Roomhy.com's terms and conditions covering platform usage, booking rules, bidding policies, payments, and tenant-owner guidelines.",                    robots: 'index, follow', isIndexed: true, sitemapPriority: 0.3, sitemapChangefreq: 'yearly',  metaKeywords: 'Roomhy terms and conditions, user agreement, PG booking rules, cancellation policy, refund terms, platform usage terms, rental agreement terms, tenant guidelines, owner rules, roomhy legal' },

  // Category Main
  { pageKey: 'pg-main',       pageName: 'PG',       slug: 'pg',        metaTitle: 'Top Verified PGs in India | Zero Brokerage | Roomhy.com',           metaDescription: 'Find top verified student and professional PGs across India. Zero brokerage, fully furnished rooms, meals, and budget bidding on Roomhy.com.',    robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily', metaKeywords: 'PG in India, paying guest, student PG, boys PG, girls PG, luxury PG, single room PG, double sharing PG, PG with food, broker free PG, verified PG, student accommodation' },
  { pageKey: 'hostels-main',  pageName: 'Hostel',   slug: 'hostels',   metaTitle: 'Best Affordable Hostels in India | Zero Brokerage | Roomhy.com',    metaDescription: 'Book verified student & working hostels across top cities. Enjoy zero brokerage, furnished rooms, meals, security, and low prices.',              robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily', metaKeywords: 'hostels in India, student hostels, boys hostel, girls hostel, budget hostels, working professional hostel, AC hostel, hostel with food, student stay, low cost hostel, verified hostels, secure hostel' },
  { pageKey: 'co-living-main',pageName: 'Co-Living',slug: 'co-living', metaTitle: 'Top Co-Living Spaces in India | Zero Brokerage | Roomhy.com',       metaDescription: 'Explore top modern co-living spaces for students and pros. Zero brokerage, high-speed Wi-Fi, housekeeping, and community living on Roomhy.com.',  robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily', metaKeywords: 'coliving in India, coliving spaces, shared living spaces, luxury coliving, student coliving, coliving with food, furnished coliving rooms, modern coliving, community living, shared apartments, premium coliving, broker free coliving' },

  // Category Directory (Cities/Localities listing pages)
  { pageKey: 'pg-cities',         pageName: 'Top Cities for PGs',          slug: 'pg-cities',         metaTitle: 'Top Cities for PGs in India | Zero Brokerage | Roomhy.com',            metaDescription: 'Explore top Indian cities to find verified PGs. Compare student & professional accommodations with zero brokerage and modern amenities on Roomhy.com.',          robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly', metaKeywords: 'PG cities in India, best cities for PG, student PG cities, PG in Kota, PG in Delhi, PG in Bangalore, PG in Pune, PG in Jaipur, PG in Indore, PG in Hyderabad, student housing cities, top PG locations' },
  { pageKey: 'pg-localities',     pageName: 'Top Localities for PGs',      slug: 'pg-localities',     metaTitle: 'Top Localities for PGs Across India | Roomhy.com',                      metaDescription: 'Browse top student & IT localities for verified PGs across India. Enjoy zero brokerage, budget bidding, furnished rooms, and meals on Roomhy.com.',             robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly', metaKeywords: 'PG localities in India, top student localities, best PG areas, Talwandi Kota PG, Koramangala PG, North Campus PG, Bhawarkua Indore PG, Piprali Road PG, Hinjewadi Pune PG, student areas India, top coaching PG localities, coliving localities' },
  { pageKey: 'hostels-cities',    pageName: 'Top Cities for Hostels',      slug: 'hostels-cities',    metaTitle: 'Top Cities for Hostels in India | Zero Brokerage | Roomhy.com',          metaDescription: 'Discover affordable student and working hostels across major Indian cities. Zero brokerage, verified listings, and secure stays with Roomhy.com.',                robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly', metaKeywords: 'hostel cities in India, best cities for hostels, student hostels India, hostels in Kota, hostels in Delhi, hostels in Jaipur, hostels in Indore, hostels in Sikar, hostels in Bangalore, budget hostel cities, student accommodation cities, top hostel locations' },
  { pageKey: 'hostels-localities',pageName: 'Top Localities for Hostels',  slug: 'hostels-localities',metaTitle: 'Top Localities for Hostels in India | Roomhy.com',                     metaDescription: 'Find top student localities for budget hostels across India. Enjoy zero brokerage, furnished rooms, Wi-Fi, and 24/7 security on Roomhy.com.',                   robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly', metaKeywords: 'hostel localities in India, best student hostel areas, top coaching hostel areas, Talwandi hostels, Landmark City hostels, Piprali Road hostels, Kamla Nagar hostels, Vijay Nagar hostels, student hostel hubs, affordable hostel localities, girls hostel areas, boys hostel areas' },
  { pageKey: 'co-living-cities',  pageName: 'Top Cities for Co-Living',    slug: 'co-living-cities',  metaTitle: 'Top Cities for Co-Living in India | Zero Brokerage | Roomhy.com',       metaDescription: 'Explore modern co-living spaces across top Indian cities. Zero brokerage, fully furnished community living, and high-speed Wi-Fi on Roomhy.com.',               robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly', metaKeywords: 'coliving cities in India, best cities for coliving, coliving Bangalore, coliving Pune, coliving Hyderabad, coliving Delhi, coliving Jaipur, coliving Indore, top shared living cities, IT coliving cities, modern coliving hubs, student coliving cities' },
  { pageKey: 'co-living-localities',pageName:'Top Localities for Co-Living',slug:'co-living-localities',metaTitle:'Top Localities for Co-Living in India | Roomhy.com',                  metaDescription: 'Discover premium co-living localities across India. Connect directly with owners, bid your budget, and move into verified stays on Roomhy.com.',               robots: 'index, follow', isIndexed: true, sitemapPriority: 0.8, sitemapChangefreq: 'weekly', metaKeywords: 'coliving localities in India, best coliving areas, Koramangala coliving, HSR Layout coliving, Gachibowli coliving, Hinjewadi coliving, Viman Nagar coliving, Malviya Nagar coliving, shared living localities, premium coliving areas, student coliving hubs, tech park coliving' },
];

// =============================================================================
//  GENERATORS — Auto-build all city & area pages from config
// =============================================================================

/** Convert "Vigyan Nagar" → "vigyan-nagar" */
function toSlug(str) {
    return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/** Generates 3 pages (PG + Hostel + Co-living) for a city */
function generateCityPages(city) {
    const { name, slug, pgKw, hostelKw, colivingKw, propKw } = city;
    const baseKw = `boys PG ${name}, girls PG ${name}, student accommodation ${name}, paying guest ${name}, single room PG ${name}, PG with food ${name}, affordable PG ${name}, verified PG ${name}, broker free PG ${name}`;

    return [
        // Properties in <City>
        {
            pageKey: `properties-in-${slug}`,
            pageName: `Properties in ${name}`,
            slug: `properties-in-${slug}`,
            metaTitle: `Top PGs, Hostels & Flats in ${name} | Roomhy.com`,
            metaDescription: `Find top verified student PGs, hostels, and flats in ${name} with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.`,
            metaKeywords: propKw,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily',
        },
        // PG in <City>
        {
            pageKey: `pg-in-${slug}`,
            pageName: `PG in ${name}`,
            slug: `pg-in-${slug}`,
            metaTitle: `Best PG in ${name} | Boys & Girls | Roomhy`,
            metaDescription: `Find the best PG in ${name} for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.`,
            metaKeywords: `PG in ${name}, hostels in ${name}, ${baseKw}, ${pgKw}`,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily',
        },
        // Hostel in <City>
        {
            pageKey: `hostels-in-${slug}`,
            pageName: `Hostel in ${name}`,
            slug: `hostels-in-${slug}`,
            metaTitle: `Best Hostels in ${name} | Boys & Girls | Roomhy`,
            metaDescription: `Find the best hostels in ${name} for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.`,
            metaKeywords: `hostels in ${name}, student hostels ${name}, boys hostel ${name}, girls hostel ${name}, affordable hostel ${name}, verified hostel ${name}, hostel with food ${name}, budget hostel ${name}, broker free hostel ${name}, ${hostelKw}`,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily',
        },
        // Co-Living in <City>
        {
            pageKey: `co-living-in-${slug}`,
            pageName: `Co-Living Spaces in ${name}`,
            slug: `co-living-in-${slug}`,
            metaTitle: `Best Co-Living in ${name} | Boys & Girls | Roomhy`,
            metaDescription: `Find the best co-living spaces in ${name} for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.`,
            metaKeywords: `coliving in ${name}, co living ${name}, shared accommodation ${name}, student coliving ${name}, furnished coliving ${name}, coliving with food ${name}, affordable coliving ${name}, luxury coliving ${name}, broker free coliving ${name}, ${colivingKw}`,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.9, sitemapChangefreq: 'daily',
        },
    ];
}

/** Generates 3 pages (PG + Hostel + Co-living) for an area/locality */
function generateAreaPages({ area, city, citySlug, extraPgKw = '' }) {
    const areaSlug = toSlug(area);
    const slug = `${areaSlug}-${citySlug}`;

    const propKw   = `PG in ${area} ${city}, hostels in ${area} ${city}, student accommodation ${area} ${city}, rooms in ${area} ${city}, flats in ${area} ${city}, boys PG ${area} ${city}, girls hostel ${area} ${city}, broker free ${area} ${city} PG${extraPgKw ? ', ' + extraPgKw : ''}`;
    const pgKw     = `PG in ${area} ${city}, best PG in ${area} ${city}, PG in ${area}, paying guest in ${area} ${city}, student PG in ${area}, boys PG in ${area}, girls PG in ${area}, single room PG ${area}, PG in ${area} with food, affordable PG in ${area} ${city}, verified PG in ${area}, broker free PG in ${area}${extraPgKw ? ', ' + extraPgKw : ''}`;
    const hostelKw = `Hostels in ${area} ${city}, best hostels in ${area} ${city}, hostel in ${area}, student hostel in ${area} ${city}, boys hostel in ${area}, girls hostel in ${area}, affordable hostel in ${area}, hostel in ${area} with food, single room hostel in ${area}, verified hostels in ${area}, student accommodation in ${area}, broker free hostel in ${area}`;
    const coKw     = `Co-living in ${area} ${city}, best coliving in ${area} ${city}, co living space in ${area}, coliving in ${area} ${city}, shared accommodation in ${area}, student co living in ${area}, affordable co living in ${area}, luxury coliving ${area} ${city}, furnished coliving in ${area}, coliving spaces in ${area}, coliving with food in ${area}, shared living ${area} ${city}`;

    return [
        {
            pageKey: `properties-in-${slug}`,
            pageName: `Properties in ${area} ${city}`,
            slug: `properties-in-${slug}`,
            metaTitle: `Top PGs, Hostels & Flats in ${area} ${city} | Roomhy.com`,
            metaDescription: `Find top verified student PGs, hostels, and flats in ${area}, ${city} with zero brokerage, modern amenities, and prime stays on Roomhy.com.`,
            metaKeywords: propKw,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly',
        },
        {
            pageKey: `pg-in-${slug}`,
            pageName: `PG in ${area} ${city}`,
            slug: `pg-in-${slug}`,
            metaTitle: `Best PG in ${area} for Boys & Girls | Roomhy`,
            metaDescription: `Find the best PG in ${area}, ${city} for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.`,
            metaKeywords: pgKw,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly',
        },
        {
            pageKey: `hostels-in-${slug}`,
            pageName: `Hostel in ${area} ${city}`,
            slug: `hostels-in-${slug}`,
            metaTitle: `Best Hostels in ${area} for Boys & Girls | Roomhy`,
            metaDescription: `Find the best hostels in ${area}, ${city} for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.`,
            metaKeywords: hostelKw,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly',
        },
        {
            pageKey: `co-living-in-${slug}`,
            pageName: `Co-Living in ${area} ${city}`,
            slug: `co-living-in-${slug}`,
            metaTitle: `Best Co-Living in ${area} | Boys & Girls | Roomhy`,
            metaDescription: `Find the best co-living spaces in ${area}, ${city} for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.`,
            metaKeywords: coKw,
            robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly',
        },
    ];
}

// =============================================================================
//  ASSEMBLE ALL ENTRIES
// =============================================================================
const allSeoEntries = [
    ...staticPages,
    ...CITIES.flatMap(generateCityPages),
    ...AREAS.flatMap(generateAreaPages),
];

// =============================================================================
//  DB UPSERT
// =============================================================================
async function updateSeo() {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/roomhy';
    console.log(`🔗 Connecting to MongoDB: ${mongoUri.substring(0, 50)}...`);

    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 15000,
        family: 4
    });
    console.log('✅ Connected to Database');
    console.log(`\n📊 Upserting ${allSeoEntries.length} SEO Pages...`);

    let updatedCount = 0;
    for (const data of allSeoEntries) {
        const canonicalUrl = `https://roomhy.com/${data.slug}`.replace(/\/+$/, '');
        const payload = {
            ...data,
            canonicalUrl: data.canonicalUrl || canonicalUrl,
            openGraphTitle: data.metaTitle,
            openGraphDescription: data.metaDescription,
            twitterTitle: data.metaTitle,
            twitterDescription: data.metaDescription,
        };

        const filter = data.slug !== undefined
            ? { slug: data.slug }
            : { pageKey: data.pageKey, entityId: null };

        await SeoPage.findOneAndUpdate(filter, { $set: payload }, { upsert: true, new: true });
        updatedCount++;
    }

    console.log(`\n✅ SEO update complete. Upserted ${updatedCount} pages in database.`);
    console.log(`   📄 Static pages   : ${staticPages.length}`);
    console.log(`   🏙️  City pages     : ${CITIES.length * 4} (${CITIES.length} cities × 4 types)`);
    console.log(`   📍 Area/Locality  : ${AREAS.length * 4} (${AREAS.length} areas × 4 types)`);
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
}

updateSeo().catch(err => {
    console.error('❌ SEO update failed:', err);
    process.exit(1);
});
