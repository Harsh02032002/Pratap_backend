'use strict';

/**
 * collegesQueueService.js
 * ───────────────────────
 * Throttled background queue service for Overpass API (OpenStreetMap).
 * Processes properties missing nearbyColleges slowly (1 property every 3.5 seconds)
 * to strictly prevent Overpass API 429 rate limit and timeout errors.
 * Caches fetched colleges permanently in MongoDB.
 */

const ApprovedProperty = require('../models/ApprovedProperty');
const Property = require('../models/Property');

// Haversine distance formula in kilometers
function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fetch nearby colleges for a single coordinate bounding box from Overpass API
async function fetchCollegesOverpassSingle(lat, lng) {
  const padding = 0.035; // ~3.5 km radius
  const south = lat - padding;
  const north = lat + padding;
  const west = lng - padding;
  const east = lng + padding;
  const bbox = `${south},${west},${north},${east}`;

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="college"](${bbox});
      node["amenity"="university"](${bbox});
      way["amenity"="college"](${bbox});
      way["amenity"="university"](${bbox});
    );
    out center tags 20;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn('⚠️ [CollegesQueue] Overpass API 429 Rate Limit - pausing queue 15s');
        await new Promise((r) => setTimeout(r, 15000));
      }
      return [];
    }

    const data = await response.json();
    const elements = data.elements || [];

    const colleges = elements
      .filter((el) => el.tags && el.tags.name)
      .map((el) => {
        const cLat = el.lat ?? el.center?.lat;
        const cLon = el.lon ?? el.center?.lon;
        const distance = cLat && cLon ? getHaversineDistance(lat, lng, cLat, cLon) : 99;
        return {
          name: el.tags.name,
          type: el.tags.amenity || 'college',
          lat: cLat,
          lon: cLon,
          distance: Math.round(distance * 100) / 100,
        };
      })
      .filter((c) => c.distance <= 4.0)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);

    // Deduplicate by name
    const uniqueMap = new Map();
    colleges.forEach((c) => {
      if (!uniqueMap.has(c.name.toLowerCase())) {
        uniqueMap.set(c.name.toLowerCase(), c);
      }
    });

    return Array.from(uniqueMap.values());
  } catch (err) {
    console.error('❌ [CollegesQueue] Overpass single fetch error:', err.message);
    return [];
  }
}

class CollegesQueueService {
  constructor() {
    this.queue = [];
    this.enqueuedSet = new Set();
    this.isProcessing = false;
    this.delayMs = 3500; // 3.5 seconds delay between properties
  }

  /**
   * Enqueue properties that are missing cached nearbyColleges
   */
  enqueueProperties(properties = []) {
    if (!Array.isArray(properties) || properties.length === 0) return;

    let addedCount = 0;
    for (const prop of properties) {
      if (!prop) continue;

      const propId = String(prop._id || prop.visitId || prop.id || '');
      if (!propId || this.enqueuedSet.has(propId)) continue;

      // Skip if property already has cached nearbyColleges in DB
      if (Array.isArray(prop.nearbyColleges) && prop.nearbyColleges.length > 0) {
        continue;
      }

      const lat =
        prop.latitude ||
        prop.propertyInfo?.location?.coordinates?.[1] ||
        prop.propertyInfo?.latitude;
      const lng =
        prop.longitude ||
        prop.propertyInfo?.location?.coordinates?.[0] ||
        prop.propertyInfo?.longitude;

      if (lat && lng && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
        this.enqueuedSet.add(propId);
        this.queue.push({
          id: propId,
          visitId: prop.visitId || propId,
          lat: Number(lat),
          lng: Number(lng),
          name: prop.property_name || prop.name || prop.propertyInfo?.name || 'Property',
        });
        addedCount++;
      }
    }

    if (addedCount > 0) {
      console.log(`🎓 [CollegesQueue] Enqueued ${addedCount} properties for slow Overpass fetching. Total queue size: ${this.queue.length}`);
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        console.log(`🔍 [CollegesQueue] Fetching colleges for "${item.name}" (${item.id}). Queue remaining: ${this.queue.length}`);
        const colleges = await fetchCollegesOverpassSingle(item.lat, item.lng);

        if (colleges && colleges.length > 0) {
          // Update ApprovedProperty in MongoDB
          await ApprovedProperty.updateOne(
            { $or: [{ _id: item.id }, { visitId: item.visitId }] },
            { $set: { nearbyColleges: colleges, collegesLastFetchedAt: new Date() } }
          );

          // Update Property in MongoDB if applicable
          await Property.updateOne(
            { $or: [{ _id: item.id }, { visitId: item.visitId }] },
            { $set: { nearbyColleges: colleges, collegesLastFetchedAt: new Date() } }
          );

          console.log(`✅ [CollegesQueue] Cached ${colleges.length} nearby colleges for "${item.name}"`);
        } else {
          console.log(`ℹ️ [CollegesQueue] No colleges found near "${item.name}"`);
        }
      } catch (err) {
        console.error(`❌ [CollegesQueue] Error processing item ${item.id}:`, err.message);
      }

      // Respect Overpass API rate limits with 3.5s delay
      if (this.queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
    }

    this.isProcessing = false;
  }
}

const collegesQueue = new CollegesQueueService();
module.exports = collegesQueue;
