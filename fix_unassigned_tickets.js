const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const dns = require('dns');

dns.setServers(['8.8.8.8', '1.1.1.1']);
dotenv.config({ path: path.join(__dirname, '.env') });

const MONGO_URI = process.env.MONGO_URI;
const SupportTicket = require('./models/SupportTicket');
const { resolvePropertyEmployee } = require('./utils/propertyEmployeeResolver');

const mongoOptions = {
  serverSelectionTimeoutMS: 30000,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 30000,
  family: 4,
  retryWrites: true,
  w: 'majority'
};

async function fixTickets() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(MONGO_URI, mongoOptions);
    console.log('Connected!');

    const tickets = await SupportTicket.find({
      $or: [
        { assigned_admin_name: { $in: [null, '', 'Unassigned', 'N/A'] } },
        { assigned_admin: { $in: [null, '', 'Unassigned'] } }
      ]
    });

    console.log(`Found ${tickets.length} tickets to auto-assign...`);

    for (const ticket of tickets) {
      const propEmp = await resolvePropertyEmployee({
        propertyId: ticket.property_id,
        ownerLoginId: ticket.owner_id,
        city: ticket.city,
        area: ticket.area
      });

      if (propEmp) {
        ticket.assigned_admin = propEmp.loginId;
        ticket.assigned_admin_name = propEmp.name;
        if (ticket.status === 'Open') {
          ticket.status = 'Assigned';
        }
        await ticket.save();
        console.log(`✅ Fixed Ticket ${ticket.ticket_id || ticket._id}: Assigned to ${propEmp.name} (${propEmp.loginId})`);
      } else {
        console.log(`⚠️ Could not resolve employee for Ticket ${ticket.ticket_id || ticket._id}`);
      }
    }

    console.log('Finished updating tickets!');
    process.exit(0);
  } catch (err) {
    console.error('Error fixing tickets:', err);
    process.exit(1);
  }
}

fixTickets();
