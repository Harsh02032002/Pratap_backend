const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const dns = require('dns');

// Set custom DNS resolvers to bypass local network DNS resolution blocks
dns.setServers(['8.8.8.8', '1.1.1.1']);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('MONGO_URI is not defined in .env file');
  process.exit(1);
}

const SupportTicket = require('./models/SupportTicket');

const mongoOptions = {
  serverSelectionTimeoutMS: 30000,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 30000,
  family: 4, // Force IPv4 to avoid DNS resolution delays
  waitQueueTimeoutMS: 30000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  w: 'majority'
};

async function run() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(MONGO_URI, mongoOptions);
    console.log('Connected!');

    console.log('\n--- Fetching all Support Tickets ---');
    const tickets = await SupportTicket.find({}).lean();
    console.log(`Total tickets found: ${tickets.length}`);

    let malformedCount = 0;
    tickets.forEach((t, i) => {
      const isMalformed = !t.ticket_id || !t.ticket_type || !t.created_at;
      if (isMalformed) {
        malformedCount++;
      }
      console.log(`\n[${i + 1}] Ticket ID: ${t.ticket_id || 'MISSING'}`);
      console.log(`    DB ID: ${t._id}`);
      console.log(`    Type: ${t.ticket_type || 'MISSING'}`);
      console.log(`    Status: ${t.status}`);
      console.log(`    Subject: ${t.subject || 'MISSING'}`);
      console.log(`    Raised By: ${t.raised_by_name || 'MISSING'} (${t.raised_by_role || 'MISSING'})`);
      console.log(`    Created At: ${t.created_at || 'MISSING'}`);
      console.log(`    Is Malformed: ${isMalformed ? '⚠️ YES' : 'NO'}`);
    });

    if (malformedCount > 0) {
      console.log(`\nFound ${malformedCount} malformed tickets.`);
      console.log('Deleting malformed tickets to clean up database...');
      
      const deleteResult = await SupportTicket.deleteMany({
        $or: [
          { ticket_id: { $exists: false } },
          { ticket_id: null },
          { ticket_type: { $exists: false } },
          { ticket_type: null },
          { created_at: { $exists: false } },
          { created_at: null }
        ]
      });
      console.log(`Deleted ${deleteResult.deletedCount} malformed tickets!`);
    } else {
      console.log('\nNo malformed tickets found.');
    }

  } catch (error) {
    console.error('Error running inspection:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

run();
