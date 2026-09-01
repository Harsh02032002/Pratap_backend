const https = require('https');
const http = require('http');

/**
 * Convert address string to latitude & longitude using Nominatim (OpenStreetMap)
 * @param {string} address - Full address string
 * @returns {Promise<{latitude: number, longitude: number}>}
 */
async function geocodeAddress(address) {
  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    throw new Error('Address is required for geocoding');
  }

  const encoded = encodeURIComponent(address.trim());
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&limit=1`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Roohmy-Backend/1.0 (team@roomhy.com)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results && results.length > 0) {
            resolve({
              latitude: parseFloat(results[0].lat),
              longitude: parseFloat(results[0].lon),
              displayName: results[0].display_name
            });
          } else {
            reject(new Error(`No geocoding results found for: "${address}"`));
          }
        } catch (err) {
          reject(new Error('Failed to parse geocoding response'));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Geocoding request failed: ${err.message}`));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Geocoding request timed out'));
    });
  });
}

/**
 * Reverse-geocode a coordinate to a human-readable place.
 *
 * Used by the visit-report live camera, which stamps the place name onto the
 * photo as proof of where it was taken. Runs server-side on purpose:
 *
 *  • Nominatim's usage policy requires an identifying User-Agent and caps
 *    callers at ~1 request/second. Calling it straight from every employee's
 *    browser would breach both and risk the whole origin being blocked.
 *  • A cache only helps if it is shared, and a browser cache is not.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<{placeName:string, shortName:string, displayName:string, address:object}>}
 */

// Coordinates are rounded to ~11m before they become a cache key. Two photos
// taken while walking around one building must not each cost a Nominatim call,
// and the answer at that scale is the same place either way.
const REVERSE_CACHE_PRECISION = 4;
const REVERSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REVERSE_CACHE_MAX = 500;
const reverseCache = new Map();

// Nominatim asks for at most 1 request per second across a whole application.
// Requests queue behind this rather than going out in parallel.
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimCallAt = 0;
let nominatimQueue = Promise.resolve();

const cacheKey = (lat, lon) =>
  `${lat.toFixed(REVERSE_CACHE_PRECISION)},${lon.toFixed(REVERSE_CACHE_PRECISION)}`;

/**
 * Build the short label that goes on the photo.
 *
 * Nominatim's display_name is the full postal chain ("Shop 4, MG Road, Ward 12,
 * Sikar, Rajasthan, 332001, India") which is far too long to read burned into
 * a corner of an image. This picks the parts a person would actually say.
 */
function buildPlaceLabel(address = {}, displayName = '') {
  const locality =
    address.suburb || address.neighbourhood || address.village ||
    address.town || address.city_district || address.county || '';
  const city = address.city || address.town || address.village || address.state_district || '';
  const spot = address.amenity || address.building || address.shop || address.road || '';

  const parts = [];
  if (spot) parts.push(spot);
  if (locality && locality !== spot) parts.push(locality);
  if (city && city !== locality && city !== spot) parts.push(city);

  const short = parts.slice(0, 3).join(', ');
  return short || displayName.split(',').slice(0, 3).join(',').trim() || 'Unknown location';
}

function requestReverse(latitude, longitude) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}` +
    `&zoom=18&addressdetails=1`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Roohmy-Backend/1.0 (team@roomhy.com)',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result && (result.display_name || result.address)) {
            const address = result.address || {};
            resolve({
              placeName: buildPlaceLabel(address, result.display_name || ''),
              displayName: result.display_name || '',
              address
            });
          } else {
            reject(new Error(result?.error || 'No place found for these coordinates'));
          }
        } catch (_) {
          reject(new Error('Failed to parse reverse geocoding response'));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Reverse geocoding failed: ${err.message}`)));

    // Under the 10s request deadline (config/timeouts.js) so this fails inside
    // the request's budget and the caller can answer, rather than the deadline
    // firing first. 6s proved too tight — an uncached Nominatim lookup timed
    // out on first use and succeeded instantly on retry — and 8s still leaves
    // room for the 1.1s rate-limit wait ahead of it.
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Reverse geocoding request timed out'));
    });
  });
}

/** Great-circle distance in km. Used to sanity-check a fix against the property. */
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Forward lookups are dominated by a handful of repeating city names, so they
// cache hard and effectively never hit the network twice.
const cityCache = new Map();

/**
 * Where is this city, roughly? Returns null rather than throwing — a failed
 * cross-check must never be able to block a capture.
 */
async function locateCity(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (cityCache.has(key)) return cityCache.get(key);
  try {
    const { latitude, longitude } = await geocodeAddress(`${key}, India`);
    const value = { latitude, longitude };
    cityCache.set(key, value);
    return value;
  } catch (_) {
    cityCache.set(key, null);
    return null;
  }
}

async function reverseGeocode(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Valid latitude and longitude are required');
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error('Coordinates out of range');
  }

  const key = cacheKey(lat, lon);
  const hit = reverseCache.get(key);
  if (hit && Date.now() - hit.at < REVERSE_CACHE_TTL_MS) return hit.value;

  // Serialise onto the queue so concurrent callers cannot exceed Nominatim's rate.
  const run = nominatimQueue.then(async () => {
    const cached = reverseCache.get(key);
    if (cached && Date.now() - cached.at < REVERSE_CACHE_TTL_MS) return cached.value;

    const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatimCallAt = Date.now();

    const value = await requestReverse(lat, lon);

    if (reverseCache.size >= REVERSE_CACHE_MAX) {
      reverseCache.delete(reverseCache.keys().next().value);
    }
    reverseCache.set(key, { at: Date.now(), value });
    return value;
  });

  // A failure must not poison the queue for the next caller.
  nominatimQueue = run.then(() => undefined, () => undefined);
  return run;
}

module.exports = { geocodeAddress, reverseGeocode, locateCity, distanceKm };
