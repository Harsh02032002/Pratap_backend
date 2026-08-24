const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const mongoose = require('mongoose');
const ApprovedProperty = require('./models/ApprovedProperty');

const seedPropertiesData = [
  // KOTA PROPERTIES
  {
    visitId: "SEED_KOTA_01",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Boys PG - Talwandi",
      city: "Kota",
      area: "Talwandi",
      address: "Sector 2, Talwandi, Kota, Rajasthan 324005",
      rent: 8000,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000001",
      description: "Premium Boys PG in Talwandi Kota near major coaching centers with food and WiFi."
    }
  },
  {
    visitId: "SEED_KOTA_02",
    propertyCategory: "Hostel",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Girls Hostel - Talwandi",
      city: "Kota",
      area: "Talwandi",
      address: "Talwandi Main Road, Kota, Rajasthan 324005",
      rent: 9500,
      propertyType: "Hostel",
      genderSuitability: "female",
      bedCount: 3,
      photos: ["https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000002",
      description: "Safe & Secure Girls Hostel in Talwandi with 24/7 warden and CCTV."
    }
  },
  {
    visitId: "SEED_KOTA_03",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/271618/pexels-photo-271618.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/271618/pexels-photo-271618.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Student Living - Vigyan Nagar",
      city: "Kota",
      area: "Vigyan Nagar",
      address: "Vigyan Nagar, Kota, Rajasthan 324005",
      rent: 7500,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/271618/pexels-photo-271618.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000003"
    }
  },
  {
    visitId: "SEED_KOTA_04",
    propertyCategory: "Co-living",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Allen Residency - Landmark City",
      city: "Kota",
      area: "Landmark City",
      address: "Landmark City, Kunhari, Kota, Rajasthan 324008",
      rent: 11000,
      propertyType: "Co-living",
      genderSuitability: "co-ed",
      bedCount: 4,
      photos: ["https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000004"
    }
  },
  {
    visitId: "SEED_KOTA_05",
    propertyCategory: "Co-living",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/2062426/pexels-photo-2062426.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/2062426/pexels-photo-2062426.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Co-Living Hub - Mahaveer Nagar",
      city: "Kota",
      area: "Mahaveer Nagar",
      address: "Mahaveer Nagar 1st, Kota, Rajasthan 324005",
      rent: 8500,
      propertyType: "Co-living",
      genderSuitability: "co-ed",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/2062426/pexels-photo-2062426.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000005"
    }
  },
  {
    visitId: "SEED_KOTA_06",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Girls PG - Indra Vihar",
      city: "Kota",
      area: "Indra Vihar",
      address: "Indra Vihar, Kota, Rajasthan 324005",
      rent: 9000,
      propertyType: "PG",
      genderSuitability: "female",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/279719/pexels-photo-279719.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000006"
    }
  },
  {
    visitId: "SEED_KOTA_07",
    propertyCategory: "Hostel",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1743229/pexels-photo-1743229.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1743229/pexels-photo-1743229.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Riverfront Hostel - Kunhari",
      city: "Kota",
      area: "Kunhari",
      address: "Kunhari, Kota, Rajasthan 324008",
      rent: 7000,
      propertyType: "Hostel",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1743229/pexels-photo-1743229.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000007"
    }
  },

  // INDORE PROPERTIES
  {
    visitId: "SEED_INDORE_01",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Luxury PG - Sapna Sangeeta",
      city: "Indore",
      area: "Sapna Sangeeta",
      address: "Sapna Sangeeta Road, Indore, Madhya Pradesh 452001",
      rent: 8500,
      propertyType: "PG",
      genderSuitability: "co-ed",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000021"
    }
  },
  {
    visitId: "SEED_INDORE_02",
    propertyCategory: "Hostel",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Girls Hostel - Vijay Nagar",
      city: "Indore",
      area: "Vijay Nagar",
      address: "Vijay Nagar, Indore, Madhya Pradesh 452010",
      rent: 10000,
      propertyType: "Hostel",
      genderSuitability: "female",
      bedCount: 3,
      photos: ["https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000022"
    }
  },
  {
    visitId: "SEED_INDORE_03",
    propertyCategory: "Co-living",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Prime Co-living - Palasia",
      city: "Indore",
      area: "Palasia",
      address: "Old Palasia, Indore, Madhya Pradesh 452001",
      rent: 12000,
      propertyType: "Co-living",
      genderSuitability: "co-ed",
      bedCount: 3,
      photos: ["https://images.pexels.com/photos/276724/pexels-photo-276724.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000023"
    }
  },
  {
    visitId: "SEED_INDORE_04",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/164595/pexels-photo-164595.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/164595/pexels-photo-164595.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Student PG - Bhawarkua",
      city: "Indore",
      area: "Bhawarkua",
      address: "Bhawarkua Main Square, Indore, Madhya Pradesh 452001",
      rent: 7000,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/164595/pexels-photo-164595.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000024"
    }
  },

  // JAIPUR PROPERTIES
  {
    visitId: "SEED_JAIPUR_01",
    propertyCategory: "Co-living",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Co-living - Malviya Nagar",
      city: "Jaipur",
      area: "Malviya Nagar",
      address: "Malviya Nagar, Jaipur, Rajasthan 302017",
      rent: 12000,
      propertyType: "Co-living",
      genderSuitability: "co-ed",
      bedCount: 3,
      photos: ["https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000031"
    }
  },
  {
    visitId: "SEED_JAIPUR_02",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/271618/pexels-photo-271618.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/271618/pexels-photo-271618.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Executive PG - Vaishali Nagar",
      city: "Jaipur",
      area: "Vaishali Nagar",
      address: "Vaishali Nagar, Jaipur, Rajasthan 302021",
      rent: 10500,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/271618/pexels-photo-271618.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000032"
    }
  },
  {
    visitId: "SEED_JAIPUR_03",
    propertyCategory: "Hostel",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Student Hostel - Mansarovar",
      city: "Jaipur",
      area: "Mansarovar",
      address: "Mansarovar, Jaipur, Rajasthan 302020",
      rent: 8000,
      propertyType: "Hostel",
      genderSuitability: "co-ed",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1457842/pexels-photo-1457842.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000033"
    }
  },

  // SIKAR PROPERTIES
  {
    visitId: "SEED_SIKAR_01",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Coaching PG - Piprali Road",
      city: "Sikar",
      area: "Piprali Road",
      address: "Piprali Road, Sikar, Rajasthan 332001",
      rent: 6500,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000041"
    }
  },
  {
    visitId: "SEED_SIKAR_02",
    propertyCategory: "Hostel",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1743229/pexels-photo-1743229.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1743229/pexels-photo-1743229.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Student Hostel - Nawalgarh Road",
      city: "Sikar",
      area: "Nawalgarh Road",
      address: "Nawalgarh Road, Sikar, Rajasthan 332001",
      rent: 7000,
      propertyType: "Hostel",
      genderSuitability: "co-ed",
      bedCount: 3,
      photos: ["https://images.pexels.com/photos/1743229/pexels-photo-1743229.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000042"
    }
  },

  // DELHI PROPERTIES
  {
    visitId: "SEED_DELHI_01",
    propertyCategory: "Apartment",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1643383/pexels-photo-1643383.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1643383/pexels-photo-1643383.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Apartments - Dwarka",
      city: "Delhi",
      area: "Dwarka",
      address: "Dwarka Sector 12, New Delhi 110075",
      rent: 25000,
      propertyType: "Apartment",
      genderSuitability: "co-ed",
      bedCount: 3,
      photos: ["https://images.pexels.com/photos/1643383/pexels-photo-1643383.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000051"
    }
  },
  {
    visitId: "SEED_DELHI_02",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Student Hub - Laxmi Nagar",
      city: "Delhi",
      area: "Laxmi Nagar",
      address: "Laxmi Nagar, New Delhi 110092",
      rent: 9000,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1571460/pexels-photo-1571460.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000052"
    }
  },

  // BHOPAL PROPERTIES
  {
    visitId: "SEED_BHOPAL_01",
    propertyCategory: "PG",
    isLiveOnWebsite: true,
    status: "approved",
    images: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
    featuredImage: "https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600",
    propertyInfo: {
      name: "Roomhy Student PG - MP Nagar",
      city: "Bhopal",
      area: "MP Nagar",
      address: "MP Nagar Zone 2, Bhopal, Madhya Pradesh 462016",
      rent: 6000,
      propertyType: "PG",
      genderSuitability: "male",
      bedCount: 2,
      photos: ["https://images.pexels.com/photos/1571468/pexels-photo-1571468.jpeg?auto=compress&cs=tinysrgb&w=600"],
      ownerName: "Verified Owner",
      ownerPhone: "9000000061"
    }
  }
];

async function seed() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI missing in process.env');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB.');

  let seededCount = 0;
  for (const item of seedPropertiesData) {
    const existing = await ApprovedProperty.findOne({ visitId: item.visitId });
    if (!existing) {
      await ApprovedProperty.create(item);
      console.log(`✅ Seeded DB Property: ${item.propertyInfo.name} (${item.propertyInfo.city}/${item.propertyInfo.area})`);
      seededCount++;
    } else {
      console.log(`ℹ️ Property already in DB: ${item.propertyInfo.name}`);
    }
  }

  console.log(`\n🎉 Seed completed! Successfully added ${seededCount} live properties to MongoDB database.`);
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed error:', err);
  process.exit(1);
});
