/**
 * ============================================================
 * PARADISE RESIDENCY — Auto Add Script
 * Kota, Rajasthan | Owner: Dheeraj Kumar Nebhnani
 * ============================================================
 * Run: node scripts/add_paradise_residency.js
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const API_BASE       = process.env.API_BASE || 'http://localhost:5001';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'roomhyadmin@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@123';

const PHOTOS_DIR = path.join(__dirname, '../../Roomhy-Frontend/public/website/Dheeraj Sir');

const PROPERTY = {
  title:           'PARADISE RESIDENCY',
  propertyType:    'pg',
  propertyCategory:'PG / HOSTEL',
  address:         'D 39 Landmark City, Kota, Rajasthan',
  locality:        'Landmark City',
  city:            'Kota',
  state:           'Rajasthan',
  pincode:         '324005',
  contact: {
    name:   'Dheeraj Kumar Nebhnani',
    number: '9460982075',
    email:  'dheerajnebhnani133@gmail.com'
  },
  ownerName:   'Dheeraj Kumar Nebhnani',
  ownerPhone:  '9460982075',
  ownerEmail:  'dheerajnebhnani133@gmail.com',
  description: 'PARADISE RESIDENCY is a premium PG/Hostel in Landmark City, Kota, Rajasthan. Ideal for students and working professionals. Single sharing rooms with modern amenities. Safe, hygienic, and well-maintained property built in 2020.',
  gender:      'male',
  preferredTenant: ['Students', 'Professionals'],
  yearBuilt:   2020,
  monthlyRent: 7500,
  roomTypes: [
    {
      type:        'Single Sharing',
      desc:        'Private room for one person',
      totalRooms:  42,
      totalBeds:   42,
      occupancy:   1,
      pricePerBed: 7500,
      pricePerRoom:7500,
    }
  ],
  amenities: [
    'WiFi',
    'Power Backup',
    '24x7 Water',
    'CCTV',
    'Security Guard',
    'Study Table',
    'Wardrobe',
    'Bed with Mattress',
    'Geyser',
    'Attached Bathroom'
  ],
  policies: {
    smokingAllowed:  false,
    alcoholAllowed:  false,
    visitorsAllowed: false,
    cookingAllowed:  false,
    petsAllowed:     false,
    guestPolicy:     'No smoking, No alcohol, No visitors without prior permission.'
  },
  parking:         false,
  lift:            false,
  status:          'active',
  isLiveOnWebsite: true,
  isPublished:     true,
  seo: {
    title:       'Paradise Residency - PG in Kota Rajasthan | Roomhy',
    description: 'Best PG/Hostel for boys in Landmark City Kota. Single sharing rooms at Rs.7500/month. Ideal for students and professionals.',
    keywords:    'PG in Kota, boys hostel kota, Landmark City PG, paradise residency kota, student accommodation kota'
  }
};

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

async function apiPost(urlPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: { message: text } }; }
}

async function login() {
  log('Logging in as superadmin...');
  let r = await apiPost('/api/auth/login', { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }, null);
  if (r.ok && r.data.token) { log('Logged in!'); return r.data.token; }

  r = await apiPost('/api/auth/login', { loginId: ADMIN_EMAIL, identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }, null);
  if (r.ok && r.data.token) { log('Logged in!'); return r.data.token; }

  console.error('Login failed:', JSON.stringify(r.data));
  process.exit(1);
}

async function main() {
  console.log('');
  console.log('=======================================================');
  console.log('  PARADISE RESIDENCY - Roomhy Property Add Script');
  console.log('=======================================================');
  console.log('');

  const token    = await login();
  log('Creating property...');
  const r = await apiPost('/api/properties/add', PROPERTY, token);

  if (r.ok && r.data.success) {
    const p = r.data.property;
    log('');
    log('================================================');
    log('PROPERTY CREATED SUCCESSFULLY!');
    log('  ID     : ' + p._id);
    log('  Title  : ' + p.title);
    log('  City   : ' + p.city);
    log('  Status : ' + p.status);
    log('  Live   : ' + p.isLiveOnWebsite);
    log('================================================');
  } else {
    console.error('Failed:', JSON.stringify(r.data, null, 2));
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
