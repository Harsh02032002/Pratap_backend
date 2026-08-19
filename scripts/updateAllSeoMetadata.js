const dns = require('dns');
if (!dns.getServers().includes('8.8.8.8')) {
    dns.setServers(['8.8.8.8', '8.8.4.4']);
}

require('dotenv').config();
const mongoose = require('mongoose');
const SeoPage = require('../models/SeoPage');

const allSeoEntries = [
  // --- Core Pages ---
  {
    pageKey: 'home',
    pageName: 'Home',
    slug: '',
    metaTitle: 'Top PGs, Hostels & Co-living in India | Roomhy.com',
    metaDescription: 'Discover 100% verified student PGs, hostels, and flats across India. Enjoy zero brokerage, fully furnished rooms, homemade meals, and easy budget bidding.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 1.0,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'about',
    pageName: 'About Us',
    slug: 'about-us',
    metaTitle: 'About Us | Zero Brokerage Student Stays | Roomhy.com',
    metaDescription: "Learn about Roomhy.com's mission to provide 100% verified, broker-free student and professional living across India with transparent budget bidding.",
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'monthly'
  },
  {
    pageKey: 'contact',
    pageName: 'Contact Us',
    slug: 'contact-us',
    metaTitle: 'Contact Us | 24/7 Support & Help | Roomhy.com',
    metaDescription: 'Get in touch with the Roomhy.com support team. Contact us for booking assistance, owner listings, cancellations, refunds, or general queries.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.7,
    sitemapChangefreq: 'monthly'
  },
  {
    pageKey: 'list-property',
    pageName: 'List Property',
    slug: 'list-property',
    metaTitle: 'List Your Property for Free | Hostels & PGs | Roomhy.com',
    metaDescription: 'List your PG, hostel, co-living space, or apartment on Roomhy.com for free. Connect directly with verified student tenants and maximize your occupancy.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'login',
    pageName: 'Login',
    slug: 'login',
    metaTitle: 'Login to Your Account | Tenant & Owner | Roomhy.com',
    metaDescription: 'Login to your Roomhy.com account to manage bookings, track live bids, connect directly with property owners, or access your owner dashboard.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.5,
    sitemapChangefreq: 'monthly'
  },
  {
    pageKey: 'register',
    pageName: 'Register',
    slug: 'register',
    metaTitle: 'Create an Account | Sign Up on Roomhy.com',
    metaDescription: 'Sign up on Roomhy.com to discover verified student stays, place live bids on your budget, and connect directly with verified property owners.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.5,
    sitemapChangefreq: 'monthly'
  },
  {
    pageKey: 'blogs',
    pageName: 'Blogs',
    slug: 'blogs',
    metaTitle: 'Student Housing Guides, Tips & Insights | Roomhy.com Blog',
    metaDescription: 'Read helpful guides, city living tips, rent breakdowns, and student housing advice on the Roomhy.com blog to make your next move effortless.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'privacy',
    pageName: 'Privacy Policy',
    slug: 'privacy-policy',
    metaTitle: 'Privacy Policy | User Data Protection | Roomhy.com',
    metaDescription: "Read Roomhy.com's privacy policy to understand how we collect, use, and protect your personal data, booking details, and browsing information securely.",
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.3,
    sitemapChangefreq: 'yearly'
  },
  {
    pageKey: 'terms',
    pageName: 'Terms and Conditions',
    slug: 'terms-and-conditions',
    metaTitle: 'Terms and Conditions | User Agreement | Roomhy.com',
    metaDescription: "Review Roomhy.com's terms and conditions covering platform usage, booking rules, bidding policies, payments, and tenant-owner guidelines.",
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.3,
    sitemapChangefreq: 'yearly'
  },

  // --- Category Main Pages ---
  {
    pageKey: 'pg-main',
    pageName: 'PG',
    slug: 'pg',
    metaTitle: 'Top Verified PGs in India | Zero Brokerage | Roomhy.com',
    metaDescription: 'Find top verified student and professional PGs across India. Zero brokerage, fully furnished rooms, meals, and budget bidding on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-main',
    pageName: 'Hostel',
    slug: 'hostels',
    metaTitle: 'Best Affordable Hostels in India  | Zero Brokerage | Roomhy.com',
    metaDescription: 'Book verified student & working hostels across top cities. Enjoy zero brokerage, furnished rooms, meals, security, and low prices.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-main',
    pageName: 'Co-Living',
    slug: 'co-living',
    metaTitle: 'Top Co-Living Spaces in India | Zero Brokerage | Roomhy.com',
    metaDescription: 'Explore top modern co-living spaces for students and pros. Zero brokerage, high-speed Wi-Fi, housekeeping, and community living on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },

  // --- Properties in City Pages ---
  {
    pageKey: 'properties-in-kota',
    pageName: 'Properties in Kota',
    slug: 'properties-in-kota',
    metaTitle: 'Top PGs, Hostels & Flats in Kota | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Kota with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-jaipur',
    pageName: 'Properties in Jaipur',
    slug: 'properties-in-jaipur',
    metaTitle: 'Top PGs, Hostels & Flats in Jaipur | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Jaipur with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-delhi',
    pageName: 'Properties in Delhi',
    slug: 'properties-in-delhi',
    metaTitle: 'Top PGs, Hostels & Flats in Delhi| Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Delhi with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-indore',
    pageName: 'Properties in Indore',
    slug: 'properties-in-indore',
    metaTitle: 'Top PGs, Hostels & Flats in Indore | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Indore with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-bhopal',
    pageName: 'Properties in Bhopal',
    slug: 'properties-in-bhopal',
    metaTitle: 'Top PGs, Hostels & Flats in Bhopal | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Bhopal with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-nagpur',
    pageName: 'Properties in Nagpur',
    slug: 'properties-in-nagpur',
    metaTitle: 'Top PGs, Hostels & Flats in Nagpur | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Nagpur with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-sikar',
    pageName: 'Properties in Sikar',
    slug: 'properties-in-sikar',
    metaTitle: 'Top PGs, Hostels & Flats in Sikar | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Sikar with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-bangalore',
    pageName: 'Properties in Bangalore',
    slug: 'properties-in-bangalore',
    metaTitle: 'Top PGs, Hostels & Flats in Bangalore | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Bangalore with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-pune',
    pageName: 'Properties in Pune',
    slug: 'properties-in-pune',
    metaTitle: 'Top PGs, Hostels & Flats in Pune | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Pune with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'properties-in-hyderabad',
    pageName: 'Properties in Hyderabad',
    slug: 'properties-in-hyderabad',
    metaTitle: 'Top PGs, Hostels & Flats in Hyderabad | Roomhy.com',
    metaDescription: 'Find top verified student PGs, hostels, and flats in Hyderabad with zero brokerage, modern amenities, and prime stays near top colleges and hubs on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },

  // --- Category Listing Directories ---
  {
    pageKey: 'pg-cities',
    pageName: 'Top Cities for PGs in India',
    slug: 'pg-cities',
    metaTitle: 'Top Cities for PGs in India | Zero Brokerage | Roomhy.com',
    metaDescription: 'Explore top Indian cities to find verified PGs. Compare student & professional accommodations with zero brokerage and modern amenities on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'pg-localities',
    pageName: 'Top Localities for PGs Across India',
    slug: 'pg-localities',
    metaTitle: 'Top Localities for PGs Across India | Roomhy.com',
    metaDescription: 'Browse top student & IT localities for verified PGs across India. Enjoy zero brokerage, budget bidding, furnished rooms, and meals on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'hostels-cities',
    pageName: 'Top Cities for Hostels in India',
    slug: 'hostels-cities',
    metaTitle: 'Top Cities for Hostels in India | Zero Brokerage | Roomhy.com',
    metaDescription: 'Discover affordable student and working hostels across major Indian cities. Zero brokerage, verified listings, and secure stays with Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'hostels-localities',
    pageName: 'Top Localities for Hostels in India',
    slug: 'hostels-localities',
    metaTitle: 'Top Localities for Hostels in India | Roomhy.com',
    metaDescription: 'Find top student localities for budget hostels across India. Enjoy zero brokerage, furnished rooms, Wi-Fi, and 24/7 security on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'co-living-cities',
    pageName: 'Top Cities for Co-Living in India',
    slug: 'co-living-cities',
    metaTitle: 'Top Cities for Co-Living in India | Zero Brokerage | Roomhy.com',
    metaDescription: 'Explore modern co-living spaces across top Indian cities. Zero brokerage, fully furnished community living, and high-speed Wi-Fi on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },
  {
    pageKey: 'co-living-localities',
    pageName: 'Top Localities for Co-Living in India',
    slug: 'co-living-localities',
    metaTitle: 'Top Localities for Co-Living in India | Roomhy.com',
    metaDescription: 'Discover premium co-living localities across India. Connect directly with owners, bid your budget, and move into verified stays on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.8,
    sitemapChangefreq: 'weekly'
  },

  // --- Category by City Pages ---
  {
    pageKey: 'pg-in-kota',
    pageName: 'PG in Kota',
    slug: 'pg-in-kota',
    metaTitle: 'Top Verified PGs in India | Zero Brokerage | Roomhy.com',
    metaDescription: 'Find top verified student and professional PGs across India. Zero brokerage, fully furnished rooms, meals, and budget bidding on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-jaipur',
    pageName: 'PG in Jaipur',
    slug: 'pg-in-jaipur',
    metaTitle: 'Best PG in Jaipur for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Jaipur for boys and girls near top colleges. Fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-delhi',
    pageName: 'PG in Delhi',
    slug: 'pg-in-delhi',
    metaTitle: 'Best PG in Delhi for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Delhi for students near DU and coaching centres. Fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-indore',
    pageName: 'PG in Indore',
    slug: 'pg-in-indore',
    metaTitle: 'Best PG in Indore for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Indore for students near coaching centres and tech parks. Fully furnished rooms with meals, Wi-Fi, daily cleaning, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-bhopal',
    pageName: 'PG in Bhopal',
    slug: 'pg-in-bhopal',
    metaTitle: 'Best PG in Bhopal for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Bhopal for students and working professionals. Enjoy fully furnished rooms with homemade food, Wi-Fi, security, and zero brokerage on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-nagpur',
    pageName: 'PG in Nagpur',
    slug: 'pg-in-nagpur',
    metaTitle: 'Best PG in Nagpur for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Nagpur for boys and girls. Verified furnished rooms with Wi-Fi, homemade meals, 24/7 security, and zero brokerage on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-sikar',
    pageName: 'PG in Sikar',
    slug: 'pg-in-sikar',
    metaTitle: 'Best PG in Sikar for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Sikar for students near Piprali Road coaching hubs. Fully furnished rooms with food, Wi-Fi, study desks, and zero brokerage on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-bangalore',
    pageName: 'PG in Bangalore',
    slug: 'pg-in-bangalore',
    metaTitle: 'Best PG in Bangalore for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Bangalore for students and IT professionals. Furnished rooms with high-speed Wi-Fi, food, housekeeping, and 0% brokerage on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-pune',
    pageName: 'PG in Pune',
    slug: 'pg-in-pune',
    metaTitle: 'Best PG in Pune for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Pune for students and professionals near top colleges and IT parks. Fully furnished rooms with Wi-Fi, meals, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'pg-in-hyderabad',
    pageName: 'PG in Hyderabad',
    slug: 'pg-in-hyderabad',
    metaTitle: 'Best PG in Hyderabad for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best PG in Hyderabad for students and pros near tech hubs and institutes. Furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },

  {
    pageKey: 'hostels-in-kota',
    pageName: 'Hostel in Kota',
    slug: 'hostels-in-kota',
    metaTitle: 'Best Hostels in Kota for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best student hostels in Kota near Allen and Motion. Verified rooms with hygienic food, Wi-Fi, 24/7 security, study desks, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-jaipur',
    pageName: 'Hostel in Jaipur',
    slug: 'hostels-in-jaipur',
    metaTitle: 'Best Hostels in Jaipur for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Jaipur for boys and girls near top colleges. Enjoy fully furnished rooms with meals, Wi-Fi, security, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-delhi',
    pageName: 'Hostel in Delhi',
    slug: 'hostels-in-delhi',
    metaTitle: 'Best Hostels in Delhi for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best student and working hostels in Delhi near DU campuses and metro hubs. Furnished stays with food, high-speed Wi-Fi, and 0% brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-indore',
    pageName: 'Hostel in Indore',
    slug: 'hostels-in-indore',
    metaTitle: 'Best Hostels in Indore for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Indore for students near Bhawarkua and coaching hubs. Fully furnished rooms with meals, Wi-Fi, security, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-bhopal',
    pageName: 'Hostel in Bhopal',
    slug: 'hostels-in-bhopal',
    metaTitle: 'Best Hostels in Bhopal for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Bhopal for boys and girls near top institutes. Furnished rooms with homemade food, Wi-Fi, CCTV security, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-nagpur',
    pageName: 'Hostel in Nagpur',
    slug: 'hostels-in-nagpur',
    metaTitle: 'Best Hostels in Nagpur for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best student hostels in Nagpur with zero brokerage. Enjoy fully furnished rooms, Wi-Fi, nutritious meals, study areas, and 24/7 security.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-sikar',
    pageName: 'Hostel in Sikar',
    slug: 'hostels-in-sikar',
    metaTitle: 'Best Hostels in Sikar for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Sikar near Piprali Road coaching centres. Fully furnished rooms with healthy meals, Wi-Fi, study desks, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-bangalore',
    pageName: 'Hostel in Bangalore',
    slug: 'hostels-in-bangalore',
    metaTitle: 'Best Hostels in Bangalore | Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Bangalore for students and professionals. Furnished rooms with high-speed Wi-Fi, food, daily cleaning, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-pune',
    pageName: 'Hostel in Pune',
    slug: 'hostels-in-pune',
    metaTitle: 'Best Hostels in Pune for Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Pune for students and young pros near top colleges and IT hubs. Verified stays with meals, Wi-Fi, and zero brokerage on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'hostels-in-hyderabad',
    pageName: 'Hostel in Hyderabad',
    slug: 'hostels-in-hyderabad',
    metaTitle: 'Best Hostels in Hyderabad | Boys & Girls | Roomhy.com',
    metaDescription: 'Find the best hostels in Hyderabad for students and tech pros near HITEC City. Furnished rooms with food, Wi-Fi, security, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },

  {
    pageKey: 'co-living-in-kota',
    pageName: 'Co-Living Spaces in Kota',
    slug: 'co-living-in-kota',
    metaTitle: 'Best Co-Living Spaces in Kota | Roomhy.com',
    metaDescription: 'Find the best student co-living spaces in Kota near top coaching hubs. Fully furnished shared stays with Wi-Fi, food, housekeeping, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-jaipur',
    pageName: 'Co-Living Spaces in Jaipur',
    slug: 'co-living-in-jaipur',
    metaTitle: 'Best Co-Living Spaces in Jaipur | Roomhy.com',
    metaDescription: 'Find modern co-living spaces in Jaipur for students and pros. Fully furnished rooms with high-speed Wi-Fi, daily meals, cleaning, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-delhi',
    pageName: 'Co-Living Spaces in Delhi',
    slug: 'co-living-in-delhi',
    metaTitle: 'Best Co-Living Spaces in Delhi | Roomhy.com',
    metaDescription: 'Find premium co-living spaces in Delhi near top universities and metro hubs. Furnished rooms with Wi-Fi, meals, modern amenities, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-indore',
    pageName: 'Co-Living Spaces in Indore',
    slug: 'co-living-in-indore',
    metaTitle: 'Best Co-Living Spaces in Indore | Roomhy.com',
    metaDescription: 'Discover modern co-living spaces in Indore near Vijay Nagar and tech hubs. Fully furnished rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.com.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-bhopal',
    pageName: 'Co-Living Spaces in Bhopal',
    slug: 'co-living-in-bhopal',
    metaTitle: 'Best Co-Living Spaces in Bhopal | Roomhy.com',
    metaDescription: 'Find top verified co-living spaces in Bhopal for students and professionals. Enjoy furnished rooms, Wi-Fi, meals, 24/7 security, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-nagpur',
    pageName: 'Co-Living Spaces in Nagpur',
    slug: 'co-living-in-nagpur',
    metaTitle: 'Best Co-Living Spaces in Nagpur | Roomhy.com',
    metaDescription: 'Explore premium co-living spaces in Nagpur with zero brokerage. Fully furnished rooms with high-speed Wi-Fi, homemade meals, and community living.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-sikar',
    pageName: 'Co-Living Spaces in Sikar',
    slug: 'co-living-in-sikar',
    metaTitle: 'Best Co-Living Spaces in Sikar | Roomhy.com',
    metaDescription: 'Find modern co-living spaces in Sikar near Piprali Road coaching centres. Fully furnished stays with meals, Wi-Fi, study spaces, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-bangalore',
    pageName: 'Co-Living Spaces in Bangalore',
    slug: 'co-living-in-bangalore',
    metaTitle: 'Best Co-Living Spaces in Bangalore | Roomhy.com',
    metaDescription: 'Find premium co-living spaces in Bangalore near tech parks and colleges. Fully furnished rooms with high-speed Wi-Fi, housekeeping, and 0% brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-pune',
    pageName: 'Co-Living Spaces in Pune',
    slug: 'co-living-in-pune',
    metaTitle: 'Best Co-Living Spaces in Pune | Roomhy.com',
    metaDescription: 'Find modern co-living spaces in Pune for students and IT professionals. Fully furnished rooms with Wi-Fi, housekeeping, meals, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },
  {
    pageKey: 'co-living-in-hyderabad',
    pageName: 'Co-Living Spaces in Hyderabad',
    slug: 'co-living-in-hyderabad',
    metaTitle: 'Best Co-Living Spaces in Hyderabad | Roomhy.com',
    metaDescription: 'Find verified co-living spaces in Hyderabad near HITEC City and Gachibowli. Fully furnished stays with Wi-Fi, food, housekeeping, and zero brokerage.',
    robots: 'index, follow',
    isIndexed: true,
    sitemapPriority: 0.9,
    sitemapChangefreq: 'daily'
  },

  // --- Specific Locality Pages ---
  // Kota
  { pageKey: 'pg-in-talwandi-kota', pageName: 'PG in Talwandi Kota', slug: 'pg-in-talwandi-kota', metaTitle: 'Best PG in Talwandi for Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Talwandi, Kota for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-talwandi-kota', pageName: 'Hostel in Talwandi Kota', slug: 'hostels-in-talwandi-kota', metaTitle: 'Best Hostels in Talwandi for Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Talwandi, Kota for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-talwandi-kota', pageName: 'Co-Living in Talwandi Kota', slug: 'co-living-in-talwandi-kota', metaTitle: 'Best Co-Living in Talwandi | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Talwandi, Kota for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-vigyan-nagar-kota', pageName: 'PG in Vigyan Nagar Kota', slug: 'pg-in-vigyan-nagar-kota', metaTitle: 'Best PG in Vigyan Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Vigyan Nagar, Kota for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-vigyan-nagar-kota', pageName: 'Hostel in Vigyan Nagar Kota', slug: 'hostels-in-vigyan-nagar-kota', metaTitle: 'Best Hostels in Vigyan Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Vigyan Nagar, Kota for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-vigyan-nagar-kota', pageName: 'Co-Living in Vigyan Nagar Kota', slug: 'co-living-in-vigyan-nagar-kota', metaTitle: 'Best Co-Living in Vigyan Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Vigyan Nagar, Kota for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-landmark-city-kota', pageName: 'PG in Landmark City Kota', slug: 'pg-in-landmark-city-kota', metaTitle: 'Best PG in Landmark City | Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Landmark City, Kota for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-landmark-city-kota', pageName: 'Hostel in Landmark City Kota', slug: 'hostels-in-landmark-city-kota', metaTitle: 'Best Hostels in Landmark City | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Landmark City, Kota for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-landmark-city-kota', pageName: 'Co-Living in Landmark City Kota', slug: 'co-living-in-landmark-city-kota', metaTitle: 'Best Co-Living in Landmark City | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Landmark City, Kota for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-mahaveer-nagar-kota', pageName: 'PG in Mahaveer Nagar Kota', slug: 'pg-in-mahaveer-nagar-kota', metaTitle: 'Best PG in Mahaveer Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Mahaveer Nagar, Kota for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-mahaveer-nagar-kota', pageName: 'Hostel in Mahaveer Nagar Kota', slug: 'hostels-in-mahaveer-nagar-kota', metaTitle: 'Best Hostels in Mahaveer Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Mahaveer Nagar, Kota for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-mahaveer-nagar-kota', pageName: 'Co-Living in Mahaveer Nagar Kota', slug: 'co-living-in-mahaveer-nagar-kota', metaTitle: 'Best Co-Living in Mahaveer Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Mahaveer Nagar, Kota for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-indra-vihar-kota', pageName: 'PG in Indra Vihar Kota', slug: 'pg-in-indra-vihar-kota', metaTitle: 'Best PG in Indra Vihar for Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Indra Vihar, Kota for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-indra-vihar-kota', pageName: 'Hostel in Indra Vihar Kota', slug: 'hostels-in-indra-vihar-kota', metaTitle: 'Best Hostels in Indra Vihar | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Indra Vihar, Kota for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-indra-vihar-kota', pageName: 'Co-Living in Indra Vihar Kota', slug: 'co-living-in-indra-vihar-kota', metaTitle: 'Best Co-Living in Indra Vihar | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Indra Vihar, Kota for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Jaipur
  { pageKey: 'pg-in-malviya-nagar-jaipur', pageName: 'PG in Malviya Nagar Jaipur', slug: 'pg-in-malviya-nagar-jaipur', metaTitle: 'Best PG in Malviya Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Malviya Nagar, Jaipur for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-malviya-nagar-jaipur', pageName: 'Hostel in Malviya Nagar Jaipur', slug: 'hostels-in-malviya-nagar-jaipur', metaTitle: 'Best Hostels in Malviya Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Malviya Nagar, Jaipur for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-malviya-nagar-jaipur', pageName: 'Co-Living in Malviya Nagar Jaipur', slug: 'co-living-in-malviya-nagar-jaipur', metaTitle: 'Best Co-Living in Malviya Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Malviya Nagar, Jaipur for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-vaishali-nagar-jaipur', pageName: 'PG in Vaishali Nagar Jaipur', slug: 'pg-in-vaishali-nagar-jaipur', metaTitle: 'Best PG in Vaishali Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Vaishali Nagar, Jaipur for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-vaishali-nagar-jaipur', pageName: 'Hostel in Vaishali Nagar Jaipur', slug: 'hostels-in-vaishali-nagar-jaipur', metaTitle: 'Best Hostels in Vaishali Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Vaishali Nagar, Jaipur for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-vaishali-nagar-jaipur', pageName: 'Co-Living in Vaishali Nagar Jaipur', slug: 'co-living-in-vaishali-nagar-jaipur', metaTitle: 'Best Co-Living in Vaishali Nagar | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Vaishali Nagar, Jaipur for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-mansarovar-jaipur', pageName: 'PG in Mansarovar Jaipur', slug: 'pg-in-mansarovar-jaipur', metaTitle: 'Best PG in Mansarovar for Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Mansarovar, Jaipur for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-mansarovar-jaipur', pageName: 'Hostel in Mansarovar Jaipur', slug: 'hostels-in-mansarovar-jaipur', metaTitle: 'Best Hostels in Mansarovar | Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in Mansarovar, Jaipur for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-mansarovar-jaipur', pageName: 'Co-Living in Mansarovar Jaipur', slug: 'co-living-in-mansarovar-jaipur', metaTitle: 'Best Co-Living in Mansarovar | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in Mansarovar, Jaipur for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-c-scheme-jaipur', pageName: 'PG in C Scheme Jaipur', slug: 'pg-in-c-scheme-jaipur', metaTitle: 'Best PG in C-Scheme for Boys & Girls | Roomhy', metaDescription: 'Find the best PG in C-Scheme, Jaipur for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-c-scheme-jaipur', pageName: 'Hostel in C Scheme Jaipur', slug: 'hostels-in-c-scheme-jaipur', metaTitle: 'Best Hostels in C-Scheme for Boys & Girls | Roomhy', metaDescription: 'Find the best hostels in C-Scheme, Jaipur for boys and girls. Verified student stays with meals, Wi-Fi, study desks, security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-c-scheme-jaipur', pageName: 'Co-Living in C Scheme Jaipur', slug: 'co-living-in-c-scheme-jaipur', metaTitle: 'Best Co-Living in C-Scheme | Boys & Girls | Roomhy', metaDescription: 'Find the best co-living spaces in C-Scheme, Jaipur for boys and girls. Fully furnished shared rooms with high-speed Wi-Fi, meals, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-tonk-road-jaipur', pageName: 'PG in Tonk Road Jaipur', slug: 'pg-in-tonk-road-jaipur', metaTitle: 'Best PG in Tonk Road for Boys & Girls | Roomhy', metaDescription: 'Find the best PG in Tonk Road, Jaipur for boys and girls. Enjoy fully furnished rooms with food, Wi-Fi, 24/7 security, and 0% brokerage on Roomhy.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-tonk-road-jaipur', pageName: 'Hostel in Tonk Road Jaipur', slug: 'hostels-in-tonk-road-jaipur', metaTitle: 'Hostels in Tonk Road Jaipur | Roomhy.com', metaDescription: 'Find the best hostels in tonk road jaipur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-tonk-road-jaipur', pageName: 'Co-Living in Tonk Road Jaipur', slug: 'co-living-in-tonk-road-jaipur', metaTitle: 'Co-living in Tonk Road Jaipur | Roomhy.com', metaDescription: 'Find the best co-living in tonk road jaipur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Delhi
  { pageKey: 'pg-in-kamla-nagar-delhi', pageName: 'PG in Kamla Nagar Delhi', slug: 'pg-in-kamla-nagar-delhi', metaTitle: 'PG in Kamla Nagar Delhi | Roomhy.com', metaDescription: 'Find the best pg in kamla nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-kamla-nagar-delhi', pageName: 'Hostel in Kamla Nagar Delhi', slug: 'hostels-in-kamla-nagar-delhi', metaTitle: 'Hostels in Kamla Nagar Delhi | Roomhy.com', metaDescription: 'Find the best hostels in kamla nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-kamla-nagar-delhi', pageName: 'Co-Living in Kamla Nagar Delhi', slug: 'co-living-in-kamla-nagar-delhi', metaTitle: 'Co-living in Kamla Nagar Delhi | Roomhy.com', metaDescription: 'Find the best co-living in kamla nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-lajpat-nagar-delhi', pageName: 'PG in Lajpat Nagar Delhi', slug: 'pg-in-lajpat-nagar-delhi', metaTitle: 'PG in Lajpat Nagar Delhi | Roomhy.com', metaDescription: 'Find the best pg in lajpat nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-lajpat-nagar-delhi', pageName: 'Hostel in Lajpat Nagar Delhi', slug: 'hostels-in-lajpat-nagar-delhi', metaTitle: 'Hostels in Lajpat Nagar Delhi | Roomhy.com', metaDescription: 'Find the best hostels in lajpat nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-lajpat-nagar-delhi', pageName: 'Co-Living in Lajpat Nagar Delhi', slug: 'co-living-in-lajpat-nagar-delhi', metaTitle: 'Co-living in Lajpat Nagar Delhi | Roomhy.com', metaDescription: 'Find the best co-living in lajpat nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-mukherjee-nagar-delhi', pageName: 'PG in Mukherjee Nagar Delhi', slug: 'pg-in-mukherjee-nagar-delhi', metaTitle: 'PG in Mukherjee Nagar Delhi | Roomhy.com', metaDescription: 'Find the best pg in mukherjee nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-mukherjee-nagar-delhi', pageName: 'Hostel in Mukherjee Nagar Delhi', slug: 'hostels-in-mukherjee-nagar-delhi', metaTitle: 'Hostels in Mukherjee Nagar Delhi | Roomhy.com', metaDescription: 'Find the best hostels in mukherjee nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-mukherjee-nagar-delhi', pageName: 'Co-Living in Mukherjee Nagar Delhi', slug: 'co-living-in-mukherjee-nagar-delhi', metaTitle: 'Co-living in Mukherjee Nagar Delhi | Roomhy.com', metaDescription: 'Find the best co-living in mukherjee nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-laxmi-nagar-delhi', pageName: 'PG in Laxmi Nagar Delhi', slug: 'pg-in-laxmi-nagar-delhi', metaTitle: 'PG in Laxmi Nagar Delhi | Roomhy.com', metaDescription: 'Find the best pg in laxmi nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-laxmi-nagar-delhi', pageName: 'Hostel in Laxmi Nagar Delhi', slug: 'hostels-in-laxmi-nagar-delhi', metaTitle: 'Hostels in Laxmi Nagar Delhi | Roomhy.com', metaDescription: 'Find the best hostels in laxmi nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-laxmi-nagar-delhi', pageName: 'Co-Living in Laxmi Nagar Delhi', slug: 'co-living-in-laxmi-nagar-delhi', metaTitle: 'Co-living in Laxmi Nagar Delhi | Roomhy.com', metaDescription: 'Find the best co-living in laxmi nagar delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-rohini-delhi', pageName: 'PG in Rohini Delhi', slug: 'pg-in-rohini-delhi', metaTitle: 'PG in Rohini Delhi | Roomhy.com', metaDescription: 'Find the best pg in rohini delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-rohini-delhi', pageName: 'Hostel in Rohini Delhi', slug: 'hostels-in-rohini-delhi', metaTitle: 'Hostels in Rohini Delhi | Roomhy.com', metaDescription: 'Find the best hostels in rohini delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-rohini-delhi', pageName: 'Co-Living in Rohini Delhi', slug: 'co-living-in-rohini-delhi', metaTitle: 'Co-living in Rohini Delhi | Roomhy.com', metaDescription: 'Find the best co-living in rohini delhi with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Indore
  { pageKey: 'pg-in-vijay-nagar-indore', pageName: 'PG in Vijay Nagar Indore', slug: 'pg-in-vijay-nagar-indore', metaTitle: 'PG in Vijay Nagar Indore | Roomhy.com', metaDescription: 'Find the best pg in vijay nagar indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-vijay-nagar-indore', pageName: 'Hostel in Vijay Nagar Indore', slug: 'hostels-in-vijay-nagar-indore', metaTitle: 'Hostels in Vijay Nagar Indore | Roomhy.com', metaDescription: 'Find the best hostels in vijay nagar indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-vijay-nagar-indore', pageName: 'Co-Living in Vijay Nagar Indore', slug: 'co-living-in-vijay-nagar-indore', metaTitle: 'Co-living in Vijay Nagar Indore | Roomhy.com', metaDescription: 'Find the best co-living in vijay nagar indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-bhawarkua-indore', pageName: 'PG in Bhawarkua Indore', slug: 'pg-in-bhawarkua-indore', metaTitle: 'PG in Bhawarkua Indore | Roomhy.com', metaDescription: 'Find the best pg in bhawarkua indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-bhawarkua-indore', pageName: 'Hostel in Bhawarkua Indore', slug: 'hostels-in-bhawarkua-indore', metaTitle: 'Hostels in Bhawarkua Indore | Roomhy.com', metaDescription: 'Find the best hostels in bhawarkua indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-bhawarkua-indore', pageName: 'Co-Living in Bhawarkua Indore', slug: 'co-living-in-bhawarkua-indore', metaTitle: 'Co-living in Bhawarkua Indore | Roomhy.com', metaDescription: 'Find the best co-living in bhawarkua indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-rau-indore', pageName: 'PG in Rau Indore', slug: 'pg-in-rau-indore', metaTitle: 'PG in Rau Indore | Roomhy.com', metaDescription: 'Find the best pg in rau indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-rau-indore', pageName: 'Hostel in Rau Indore', slug: 'hostels-in-rau-indore', metaTitle: 'Hostels in Rau Indore | Roomhy.com', metaDescription: 'Find the best hostels in rau indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-rau-indore', pageName: 'Co-Living in Rau Indore', slug: 'co-living-in-rau-indore', metaTitle: 'Co-living in Rau Indore | Roomhy.com', metaDescription: 'Find the best co-living in rau indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-palasia-indore', pageName: 'PG in Palasia Indore', slug: 'pg-in-palasia-indore', metaTitle: 'PG in Palasia Indore | Roomhy.com', metaDescription: 'Find the best pg in palasia indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-palasia-indore', pageName: 'Hostel in Palasia Indore', slug: 'hostels-in-palasia-indore', metaTitle: 'Hostels in Palasia Indore | Roomhy.com', metaDescription: 'Find the best hostels in palasia indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-palasia-indore', pageName: 'Co-Living in Palasia Indore', slug: 'co-living-in-palasia-indore', metaTitle: 'Co-living in Palasia Indore | Roomhy.com', metaDescription: 'Find the best co-living in palasia indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-annapurna-road-indore', pageName: 'PG in Annapurna Road Indore', slug: 'pg-in-annapurna-road-indore', metaTitle: 'PG in Annapurna Road Indore | Roomhy.com', metaDescription: 'Find the best pg in annapurna road indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-annapurna-road-indore', pageName: 'Hostel in Annapurna Road Indore', slug: 'hostels-in-annapurna-road-indore', metaTitle: 'Hostels in Annapurna Road Indore | Roomhy.com', metaDescription: 'Find the best hostels in annapurna road indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-annapurna-road-indore', pageName: 'Co-Living in Annapurna Road Indore', slug: 'co-living-in-annapurna-road-indore', metaTitle: 'Co-living in Annapurna Road Indore | Roomhy.com', metaDescription: 'Find the best co-living in annapurna road indore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Bhopal
  { pageKey: 'pg-in-mp-nagar-bhopal', pageName: 'PG in MP Nagar Bhopal', slug: 'pg-in-mp-nagar-bhopal', metaTitle: 'PG in MP Nagar Bhopal | Roomhy.com', metaDescription: 'Find the best pg in mp nagar bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-mp-nagar-bhopal', pageName: 'Hostel in MP Nagar Bhopal', slug: 'hostels-in-mp-nagar-bhopal', metaTitle: 'Hostels in MP Nagar Bhopal | Roomhy.com', metaDescription: 'Find the best hostels in mp nagar bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-mp-nagar-bhopal', pageName: 'Co-Living in MP Nagar Bhopal', slug: 'co-living-in-mp-nagar-bhopal', metaTitle: 'Co-living in MP Nagar Bhopal | Roomhy.com', metaDescription: 'Find the best co-living in mp nagar bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-kolar-road-bhopal', pageName: 'PG in Kolar Road Bhopal', slug: 'pg-in-kolar-road-bhopal', metaTitle: 'PG in Kolar Road Bhopal | Roomhy.com', metaDescription: 'Find the best pg in kolar road bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-kolar-road-bhopal', pageName: 'Hostel in Kolar Road Bhopal', slug: 'hostels-in-kolar-road-bhopal', metaTitle: 'Hostels in Kolar Road Bhopal | Roomhy.com', metaDescription: 'Find the best hostels in kolar road bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-kolar-road-bhopal', pageName: 'Co-Living in Kolar Road Bhopal', slug: 'co-living-in-kolar-road-bhopal', metaTitle: 'Co-living in Kolar Road Bhopal | Roomhy.com', metaDescription: 'Find the best co-living in kolar road bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-arera-colony-bhopal', pageName: 'PG in Arera Colony Bhopal', slug: 'pg-in-arera-colony-bhopal', metaTitle: 'PG in Arera Colony Bhopal | Roomhy.com', metaDescription: 'Find the best pg in arera colony bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-arera-colony-bhopal', pageName: 'Hostel in Arera Colony Bhopal', slug: 'hostels-in-arera-colony-bhopal', metaTitle: 'Hostels in Arera Colony Bhopal | Roomhy.com', metaDescription: 'Find the best hostels in arera colony bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-arera-colony-bhopal', pageName: 'Co-Living in Arera Colony Bhopal', slug: 'co-living-in-arera-colony-bhopal', metaTitle: 'Co-living in Arera Colony Bhopal | Roomhy.com', metaDescription: 'Find the best co-living in arera colony bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-shahpura-bhopal', pageName: 'PG in Shahpura Bhopal', slug: 'pg-in-shahpura-bhopal', metaTitle: 'PG in Shahpura Bhopal | Roomhy.com', metaDescription: 'Find the best pg in shahpura bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-shahpura-bhopal', pageName: 'Hostel in Shahpura Bhopal', slug: 'hostels-in-shahpura-bhopal', metaTitle: 'Hostels in Shahpura Bhopal | Roomhy.com', metaDescription: 'Find the best hostels in shahpura bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-shahpura-bhopal', pageName: 'Co-Living in Shahpura Bhopal', slug: 'co-living-in-shahpura-bhopal', metaTitle: 'Co-living in Shahpura Bhopal | Roomhy.com', metaDescription: 'Find the best co-living in shahpura bhopal with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Nagpur
  { pageKey: 'pg-in-ramdaspeth-nagpur', pageName: 'PG in Ramdaspeth Nagpur', slug: 'pg-in-ramdaspeth-nagpur', metaTitle: 'PG in Ramdaspeth Nagpur | Roomhy.com', metaDescription: 'Find the best pg in ramdaspeth nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-ramdaspeth-nagpur', pageName: 'Hostel in Ramdaspeth Nagpur', slug: 'hostels-in-ramdaspeth-nagpur', metaTitle: 'Hostels in Ramdaspeth Nagpur | Roomhy.com', metaDescription: 'Find the best hostels in ramdaspeth nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-ramdaspeth-nagpur', pageName: 'Co-Living in Ramdaspeth Nagpur', slug: 'co-living-in-ramdaspeth-nagpur', metaTitle: 'Co-living in Ramdaspeth Nagpur | Roomhy.com', metaDescription: 'Find the best co-living in ramdaspeth nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-sadar-nagpur', pageName: 'PG in Sadar Nagpur', slug: 'pg-in-sadar-nagpur', metaTitle: 'PG in Sadar Nagpur | Roomhy.com', metaDescription: 'Find the best pg in sadar nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-sadar-nagpur', pageName: 'Hostel in Sadar Nagpur', slug: 'hostels-in-sadar-nagpur', metaTitle: 'Hostels in Sadar Nagpur | Roomhy.com', metaDescription: 'Find the best hostels in sadar nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-sadar-nagpur', pageName: 'Co-Living in Sadar Nagpur', slug: 'co-living-in-sadar-nagpur', metaTitle: 'Co-living in Sadar Nagpur | Roomhy.com', metaDescription: 'Find the best co-living in sadar nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-dharampeth-nagpur', pageName: 'PG in Dharampeth Nagpur', slug: 'pg-in-dharampeth-nagpur', metaTitle: 'PG in Dharampeth Nagpur | Roomhy.com', metaDescription: 'Find the best pg in dharampeth nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-dharampeth-nagpur', pageName: 'Hostel in Dharampeth Nagpur', slug: 'hostels-in-dharampeth-nagpur', metaTitle: 'Hostels in Dharampeth Nagpur | Roomhy.com', metaDescription: 'Find the best hostels in dharampeth nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-dharampeth-nagpur', pageName: 'Co-Living in Dharampeth Nagpur', slug: 'co-living-in-dharampeth-nagpur', metaTitle: 'Co-living in Dharampeth Nagpur | Roomhy.com', metaDescription: 'Find the best co-living in dharampeth nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-manish-nagar-nagpur', pageName: 'PG in Manish Nagar Nagpur', slug: 'pg-in-manish-nagar-nagpur', metaTitle: 'PG in Manish Nagar Nagpur | Roomhy.com', metaDescription: 'Find the best pg in manish nagar nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-manish-nagar-nagpur', pageName: 'Hostel in Manish Nagar Nagpur', slug: 'hostels-in-manish-nagar-nagpur', metaTitle: 'Hostels in Manish Nagar Nagpur | Roomhy.com', metaDescription: 'Find the best hostels in manish nagar nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-manish-nagar-nagpur', pageName: 'Co-Living in Manish Nagar Nagpur', slug: 'co-living-in-manish-nagar-nagpur', metaTitle: 'Co-living in Manish Nagar Nagpur | Roomhy.com', metaDescription: 'Find the best co-living in manish nagar nagpur with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Sikar
  { pageKey: 'pg-in-piprali-road-sikar', pageName: 'PG in Piprali Road Sikar', slug: 'pg-in-piprali-road-sikar', metaTitle: 'PG in Piprali Road Sikar | Roomhy.com', metaDescription: 'Find the best pg in piprali road sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-piprali-road-sikar', pageName: 'Hostel in Piprali Road Sikar', slug: 'hostels-in-piprali-road-sikar', metaTitle: 'Hostels in Piprali Road Sikar | Roomhy.com', metaDescription: 'Find the best hostels in piprali road sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-piprali-road-sikar', pageName: 'Co-Living in Piprali Road Sikar', slug: 'co-living-in-piprali-road-sikar', metaTitle: 'Co-living in Piprali Road Sikar | Roomhy.com', metaDescription: 'Find the best co-living in piprali road sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-station-road-sikar', pageName: 'PG in Station Road Sikar', slug: 'pg-in-station-road-sikar', metaTitle: 'PG in Station Road Sikar | Roomhy.com', metaDescription: 'Find the best pg in station road sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-station-road-sikar', pageName: 'Hostel in Station Road Sikar', slug: 'hostels-in-station-road-sikar', metaTitle: 'Hostels in Station Road Sikar | Roomhy.com', metaDescription: 'Find the best hostels in station road sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-station-road-sikar', pageName: 'Co-Living in Station Road Sikar', slug: 'co-living-in-station-road-sikar', metaTitle: 'Co-living in Station Road Sikar | Roomhy.com', metaDescription: 'Find the best co-living in station road sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-gandhi-nagar-sikar', pageName: 'PG in Gandhi Nagar Sikar', slug: 'pg-in-gandhi-nagar-sikar', metaTitle: 'PG in Gandhi Nagar Sikar | Roomhy.com', metaDescription: 'Find the best pg in gandhi nagar sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-gandhi-nagar-sikar', pageName: 'Hostel in Gandhi Nagar Sikar', slug: 'hostels-in-gandhi-nagar-sikar', metaTitle: 'Hostels in Gandhi Nagar Sikar | Roomhy.com', metaDescription: 'Find the best hostels in gandhi nagar sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-gandhi-nagar-sikar', pageName: 'Co-Living in Gandhi Nagar Sikar', slug: 'co-living-in-gandhi-nagar-sikar', metaTitle: 'Co-living in Gandhi Nagar Sikar | Roomhy.com', metaDescription: 'Find the best co-living in gandhi nagar sikar with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Bangalore
  { pageKey: 'pg-in-btm-layout-bangalore', pageName: 'PG in BTM Layout Bangalore', slug: 'pg-in-btm-layout-bangalore', metaTitle: 'PG in BTM Layout Bangalore | Roomhy.com', metaDescription: 'Find the best pg in btm layout bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-btm-layout-bangalore', pageName: 'Hostel in BTM Layout Bangalore', slug: 'hostels-in-btm-layout-bangalore', metaTitle: 'Hostels in BTM Layout Bangalore | Roomhy.com', metaDescription: 'Find the best hostels in btm layout bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-btm-layout-bangalore', pageName: 'Co-Living in BTM Layout Bangalore', slug: 'co-living-in-btm-layout-bangalore', metaTitle: 'Co-living in BTM Layout Bangalore | Roomhy.com', metaDescription: 'Find the best co-living in btm layout bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-koramangala-bangalore', pageName: 'PG in Koramangala Bangalore', slug: 'pg-in-koramangala-bangalore', metaTitle: 'PG in Koramangala Bangalore | Roomhy.com', metaDescription: 'Find the best pg in koramangala bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-koramangala-bangalore', pageName: 'Hostel in Koramangala Bangalore', slug: 'hostels-in-koramangala-bangalore', metaTitle: 'Hostels in Koramangala Bangalore | Roomhy.com', metaDescription: 'Find the best hostels in koramangala bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-koramangala-bangalore', pageName: 'Co-Living in Koramangala Bangalore', slug: 'co-living-in-koramangala-bangalore', metaTitle: 'Co-living in Koramangala Bangalore | Roomhy.com', metaDescription: 'Find the best co-living in koramangala bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-hsr-layout-bangalore', pageName: 'PG in HSR Layout Bangalore', slug: 'pg-in-hsr-layout-bangalore', metaTitle: 'PG in HSR Layout Bangalore | Roomhy.com', metaDescription: 'Find the best pg in hsr layout bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-hsr-layout-bangalore', pageName: 'Hostel in HSR Layout Bangalore', slug: 'hostels-in-hsr-layout-bangalore', metaTitle: 'Hostels in HSR Layout Bangalore | Roomhy.com', metaDescription: 'Find the best hostels in hsr layout bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-hsr-layout-bangalore', pageName: 'Co-Living in HSR Layout Bangalore', slug: 'co-living-in-hsr-layout-bangalore', metaTitle: 'Co-living in HSR Layout Bangalore | Roomhy.com', metaDescription: 'Find the best co-living in hsr layout bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-electronic-city-bangalore', pageName: 'PG in Electronic City Bangalore', slug: 'pg-in-electronic-city-bangalore', metaTitle: 'PG in Electronic City Bangalore | Roomhy.com', metaDescription: 'Find the best pg in electronic city bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-electronic-city-bangalore', pageName: 'Hostel in Electronic City Bangalore', slug: 'hostels-in-electronic-city-bangalore', metaTitle: 'Hostels in Electronic City Bangalore | Roomhy.com', metaDescription: 'Find the best hostels in electronic city bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-electronic-city-bangalore', pageName: 'Co-Living in Electronic City Bangalore', slug: 'co-living-in-electronic-city-bangalore', metaTitle: 'Co-living in Electronic City Bangalore | Roomhy.com', metaDescription: 'Find the best co-living in electronic city bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-marathahalli-bangalore', pageName: 'PG in Marathahalli Bangalore', slug: 'pg-in-marathahalli-bangalore', metaTitle: 'PG in Marathahalli Bangalore | Roomhy.com', metaDescription: 'Find the best pg in marathahalli bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-marathahalli-bangalore', pageName: 'Hostel in Marathahalli Bangalore', slug: 'hostels-in-marathahalli-bangalore', metaTitle: 'Hostels in Marathahalli Bangalore | Roomhy.com', metaDescription: 'Find the best hostels in marathahalli bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-marathahalli-bangalore', pageName: 'Co-Living in Marathahalli Bangalore', slug: 'co-living-in-marathahalli-bangalore', metaTitle: 'Co-living in Marathahalli Bangalore | Roomhy.com', metaDescription: 'Find the best co-living in marathahalli bangalore with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Pune
  { pageKey: 'pg-in-kothrud-pune', pageName: 'PG in Kothrud Pune', slug: 'pg-in-kothrud-pune', metaTitle: 'PG in Kothrud Pune | Roomhy.com', metaDescription: 'Find the best pg in kothrud pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-kothrud-pune', pageName: 'Hostel in Kothrud Pune', slug: 'hostels-in-kothrud-pune', metaTitle: 'Hostels in Kothrud Pune | Roomhy.com', metaDescription: 'Find the best hostels in kothrud pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-kothrud-pune', pageName: 'Co-Living in Kothrud Pune', slug: 'co-living-in-kothrud-pune', metaTitle: 'Co-living in Kothrud Pune | Roomhy.com', metaDescription: 'Find the best co-living in kothrud pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-hinjewadi-pune', pageName: 'PG in Hinjewadi Pune', slug: 'pg-in-hinjewadi-pune', metaTitle: 'PG in Hinjewadi Pune | Roomhy.com', metaDescription: 'Find the best pg in hinjewadi pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-hinjewadi-pune', pageName: 'Hostel in Hinjewadi Pune', slug: 'hostels-in-hinjewadi-pune', metaTitle: 'Hostels in Hinjewadi Pune | Roomhy.com', metaDescription: 'Find the best hostels in hinjewadi pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-hinjewadi-pune', pageName: 'Co-Living in Hinjewadi Pune', slug: 'co-living-in-hinjewadi-pune', metaTitle: 'Co-living in Hinjewadi Pune | Roomhy.com', metaDescription: 'Find the best co-living in hinjewadi pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-viman-nagar-pune', pageName: 'PG in Viman Nagar Pune', slug: 'pg-in-viman-nagar-pune', metaTitle: 'PG in Viman Nagar Pune | Roomhy.com', metaDescription: 'Find the best pg in viman nagar pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-viman-nagar-pune', pageName: 'Hostel in Viman Nagar Pune', slug: 'hostels-in-viman-nagar-pune', metaTitle: 'Hostels in Viman Nagar Pune | Roomhy.com', metaDescription: 'Find the best hostels in viman nagar pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-viman-nagar-pune', pageName: 'Co-Living in Viman Nagar Pune', slug: 'co-living-in-viman-nagar-pune', metaTitle: 'Co-living in Viman Nagar Pune | Roomhy.com', metaDescription: 'Find the best co-living in viman nagar pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-wakad-pune', pageName: 'PG in Wakad Pune', slug: 'pg-in-wakad-pune', metaTitle: 'PG in Wakad Pune | Roomhy.com', metaDescription: 'Find the best pg in wakad pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-wakad-pune', pageName: 'Hostel in Wakad Pune', slug: 'hostels-in-wakad-pune', metaTitle: 'Hostels in Wakad Pune | Roomhy.com', metaDescription: 'Find the best hostels in wakad pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-wakad-pune', pageName: 'Co-Living in Wakad Pune', slug: 'co-living-in-wakad-pune', metaTitle: 'Co-living in Wakad Pune | Roomhy.com', metaDescription: 'Find the best co-living in wakad pune with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  // Hyderabad
  { pageKey: 'pg-in-gachibowli-hyderabad', pageName: 'PG in Gachibowli Hyderabad', slug: 'pg-in-gachibowli-hyderabad', metaTitle: 'PG in Gachibowli Hyderabad | Roomhy.com', metaDescription: 'Find the best pg in gachibowli hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-gachibowli-hyderabad', pageName: 'Hostel in Gachibowli Hyderabad', slug: 'hostels-in-gachibowli-hyderabad', metaTitle: 'Hostels in Gachibowli Hyderabad | Roomhy.com', metaDescription: 'Find the best hostels in gachibowli hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-gachibowli-hyderabad', pageName: 'Co-Living in Gachibowli Hyderabad', slug: 'co-living-in-gachibowli-hyderabad', metaTitle: 'Co-living in Gachibowli Hyderabad | Roomhy.com', metaDescription: 'Find the best co-living in gachibowli hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-ameerpet-hyderabad', pageName: 'PG in Ameerpet Hyderabad', slug: 'pg-in-ameerpet-hyderabad', metaTitle: 'PG in Ameerpet Hyderabad | Roomhy.com', metaDescription: 'Find the best pg in ameerpet hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-ameerpet-hyderabad', pageName: 'Hostel in Ameerpet Hyderabad', slug: 'hostels-in-ameerpet-hyderabad', metaTitle: 'Hostels in Ameerpet Hyderabad | Roomhy.com', metaDescription: 'Find the best hostels in ameerpet hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-ameerpet-hyderabad', pageName: 'Co-Living in Ameerpet Hyderabad', slug: 'co-living-in-ameerpet-hyderabad', metaTitle: 'Co-living in Ameerpet Hyderabad | Roomhy.com', metaDescription: 'Find the best co-living in ameerpet hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-kukatpally-hyderabad', pageName: 'PG in Kukatpally Hyderabad', slug: 'pg-in-kukatpally-hyderabad', metaTitle: 'PG in Kukatpally Hyderabad | Roomhy.com', metaDescription: 'Find the best pg in kukatpally hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-kukatpally-hyderabad', pageName: 'Hostel in Kukatpally Hyderabad', slug: 'hostels-in-kukatpally-hyderabad', metaTitle: 'Hostels in Kukatpally Hyderabad | Roomhy.com', metaDescription: 'Find the best hostels in kukatpally hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-kukatpally-hyderabad', pageName: 'Co-Living in Kukatpally Hyderabad', slug: 'co-living-in-kukatpally-hyderabad', metaTitle: 'Co-living in Kukatpally Hyderabad | Roomhy.com', metaDescription: 'Find the best co-living in kukatpally hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },

  { pageKey: 'pg-in-madhapur-hyderabad', pageName: 'PG in Madhapur Hyderabad', slug: 'pg-in-madhapur-hyderabad', metaTitle: 'PG in Madhapur Hyderabad | Roomhy.com', metaDescription: 'Find the best pg in madhapur hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'hostels-in-madhapur-hyderabad', pageName: 'Hostel in Madhapur Hyderabad', slug: 'hostels-in-madhapur-hyderabad', metaTitle: 'Hostels in Madhapur Hyderabad | Roomhy.com', metaDescription: 'Find the best hostels in madhapur hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' },
  { pageKey: 'co-living-in-madhapur-hyderabad', pageName: 'Co-Living in Madhapur Hyderabad', slug: 'co-living-in-madhapur-hyderabad', metaTitle: 'Co-living in Madhapur Hyderabad | Roomhy.com', metaDescription: 'Find the best co-living in madhapur hyderabad with furnished rooms, modern amenities and convenient locations. Explore verified options on Roomhy.com.', robots: 'index, follow', isIndexed: true, sitemapPriority: 0.85, sitemapChangefreq: 'weekly' }
];

const staticKeywordsMap = {
  'home': 'PG, Hostels, Co-living, Student Housing, PG in India, hostels in India, coliving spaces, room rent, shared accommodation, student PG, zero brokerage PG, rental rooms',
  'about': 'about Roomhy, student housing platform, broker free PG platform, roomhy story, student living India, verified PG portal, coliving company India, rental housing platform, zero brokerage accommodation, student PG finder',
  'contact': 'Roomhy contact number, Roomhy customer care, student housing support, PG booking support, Roomhy helpline, roomhy office address, hostel inquiry, PG customer care, contact roomhy, student stay support',
  'list-property': 'list PG for free, list hostel online, property owner listing, rent PG to students, list coliving space, free property listing site, student accommodation listing, rent room to students, PG owner portal, list room online',
  'login': 'Roomhy login, PG tenant login, student housing login, owner dashboard login, roomhy portal login, PG booking login, sign in roomhy, landlord login, hostel management login, roomhy account',
  'register': 'Roomhy registration, sign up roomhy, create PG account, tenant signup, student housing registration, owner registration, register on roomhy, PG booking register, coliving signup, join roomhy',
  'blogs': 'student housing blog, PG tips and guide, hostel vs PG guide, student living tips, Kota PG guide, rent breakdown blog, student accommodation tips, coliving guide, roommate advice, college living guide',
  'privacy': 'Roomhy privacy policy, user data protection, privacy terms, roomhy terms, student data security, booking privacy policy, user agreement privacy, data privacy policy, portal terms',
  'terms': 'Roomhy terms and conditions, user agreement, PG booking rules, cancellation policy, refund terms, platform usage terms, rental agreement terms, tenant guidelines, owner rules, roomhy legal',

  'pg-main': 'PG in India, paying guest, student PG, boys PG, girls PG, luxury PG, single room PG, double sharing PG, PG with food, broker free PG, verified PG, student accommodation',
  'hostels-main': 'hostels in India, student hostels, boys hostel, girls hostel, budget hostels, working professional hostel, AC hostel, hostel with food, student stay, low cost hostel, verified hostels, secure hostel',
  'co-living-main': 'coliving in India, coliving spaces, shared living spaces, luxury coliving, student coliving, coliving with food, furnished coliving rooms, modern coliving, community living, shared apartments, premium coliving, broker free coliving',

  'properties-in-kota': 'PG in Kota, hostels in Kota, student accommodation Kota, rooms in Kota, flats in Kota, boys PG Kota, girls hostel Kota, Allen coaching PG Kota, Landmark City PG, Talwandi Kota PG, Vigyan Nagar PG, broker free Kota PG',
  'properties-in-jaipur': 'PG in Jaipur, hostels in Jaipur, flats in Jaipur, student rooms Jaipur, boys PG Jaipur, girls PG Jaipur, coliving Jaipur, Malviya Nagar PG, Vaishali Nagar PG, Mansarovar Jaipur PG, student accommodation Jaipur, rental flats Jaipur',
  'properties-in-delhi': 'PG in Delhi, hostels in Delhi, flats in Delhi, student rooms Delhi, boys PG Delhi, girls PG Delhi, DU student PG, North Campus PG, South Campus PG, Laxmi Nagar PG, Kamla Nagar PG, coliving Delhi',
  'properties-in-indore': 'PG in Indore, hostels in Indore, flats in Indore, student accommodation Indore, boys PG Indore, girls PG Indore, Bhawarkua PG, Vijay Nagar Indore PG, coliving Indore, rental rooms Indore, student flats Indore, broker free Indore PG',
  'properties-in-bhopal': 'PG in Bhopal, hostels in Bhopal, flats in Bhopal, student rooms Bhopal, boys PG Bhopal, girls PG Bhopal, MP Nagar Bhopal PG, Arera Colony PG, coliving Bhopal, student accommodation Bhopal, rental flats Bhopal, rooms in Bhopal',
  'properties-in-nagpur': 'PG in Nagpur, hostels in Nagpur, flats in Nagpur, student accommodation Nagpur, boys PG Nagpur, girls PG Nagpur, Dharampeth PG, Ramdaspeth PG, coliving Nagpur, rental rooms Nagpur, student flats Nagpur, broker free Nagpur PG',
  'properties-in-sikar': 'PG in Sikar, hostels in Sikar, student rooms Sikar, Piprali Road PG Sikar, coaching PG Sikar, boys PG Sikar, girls hostel Sikar, student accommodation Sikar, Station Road Sikar PG, rooms in Sikar, budget hostel Sikar, broker free Sikar PG',
  'properties-in-bangalore': 'PG in Bangalore, coliving Bangalore, hostels in Bangalore, flats in Bangalore, boys PG Bangalore, girls PG Bangalore, Koramangala PG, BTM Layout PG, HSR Layout PG, Electronic City PG, student accommodation Bangalore, IT coliving Bangalore',
  'properties-in-pune': 'PG in Pune, coliving Pune, hostels in Pune, flats in Pune, boys PG Pune, girls PG Pune, Hinjewadi PG, Kothrud PG, Viman Nagar PG, Wakad PG, student accommodation Pune, IT professional coliving Pune',
  'properties-in-hyderabad': 'PG in Hyderabad, coliving Hyderabad, hostels in Hyderabad, flats in Hyderabad, boys PG Hyderabad, girls PG Hyderabad, Gachibowli PG, HITEC City coliving, Madhapur PG, Kukatpally PG, student accommodation Hyderabad, IT coliving Hyderabad',

  // City-level PG pages
  'pg-in-kota': 'PG in Kota, hostels in Kota, student accommodation Kota, rooms in Kota, flats in Kota, boys PG Kota, girls hostel Kota, Allen coaching PG Kota, Landmark City PG, Talwandi Kota PG, Vigyan Nagar PG, broker free Kota PG',
  'pg-in-jaipur': 'PG in Jaipur, hostels in Jaipur, student accommodation Jaipur, paying guest Jaipur, boys PG Jaipur, girls PG Jaipur, student PG Jaipur, single room PG Jaipur, PG with food Jaipur, affordable PG Jaipur, verified PG Jaipur, broker free PG Jaipur',
  'pg-in-delhi': 'PG in Delhi, hostels in Delhi, student accommodation Delhi, paying guest Delhi, boys PG Delhi, girls PG Delhi, student PG Delhi, single room PG Delhi, PG with food Delhi, affordable PG Delhi, DU student PG, broker free PG Delhi',
  'pg-in-indore': 'PG in Indore, hostels in Indore, student accommodation Indore, paying guest Indore, boys PG Indore, girls PG Indore, student PG Indore, single room PG Indore, PG with food Indore, affordable PG Indore, verified PG Indore, broker free PG Indore',
  'pg-in-bhopal': 'PG in Bhopal, hostels in Bhopal, student accommodation Bhopal, paying guest Bhopal, boys PG Bhopal, girls PG Bhopal, student PG Bhopal, single room PG Bhopal, PG with food Bhopal, affordable PG Bhopal, verified PG Bhopal, broker free PG Bhopal',
  'pg-in-nagpur': 'PG in Nagpur, hostels in Nagpur, student accommodation Nagpur, paying guest Nagpur, boys PG Nagpur, girls PG Nagpur, student PG Nagpur, single room PG Nagpur, PG with food Nagpur, affordable PG Nagpur, verified PG Nagpur, broker free PG Nagpur',
  'pg-in-sikar': 'PG in Sikar, hostels in Sikar, student accommodation Sikar, paying guest Sikar, boys PG Sikar, girls PG Sikar, Piprali Road PG Sikar, coaching PG Sikar, PG near coaching Sikar, affordable PG Sikar, verified PG Sikar, broker free PG Sikar',
  'pg-in-bangalore': 'PG in Bangalore, hostels in Bangalore, student accommodation Bangalore, paying guest Bangalore, boys PG Bangalore, girls PG Bangalore, IT professional PG Bangalore, Koramangala PG, HSR Layout PG, affordable PG Bangalore, verified PG Bangalore, broker free PG Bangalore',
  'pg-in-pune': 'PG in Pune, hostels in Pune, student accommodation Pune, paying guest Pune, boys PG Pune, girls PG Pune, IT professional PG Pune, Hinjewadi PG, Viman Nagar PG, affordable PG Pune, verified PG Pune, broker free PG Pune',
  'pg-in-hyderabad': 'PG in Hyderabad, hostels in Hyderabad, student accommodation Hyderabad, paying guest Hyderabad, boys PG Hyderabad, girls PG Hyderabad, HITEC City PG, Gachibowli PG, IT professional PG Hyderabad, affordable PG Hyderabad, verified PG Hyderabad, broker free PG Hyderabad',

  // City-level Hostel pages
  'hostels-in-kota': 'hostels in Kota, student hostels Kota, boys hostel Kota, girls hostel Kota, Allen coaching hostel Kota, Resonance hostel Kota, Talwandi hostel, Vigyan Nagar hostel, affordable hostel Kota, verified hostel Kota, hostel with food Kota, broker free hostel Kota',
  'hostels-in-jaipur': 'hostels in Jaipur, student hostels Jaipur, boys hostel Jaipur, girls hostel Jaipur, affordable hostel Jaipur, verified hostel Jaipur, hostel with food Jaipur, single room hostel Jaipur, student accommodation Jaipur, hostel near college Jaipur, budget hostel Jaipur, broker free hostel Jaipur',
  'hostels-in-delhi': 'hostels in Delhi, student hostels Delhi, boys hostel Delhi, girls hostel Delhi, affordable hostel Delhi, DU hostel Delhi, verified hostel Delhi, hostel with food Delhi, single room hostel Delhi, student accommodation Delhi, budget hostel Delhi, broker free hostel Delhi',
  'hostels-in-indore': 'hostels in Indore, student hostels Indore, boys hostel Indore, girls hostel Indore, affordable hostel Indore, verified hostel Indore, hostel with food Indore, single room hostel Indore, student accommodation Indore, Bhawarkua hostel Indore, budget hostel Indore, broker free hostel Indore',
  'hostels-in-bhopal': 'hostels in Bhopal, student hostels Bhopal, boys hostel Bhopal, girls hostel Bhopal, affordable hostel Bhopal, verified hostel Bhopal, hostel with food Bhopal, single room hostel Bhopal, student accommodation Bhopal, MP Nagar hostel, budget hostel Bhopal, broker free hostel Bhopal',
  'hostels-in-nagpur': 'hostels in Nagpur, student hostels Nagpur, boys hostel Nagpur, girls hostel Nagpur, affordable hostel Nagpur, verified hostel Nagpur, hostel with food Nagpur, single room hostel Nagpur, student accommodation Nagpur, Ramdaspeth hostel, budget hostel Nagpur, broker free hostel Nagpur',
  'hostels-in-sikar': 'hostels in Sikar, student hostels Sikar, boys hostel Sikar, girls hostel Sikar, coaching hostel Sikar, Piprali Road hostel Sikar, affordable hostel Sikar, verified hostel Sikar, hostel with food Sikar, student accommodation Sikar, budget hostel Sikar, broker free hostel Sikar',
  'hostels-in-bangalore': 'hostels in Bangalore, student hostels Bangalore, boys hostel Bangalore, girls hostel Bangalore, IT hostel Bangalore, affordable hostel Bangalore, verified hostel Bangalore, hostel with food Bangalore, Koramangala hostel, HSR Layout hostel, budget hostel Bangalore, broker free hostel Bangalore',
  'hostels-in-pune': 'hostels in Pune, student hostels Pune, boys hostel Pune, girls hostel Pune, IT hostel Pune, affordable hostel Pune, verified hostel Pune, hostel with food Pune, Hinjewadi hostel, Viman Nagar hostel, budget hostel Pune, broker free hostel Pune',
  'hostels-in-hyderabad': 'hostels in Hyderabad, student hostels Hyderabad, boys hostel Hyderabad, girls hostel Hyderabad, IT hostel Hyderabad, affordable hostel Hyderabad, HITEC City hostel, Gachibowli hostel, verified hostel Hyderabad, hostel with food Hyderabad, budget hostel Hyderabad, broker free hostel Hyderabad',

  // City-level Co-living pages
  'co-living-in-kota': 'coliving in Kota, co living Kota, shared accommodation Kota, student coliving Kota, furnished coliving Kota, coliving with food Kota, affordable coliving Kota, luxury coliving Kota, Talwandi coliving, Vigyan Nagar coliving, broker free coliving Kota, community living Kota',
  'co-living-in-jaipur': 'coliving in Jaipur, co living Jaipur, shared accommodation Jaipur, student coliving Jaipur, furnished coliving Jaipur, coliving with food Jaipur, affordable coliving Jaipur, luxury coliving Jaipur, Malviya Nagar coliving, Vaishali Nagar coliving, broker free coliving Jaipur, community living Jaipur',
  'co-living-in-delhi': 'coliving in Delhi, co living Delhi, shared accommodation Delhi, student coliving Delhi, furnished coliving Delhi, coliving with food Delhi, affordable coliving Delhi, luxury coliving Delhi, Kamla Nagar coliving, Laxmi Nagar coliving, broker free coliving Delhi, community living Delhi',
  'co-living-in-indore': 'coliving in Indore, co living Indore, shared accommodation Indore, student coliving Indore, furnished coliving Indore, coliving with food Indore, affordable coliving Indore, luxury coliving Indore, Vijay Nagar coliving, Bhawarkua coliving, broker free coliving Indore, community living Indore',
  'co-living-in-bhopal': 'coliving in Bhopal, co living Bhopal, shared accommodation Bhopal, student coliving Bhopal, furnished coliving Bhopal, coliving with food Bhopal, affordable coliving Bhopal, luxury coliving Bhopal, MP Nagar coliving, Arera Colony coliving, broker free coliving Bhopal, community living Bhopal',
  'co-living-in-nagpur': 'coliving in Nagpur, co living Nagpur, shared accommodation Nagpur, student coliving Nagpur, furnished coliving Nagpur, coliving with food Nagpur, affordable coliving Nagpur, luxury coliving Nagpur, Ramdaspeth coliving, Dharampeth coliving, broker free coliving Nagpur, community living Nagpur',
  'co-living-in-sikar': 'coliving in Sikar, co living Sikar, shared accommodation Sikar, student coliving Sikar, furnished coliving Sikar, coliving with food Sikar, affordable coliving Sikar, Piprali Road coliving, coaching hub coliving Sikar, verified coliving Sikar, broker free coliving Sikar, community living Sikar',
  'co-living-in-bangalore': 'coliving in Bangalore, co living Bangalore, shared accommodation Bangalore, IT coliving Bangalore, furnished coliving Bangalore, coliving with food Bangalore, affordable coliving Bangalore, luxury coliving Bangalore, Koramangala coliving, HSR Layout coliving, broker free coliving Bangalore, community living Bangalore',
  'co-living-in-pune': 'coliving in Pune, co living Pune, shared accommodation Pune, IT coliving Pune, furnished coliving Pune, coliving with food Pune, affordable coliving Pune, luxury coliving Pune, Hinjewadi coliving, Viman Nagar coliving, broker free coliving Pune, community living Pune',
  'co-living-in-hyderabad': 'coliving in Hyderabad, co living Hyderabad, shared accommodation Hyderabad, IT coliving Hyderabad, furnished coliving Hyderabad, coliving with food Hyderabad, affordable coliving Hyderabad, luxury coliving Hyderabad, Gachibowli coliving, HITEC City coliving, broker free coliving Hyderabad, community living Hyderabad',

  'pg-cities': 'PG cities in India, best cities for PG, student PG cities, PG in Kota, PG in Delhi, PG in Bangalore, PG in Pune, PG in Jaipur, PG in Indore, PG in Hyderabad, student housing cities, top PG locations',
  'pg-localities': 'PG localities in India, top student localities, best PG areas, Talwandi Kota PG, Koramangala PG, North Campus PG, Bhawarkua Indore PG, Piprali Road PG, Hinjewadi Pune PG, student areas India, top coaching PG localities, coliving localities',
  'hostels-cities': 'hostel cities in India, best cities for hostels, student hostels India, hostels in Kota, hostels in Delhi, hostels in Jaipur, hostels in Indore, hostels in Sikar, hostels in Bangalore, budget hostel cities, student accommodation cities, top hostel locations',
  'hostels-localities': 'hostel localities in India, best student hostel areas, top coaching hostel areas, Talwandi hostels, Landmark City hostels, Piprali Road hostels, Kamla Nagar hostels, Vijay Nagar hostels, student hostel hubs, affordable hostel localities, girls hostel areas, boys hostel areas',
  'co-living-cities': 'coliving cities in India, best cities for coliving, coliving Bangalore, coliving Pune, coliving Hyderabad, coliving Delhi, coliving Jaipur, coliving Indore, top shared living cities, IT coliving cities, modern coliving hubs, student coliving cities',
  'co-living-localities': 'coliving localities in India, best coliving areas, Koramangala coliving, HSR Layout coliving, Gachibowli coliving, Hinjewadi coliving, Viman Nagar coliving, Malviya Nagar coliving, shared living localities, premium coliving areas, student coliving hubs, tech park coliving'
};

function generateLocalityKeywords(slug, pageName) {
    if (!slug) return '';
    const knownCities = ['kota', 'jaipur', 'delhi', 'indore', 'bhopal', 'nagpur', 'sikar', 'bangalore', 'pune', 'hyderabad'];
    const lowerSlug = slug.toLowerCase();
    const cityKey = knownCities.find(c => lowerSlug.endsWith('-' + c));
    if (!cityKey) return '';

    const city = cityKey.charAt(0).toUpperCase() + cityKey.slice(1);
    let areaSlug = '';
    let type = '';

    if (lowerSlug.startsWith('pg-in-')) {
        type = 'pg';
        areaSlug = lowerSlug.slice(6, lowerSlug.length - cityKey.length - 1);
    } else if (lowerSlug.startsWith('hostels-in-')) {
        type = 'hostels';
        areaSlug = lowerSlug.slice(11, lowerSlug.length - cityKey.length - 1);
    } else if (lowerSlug.startsWith('co-living-in-')) {
        type = 'coliving';
        areaSlug = lowerSlug.slice(13, lowerSlug.length - cityKey.length - 1);
    }

    if (!areaSlug) return '';
    const area = areaSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    if (type === 'pg') {
        return `PG in ${area} ${city}, best PG in ${area} ${city}, PG in ${area}, paying guest in ${area} ${city}, student PG in ${area}, boys PG in ${area}, girls PG in ${area}, single room PG ${area}, PG in ${area} with food, affordable PG in ${area} ${city}, verified PG in ${area}, broker free PG in ${area}`;
    } else if (type === 'hostels') {
        return `Hostels in ${area} ${city}, best hostels in ${area} ${city}, hostel in ${area}, student hostel in ${area} ${city}, boys hostel in ${area}, girls hostel in ${area}, affordable hostel in ${area}, hostel in ${area} with food, single room hostel in ${area}, verified hostels in ${area}, student accommodation in ${area}, broker free hostel in ${area}`;
    } else if (type === 'coliving') {
        return `Co-living in ${area} ${city}, best coliving in ${area} ${city}, co living space in ${area}, coliving in ${area} ${city}, shared accommodation in ${area}, student co living in ${area}, affordable co living in ${area}, luxury coliving ${area} ${city}, furnished coliving in ${area}, coliving spaces in ${area}, coliving with food in ${area}, shared living ${area} ${city}`;
    }
    return '';
}

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
        const metaKeywords = data.metaKeywords || staticKeywordsMap[data.pageKey] || generateLocalityKeywords(data.slug, data.pageName);
        const payload = {
            ...data,
            metaKeywords,
            canonicalUrl: data.canonicalUrl || canonicalUrl,
            openGraphTitle: data.metaTitle,
            openGraphDescription: data.metaDescription,
            twitterTitle: data.metaTitle,
            twitterDescription: data.metaDescription
        };

        // Match by pageKey if entityId is null, OR by clean slug
        const filter = data.slug !== undefined
            ? { slug: data.slug }
            : { pageKey: data.pageKey, entityId: null };

        await SeoPage.findOneAndUpdate(
            filter,
            { $set: payload },
            { upsert: true, new: true }
        );
        updatedCount++;
    }

    console.log(`\n✅ SEO update complete. Upserted ${updatedCount} pages in database.`);
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
}

updateSeo().catch(err => {
    console.error('❌ SEO update failed:', err);
    process.exit(1);
});
