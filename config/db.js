const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/roomhy';

async function clearDatabase() {
    try {
        console.log('🔄 Connecting to MongoDB Atlas...');
        await mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
            minPoolSize: 2
        });

        console.log('✅ Connected to MongoDB');
        
        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        
        console.log(`\n📊 Found ${collections.length} collections:`);
        collections.forEach(col => console.log(`  - ${col.name}`));

        console.log('\n🗑️  Clearing all collections...\n');

        for (const collectionInfo of collections) {
            const collectionName = collectionInfo.name;
            
            // Skip system collections
            if (collectionName.startsWith('system.')) {
                console.log(`  ⏭️  Skipping system collection: ${collectionName}`);
                continue;
            }

            try {
                const collection = db.collection(collectionName);
                const count = await collection.countDocuments();
                await collection.deleteMany({});
                console.log(`  ✅ Cleared ${collectionName} (was ${count} documents)`);
            } catch (err) {
                console.error(`  ❌ Error clearing ${collectionName}:`, err.message);
            }
        }

        console.log('\n✨ Database cleared successfully!');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
        process.exit(0);
    }
}

clearDatabase();
