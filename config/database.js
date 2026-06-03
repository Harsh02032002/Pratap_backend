const mongoose = require('mongoose');
const dns = require('dns');

// Fix for SRV DNS lookups - use Google DNS
const ensurePublicDNSForSRV = () => {
  const currentServers = dns.getServers();
  if (currentServers && currentServers.some(server => server.includes('127.0.0.1') || server.includes('::1'))) {
    console.log('🔄 Switching to Google public DNS for SRV lookups...');
    dns.setServers(['8.8.8.8', '8.8.4.4']);
  }
};

const connectDB = async () => {
  try {
    ensurePublicDNSForSRV();
    
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/roomhy';
    
    const options = {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      family: 4 // Force IPv4
    };
    
    const conn = await mongoose.connect(mongoUri, options);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    console.error('Verify MONGO_URI and make sure MongoDB is reachable');
    process.exit(1);
  }
};

module.exports = connectDB;
