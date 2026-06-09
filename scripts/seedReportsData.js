/**
 * ROOMHY — Reports Test Data Seed Script
 * ----------------------------------------
 * Usage: node scripts/seedReportsData.js ROOMHY0001
 * 
 * Replace ROOMHY0001 with YOUR actual owner loginId
 * 
 * This inserts test data into:
 *   - Rent          (10 records)
 *   - Tenant        (6 records)
 *   - Complaint     (5 records)
 *   - PropertyEnquiry / Leads (6 records)
 *   - Room          (4 records)
 *   - StaffAttendance (8 records)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const dns = require("dns");

// Same DNS fix as server.js — fixes Atlas SRV lookup on local machines
const dnsServers = dns.getServers();
if (!dnsServers.length || dnsServers.includes("127.0.0.1") || dnsServers.includes("::1")) {
  dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
}
// Force set regardless
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const OWNER_LOGIN_ID = process.argv[2] || "ROOMHY3869";
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌  MONGO_URI not found in .env");
  process.exit(1);
}

// ── Inline schemas (avoids import chain issues) ──────────────────────────────

const rentSchema = new mongoose.Schema({ ownerLoginId: String, propertyId: String, propertyName: String, tenantName: String, roomNo: String, amount: Number, status: String, paymentMode: String, collectedBy: String }, { timestamps: true });
const tenantSchema = new mongoose.Schema({ ownerLoginId: String, name: String, phone: String, property: mongoose.Schema.Types.ObjectId, propertyName: String, roomNo: String, rentAmount: Number, dueAmount: Number, status: String, kycStatus: String, agreementStatus: String, joiningDate: Date }, { timestamps: true });
const complaintSchema = new mongoose.Schema({ ownerLoginId: String, tenantName: String, propertyName: String, category: String, priority: String, assignedStaffName: String, status: String, description: String }, { timestamps: true });
const enquirySchema = new mongoose.Schema({ ownerLoginId: String, name: String, phone: String, source: String, budget: String, status: String, propertyName: String, moveInDate: Date }, { timestamps: true });
const roomSchema = new mongoose.Schema({ ownerLoginId: String, propertyId: mongoose.Schema.Types.ObjectId, propertyName: String, roomNo: String, name: String, totalBeds: Number, occupiedBeds: Number, capacity: Number, status: String, price: Number }, { timestamps: true });
const attSchema = new mongoose.Schema({ ownerLoginId: String, employeeId: mongoose.Schema.Types.ObjectId, employeeLoginId: String, date: Date, status: String, checkIn: String, checkOut: String, notes: String }, { timestamps: true });

const Rent = mongoose.models.Rent || mongoose.model("Rent", rentSchema);
const Tenant = mongoose.models.Tenant || mongoose.model("Tenant", tenantSchema);
const Complaint = mongoose.models.Complaint || mongoose.model("Complaint", complaintSchema);
const Enquiry = mongoose.models.PropertyEnquiry || mongoose.model("PropertyEnquiry", enquirySchema);
const Room = mongoose.models.Room || mongoose.model("Room", roomSchema);
const Attendance = mongoose.models.StaffAttendance || mongoose.model("StaffAttendance", attSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const PROPERTY_NAME = "Sunshine PG";
const PROPERTY_ID = new mongoose.Types.ObjectId();
const STAFF_ID = new mongoose.Types.ObjectId();

async function seed() {
  await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    family: 4,          // Force IPv4 — avoids SRV DNS issues on Windows
  });
  console.log("✅  Connected to MongoDB");
  console.log(`📌  Seeding for ownerLoginId: ${OWNER_LOGIN_ID}\n`);

  // ── RENTS ────────────────────────────────────────────────────────────────────
  const rents = [
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: PROPERTY_NAME, propertyId: String(PROPERTY_ID), tenantName: "Rohit Sharma", roomNo: "101", amount: 8000, status: "Paid", paymentMode: "UPI", collectedBy: "Owner", createdAt: daysAgo(2) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: PROPERTY_NAME, propertyId: String(PROPERTY_ID), tenantName: "Priya Verma", roomNo: "102", amount: 7500, status: "Paid", paymentMode: "Cash", collectedBy: "Owner", createdAt: daysAgo(5) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: PROPERTY_NAME, propertyId: String(PROPERTY_ID), tenantName: "Arjun Mehta", roomNo: "103", amount: 9000, status: "Paid", paymentMode: "Bank Transfer", collectedBy: "Staff", createdAt: daysAgo(8) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: PROPERTY_NAME, propertyId: String(PROPERTY_ID), tenantName: "Sneha Patel", roomNo: "201", amount: 8500, status: "Pending", paymentMode: "UPI", collectedBy: "Owner", createdAt: daysAgo(3) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: PROPERTY_NAME, propertyId: String(PROPERTY_ID), tenantName: "Karan Singh", roomNo: "202", amount: 7000, status: "Paid", paymentMode: "Cash", collectedBy: "Owner", createdAt: daysAgo(12) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: PROPERTY_NAME, propertyId: String(PROPERTY_ID), tenantName: "Aman Gupta", roomNo: "203", amount: 8200, status: "Overdue", paymentMode: "UPI", collectedBy: "", createdAt: daysAgo(35) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: "Moonlight Hostel", propertyId: String(PROPERTY_ID), tenantName: "Divya Kumar", roomNo: "301", amount: 6500, status: "Paid", paymentMode: "UPI", collectedBy: "Owner", createdAt: daysAgo(7) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: "Moonlight Hostel", propertyId: String(PROPERTY_ID), tenantName: "Ravi Yadav", roomNo: "302", amount: 7200, status: "Paid", paymentMode: "Cash", collectedBy: "Staff", createdAt: daysAgo(10) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: "Moonlight Hostel", propertyId: String(PROPERTY_ID), tenantName: "Pooja Nair", roomNo: "303", amount: 6800, status: "Pending", paymentMode: "", collectedBy: "", createdAt: daysAgo(4) },
    { ownerLoginId: OWNER_LOGIN_ID, propertyName: "Moonlight Hostel", propertyId: String(PROPERTY_ID), tenantName: "Harsh Agarwal", roomNo: "304", amount: 7500, status: "Paid", paymentMode: "Bank Transfer", collectedBy: "Owner", createdAt: daysAgo(15) },
  ];
  await Rent.insertMany(rents);
  console.log(`✅  ${rents.length} Rent records inserted`);

  // ── TENANTS ───────────────────────────────────────────────────────────────────
  const tenants = [
    { ownerLoginId: OWNER_LOGIN_ID, name: "Rohit Sharma", phone: "9812345670", property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "101", rentAmount: 8000, dueAmount: 0, status: "active", kycStatus: "verified", agreementStatus: "signed", joiningDate: daysAgo(120) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Priya Verma", phone: "9823456781", property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "102", rentAmount: 7500, dueAmount: 0, status: "active", kycStatus: "verified", agreementStatus: "signed", joiningDate: daysAgo(90) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Arjun Mehta", phone: "9834567892", property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "103", rentAmount: 9000, dueAmount: 0, status: "active", kycStatus: "pending", agreementStatus: "pending", joiningDate: daysAgo(45) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Sneha Patel", phone: "9845678903", property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "201", rentAmount: 8500, dueAmount: 8500, status: "active", kycStatus: "verified", agreementStatus: "signed", joiningDate: daysAgo(200) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Karan Singh", phone: "9856789014", property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "202", rentAmount: 7000, dueAmount: 0, status: "active", kycStatus: "pending", agreementStatus: "not signed", joiningDate: daysAgo(30) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Aman Gupta", phone: "9867890125", property: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "203", rentAmount: 8200, dueAmount: 16400, status: "active", kycStatus: "rejected", agreementStatus: "expired", joiningDate: daysAgo(365) },
  ];
  await Tenant.insertMany(tenants);
  console.log(`✅  ${tenants.length} Tenant records inserted`);

  // ── COMPLAINTS ────────────────────────────────────────────────────────────────
  const complaints = [
    { ownerLoginId: OWNER_LOGIN_ID, tenantName: "Rohit Sharma", propertyName: PROPERTY_NAME, category: "Maintenance", priority: "High", assignedStaffName: "Raju Kumar", status: "Open", description: "AC not working in room 101" },
    { ownerLoginId: OWNER_LOGIN_ID, tenantName: "Priya Verma", propertyName: PROPERTY_NAME, category: "Cleanliness", priority: "Medium", assignedStaffName: "Rahul Singh", status: "Pending", description: "Common area not cleaned for 3 days" },
    { ownerLoginId: OWNER_LOGIN_ID, tenantName: "Sneha Patel", propertyName: PROPERTY_NAME, category: "Water", priority: "Urgent", assignedStaffName: "Raju Kumar", status: "In Progress", description: "No water supply since morning" },
    { ownerLoginId: OWNER_LOGIN_ID, tenantName: "Karan Singh", propertyName: PROPERTY_NAME, category: "Electricity", priority: "High", assignedStaffName: "Rahul Singh", status: "Resolved", description: "Switchboard sparking in room 202" },
    { ownerLoginId: OWNER_LOGIN_ID, tenantName: "Aman Gupta", propertyName: PROPERTY_NAME, category: "Security", priority: "Low", assignedStaffName: "", status: "Open", description: "CCTV camera not working near entrance" },
  ];
  await Complaint.insertMany(complaints);
  console.log(`✅  ${complaints.length} Complaint records inserted`);

  // ── LEADS / ENQUIRIES ─────────────────────────────────────────────────────────
  const leads = [
    { ownerLoginId: OWNER_LOGIN_ID, name: "Vikram Rao", phone: "9711223344", source: "Website", budget: "₹6000-8000", status: "new", propertyName: PROPERTY_NAME, moveInDate: daysAgo(-5), createdAt: daysAgo(1) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Ayesha Khan", phone: "9722334455", source: "WhatsApp", budget: "₹7000-9000", status: "follow_up", propertyName: PROPERTY_NAME, moveInDate: daysAgo(-10), createdAt: daysAgo(3) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Suresh Babu", phone: "9733445566", source: "Referral", budget: "₹5000-7000", status: "converted", propertyName: PROPERTY_NAME, moveInDate: daysAgo(15), createdAt: daysAgo(20) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Meena Joshi", phone: "9744556677", source: "Google", budget: "₹8000-10000", status: "new", propertyName: PROPERTY_NAME, moveInDate: daysAgo(-3), createdAt: daysAgo(0) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Ankit Tiwari", phone: "9755667788", source: "OLX", budget: "₹5500-7500", status: "lost", propertyName: PROPERTY_NAME, moveInDate: daysAgo(30), createdAt: daysAgo(35) },
    { ownerLoginId: OWNER_LOGIN_ID, name: "Neha Pandey", phone: "9766778899", source: "Website", budget: "₹7000-9000", status: "booked", propertyName: PROPERTY_NAME, moveInDate: daysAgo(5), createdAt: daysAgo(15) },
  ];
  await Enquiry.insertMany(leads);
  console.log(`✅  ${leads.length} Lead/Enquiry records inserted`);

  // ── ROOMS ─────────────────────────────────────────────────────────────────────
  const rooms = [
    { ownerLoginId: OWNER_LOGIN_ID, propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "101", name: "Room 101", totalBeds: 2, occupiedBeds: 2, capacity: 2, status: "Full", price: 8000 },
    { ownerLoginId: OWNER_LOGIN_ID, propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "102", name: "Room 102", totalBeds: 3, occupiedBeds: 2, capacity: 3, status: "Available", price: 7500 },
    { ownerLoginId: OWNER_LOGIN_ID, propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "201", name: "Room 201", totalBeds: 4, occupiedBeds: 4, capacity: 4, status: "Full", price: 6500 },
    { ownerLoginId: OWNER_LOGIN_ID, propertyId: PROPERTY_ID, propertyName: PROPERTY_NAME, roomNo: "202", name: "Room 202", totalBeds: 2, occupiedBeds: 0, capacity: 2, status: "Vacant", price: 9000 },
  ];
  await Room.insertMany(rooms);
  console.log(`✅  ${rooms.length} Room records inserted`);

  // ── STAFF ATTENDANCE ──────────────────────────────────────────────────────────
  const attRecords = [
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(0), status: "Present", checkIn: "09:05", checkOut: "18:30" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(1), status: "Present", checkIn: "09:00", checkOut: "18:00" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(2), status: "Late", checkIn: "10:30", checkOut: "18:00", notes: "Traffic issue" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(3), status: "Absent" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(4), status: "Present", checkIn: "08:55", checkOut: "18:05" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(5), status: "Present", checkIn: "09:10", checkOut: "18:00" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(6), status: "Leave", notes: "Sick leave" },
    { ownerLoginId: OWNER_LOGIN_ID, employeeId: STAFF_ID, employeeLoginId: "STAFF0001", date: daysAgo(7), status: "Present", checkIn: "09:00", checkOut: "17:45" },
  ];
  await Attendance.insertMany(attRecords);
  console.log(`✅  ${attRecords.length} Attendance records inserted`);

  // ── SUMMARY ───────────────────────────────────────────────────────────────────
  const totalRent = rents.filter(r => r.status === "Paid").reduce((s, r) => s + r.amount, 0);
  console.log(`
╔══════════════════════════════════════════════╗
║        SEED COMPLETE — ${OWNER_LOGIN_ID.padEnd(14)}       ║
╠══════════════════════════════════════════════╣
║  Rents inserted:        ${String(rents.length).padEnd(20)} ║
║  Tenants inserted:      ${String(tenants.length).padEnd(20)} ║
║  Complaints inserted:   ${String(complaints.length).padEnd(20)} ║
║  Leads inserted:        ${String(leads.length).padEnd(20)} ║
║  Rooms inserted:        ${String(rooms.length).padEnd(20)} ║
║  Attendance inserted:   ${String(attRecords.length).padEnd(20)} ║
║  Total paid revenue:    ₹${String(totalRent.toLocaleString("en-IN")).padEnd(19)} ║
╚══════════════════════════════════════════════╝
  `);

  await mongoose.disconnect();
  console.log("🔌  Disconnected. Go test your reports! 🎉\n");
  process.exit(0);
}

seed().catch(err => {
  console.error("❌  Seed failed:", err.message);
  process.exit(1);
});
