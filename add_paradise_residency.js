/**
 * ============================================================
 * PARADISE RESIDENCY — Auto Add Script
 * Kota, Rajasthan | Owner: Dheeraj Kumar Nebhnani
 * ============================================================
 * Run from Backend root directory:
 *   node add_paradise_residency.js
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────
const API_BASE       = process.env.API_BASE || 'http://localhost:5001';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'roomhyadmin@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@123';

const PHOTOS_DIR = path.join(__dirname, '../Roomhy-Frontend/public/website/Dheeraj Sir');

// ─── PROPERTY DATA ───────────────────────────────────────────
const PROPERTY = {
  title:           'PARADISE RESIDENCY',
  propertyType:    'hostel',
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
    { name: 'WiFi', icon: 'wifi', category: 'basic' },
    { name: 'Power Backup', icon: 'zap', category: 'basic' },
    { name: '24x7 Water', icon: 'droplets', category: 'basic' },
    { name: 'CCTV', icon: 'shield', category: 'basic' },
    { name: 'Security Guard', icon: 'shield', category: 'basic' },
    { name: 'Study Table', icon: 'home', category: 'basic' },
    { name: 'Wardrobe', icon: 'home', category: 'basic' },
    { name: 'Bed with Mattress', icon: 'bed', category: 'basic' },
    { name: 'Geyser', icon: 'zap', category: 'basic' },
    { name: 'Attached Bathroom', icon: 'home', category: 'basic' }
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

  // Fallback try with loginId
  r = await apiPost('/api/auth/login', { loginId: ADMIN_EMAIL, identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }, null);
  if (r.ok && r.data.token) { log('Logged in!'); return r.data.token; }

  console.error('Login failed:', JSON.stringify(r.data));
  process.exit(1);
}

async function uploadPhotos(token) {
  if (!fs.existsSync(PHOTOS_DIR)) {
    log('Photos folder not found: ' + PHOTOS_DIR);
    log('Continuing with property creation...');
    return [];
  }

  const files = fs.readdirSync(PHOTOS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  if (files.length === 0) { log('No photos found.'); return []; }

  log('Found ' + files.length + ' photos. Uploading...');
  const urls = [];

  for (const fileName of files) {
    const filePath = path.join(PHOTOS_DIR, fileName);
    try {
      const buffer = fs.readFileSync(filePath);
      const blob = new Blob([buffer], { type: 'image/jpeg' });
      const formData = new FormData();
      formData.append('file', blob, fileName);

      const res = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const data = await res.json();
      const url = data.url || data.imageUrl || data.path || data.fileUrl || null;
      if (url) { urls.push(url); log('  Uploaded: ' + fileName); }
      else { log('  Uploaded attempt result: ' + JSON.stringify(data).slice(0, 100)); }
    } catch (err) {
      log('  Upload note for ' + fileName + ': ' + err.message);
    }
  }

  log('Photos uploaded: ' + urls.length);
  return urls;
}

async function addProperty(token, imageUrls) {
  log('Creating property...');
  const payload = { ...PROPERTY, images: imageUrls, featuredImage: imageUrls[0] || '' };
  const r = await apiPost('/api/properties/add', payload, token);

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
    log('  Photos : ' + imageUrls.length);
    log('================================================');
    return p;
  } else {
    console.error('Failed:', JSON.stringify(r.data, null, 2));
    process.exit(1);
  }
}

async function main() {
  console.log('');
  console.log('=======================================================');
  console.log('  PARADISE RESIDENCY - Roomhy Property Add Script');
  console.log('=======================================================');
  console.log('');

  const token    = await login();
  const images   = await uploadPhotos(token);
  const property = await addProperty(token, images);

  log('DONE! Property added & live!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
