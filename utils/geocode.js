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
        'User-Agent': 'Roohmy-Backend/1.0 (hello@roomhy.com)',
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

module.exports = { geocodeAddress };
