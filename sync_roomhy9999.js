const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const mongoose = require('mongoose');
const Property = require('./models/Property');
const ApprovedProperty = require('./models/ApprovedProperty');

// Replicate the controller's sync function
const syncToApprovedProperty = async (property) => {
    try {
        const vId = property.visitId || property._id.toString();
        const approvedPropertyData = {
            visitId: vId,
            propertyId: property.propertyId || property._id.toString(),
            enquiry_id: property.enquiry_id || property._id.toString(),
            propertyCategory: property.propertyCategory || "",
            state: property.state || "",
            pincode: property.pincode || "",
            landmark: property.landmark || "",
            contact: property.contact || {},
            videoUrl: property.videoUrl || "",
            images: property.images || [],
            featuredImage: property.featuredImage || (property.images && property.images[0]) || "",
            propertyInfo: {
                name: property.title || 'Property',
                city: property.city || 'Unknown',
                area: property.locality || property.area || 'Unknown',
                address: property.address || '',
                rent: property.monthlyRent || 0,
                propertyType: property.propertyType || 'pg',
                genderSuitability: property.gender || 'any',
                amenities: property.amenities?.map(a => typeof a === 'string' ? a : a.name) || [],
                photos: property.images || [],
                latitude: property.latitude,
                longitude: property.longitude,
                description: property.description || ''
            },
            // Sync root level fields for premium UI
            amenities: property.amenities || [],
            propertyViews: property.propertyViews || [],
            facilities: property.facilities || {},
            exclusiveBenefits: property.exclusiveBenefits || [],
            roomTypes: property.roomTypes || [],
            propertyDetails: property.propertyDetails || {},
            pricing: property.pricing || {},
            policies: property.policies || {},
            tenantDescription: property.tenantDescription || "",
            latitude: property.latitude,
            longitude: property.longitude,
            generatedCredentials: {
                ownerName: property.ownerName || 'Verified Owner',
                loginId: property.ownerLoginId || ''
            },
            isLiveOnWebsite: true,
            status: 'approved',
            updatedAt: new Date()
        };

        const result = await ApprovedProperty.findOneAndUpdate(
            { visitId: vId },
            approvedPropertyData,
            { upsert: true, new: true }
        );
        console.log(`✅ Synced property "${property.title}" (ID: ${property._id}) to ApprovedProperty collection`);
        return result;
    } catch (err) {
        console.error('❌ Sync failed:', err);
    }
};

async function main() {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    console.log('Finding properties owned by ROOMHY9999...');
    const props = await Property.find({ ownerLoginId: 'ROOMHY9999' });

    console.log(`Found ${props.length} properties. Updating and syncing...`);
    for (const prop of props) {
        prop.isLiveOnWebsite = true;
        prop.isPublished = true;
        prop.status = 'active';
        // Give them unique visitId if they don't have one
        if (!prop.visitId) {
            prop.visitId = `VIST-IND-${prop.title.replace(/\s+/g, '-').toUpperCase()}-${Date.now().toString().slice(-4)}`;
        }
        // Save Property
        await prop.save();
        console.log(`Updated Property document: "${prop.title}" (visitId: ${prop.visitId})`);

        // Sync to ApprovedProperty
        await syncToApprovedProperty(prop);
    }

    console.log('\n✅ All properties updated and synced successfully.');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
