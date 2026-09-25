/**
 * ================================================================
 * ROOMHY — Complete Demo Seed Script
 * Run: node seed-demo.js
 * ================================================================
 * Login ID Prefixes:
 *   - Owner (Website & Panel): ROOMHY001 to ROOMHY005
 *   - Employee:                RY001 to RY005
 *   - Tenant:                  ROOMHYINT001 to ROOMHYINT010
 *   - Website General User:    Simran Kaur (Mobile: 9800000001)
 *   - Website Property Owner:  Harshdeep Kaur (Mobile: 9800000002 / 9876543210, Login: ROOMHY001)
 * Password for ALL accounts: 123456
 * ================================================================
 */

// ── Force Google DNS (fixes MongoDB Atlas SRV lookup on some ISPs) ──────────
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── Models ──────────────────────────────────────────────────────────────────
const User          = require('./models/user');
const Owner         = require('./models/Owner');
const Employee      = require('./models/Employee');
const Property      = require('./models/Property');
const Room          = require('./models/Room');
const Tenant        = require('./models/Tenant');
const VisitData     = require('./models/VisitData');
const SupportTicket = require('./models/SupportTicket');
const Rent          = require('./models/Rent');

// ── DB Connect ──────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('❌ MONGO_URI not found in .env');
    process.exit(1);
}
console.log('🔌 Connecting to:', MONGO_URI.replace(/:([^@]+)@/, ':****@'));

// ── Passwords (all set to 123456) ────────────────────────────────────────────
const TEST_PASSWORD = '123456';

// ── Seed Data ────────────────────────────────────────────────────────────────
async function seed() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected');

    const hash = await bcrypt.hash(TEST_PASSWORD, 10);

    // ─────────────────────────────────────────────────────────────────────────
    // DATA ARRAYS
    // ─────────────────────────────────────────────────────────────────────────
    const ownersData = [
        {
            name: 'Harshdeep Kaur',
            loginId: 'ROOMHY001',
            email: 'harshdeepkaur@roomhy.test',
            phone: '9876543210',
            altPhone: '9800000002', // Website owner phone
            city: 'Jaipur',
            area: 'Malviya Nagar',
            address: '12, Malviya Nagar, Jaipur, Rajasthan 302017',
            bankDetails: {
                accountHolderName: 'Harshdeep Kaur',
                accountNumber: '000621711001303',
                ifscCode: 'JIOP0000001',
                bankName: 'Jio Payments Bank',
                accountType: 'Savings'
            }
        },
        {
            name: 'Suresh Kumar',
            loginId: 'ROOMHY002',
            email: 'suresh.kumar@roomhy.test',
            phone: '9876543211',
            city: 'Jaipur',
            area: 'Vaishali Nagar',
            address: '45, Vaishali Nagar, Jaipur, Rajasthan 302021',
            bankDetails: {
                accountHolderName: 'Suresh Kumar',
                accountNumber: '3687628646',
                ifscCode: 'CBIN0282138',
                bankName: 'Central Bank of India',
                accountType: 'Savings'
            }
        },
        {
            name: 'Rajesh Verma',
            loginId: 'ROOMHY003',
            email: 'rajesh.verma@roomhy.test',
            phone: '9876543212',
            city: 'Jaipur',
            area: 'Raja Park',
            address: '78, Raja Park, Jaipur, Rajasthan 302004',
            bankDetails: {
                accountHolderName: 'Rajesh Verma',
                accountNumber: '912345678901',
                ifscCode: 'SBIN0001234',
                bankName: 'State Bank of India',
                accountType: 'Savings'
            }
        },
        {
            name: 'Vikram Malhotra',
            loginId: 'ROOMHY004',
            email: 'vikram.malhotra@roomhy.test',
            phone: '9876543213',
            city: 'Jaipur',
            area: 'Mansarovar',
            address: '102, Mansarovar, Jaipur, Rajasthan 302020',
            bankDetails: {
                accountHolderName: 'Vikram Malhotra',
                accountNumber: '912345678902',
                ifscCode: 'HDFC0005678',
                bankName: 'HDFC Bank',
                accountType: 'Savings'
            }
        },
        {
            name: 'Anita Gupta',
            loginId: 'ROOMHY005',
            email: 'anita.gupta@roomhy.test',
            phone: '9876543214',
            city: 'Jaipur',
            area: 'Tonk Road',
            address: '15, Tonk Road, Jaipur, Rajasthan 302018',
            bankDetails: {
                accountHolderName: 'Anita Gupta',
                accountNumber: '912345678903',
                ifscCode: 'ICIC0009101',
                bankName: 'ICICI Bank',
                accountType: 'Savings'
            }
        }
    ];

    const employeesData = [
        { loginId: 'RY001', name: 'Rahul Sharma',  email: 'rahul.sharma@roomhy.test',  phone: '9812345678', area: 'Malviya Nagar',  role: 'Field Executive' },
        { loginId: 'RY002', name: 'Pooja Verma',   email: 'pooja.verma@roomhy.test',   phone: '9812345679', area: 'Vaishali Nagar', role: 'Field Executive' },
        { loginId: 'RY003', name: 'Amit Singh',    email: 'amit.singh@roomhy.test',    phone: '9812345680', area: 'Raja Park',      role: 'Field Executive' },
        { loginId: 'RY004', name: 'Neha Kapoor',   email: 'neha.kapoor@roomhy.test',   phone: '9812345681', area: 'Mansarovar',     role: 'Field Executive' },
        { loginId: 'RY005', name: 'Vikas Joshi',   email: 'vikas.joshi@roomhy.test',   phone: '9812345682', area: 'Tonk Road',      role: 'Field Executive' },
    ];

    const tenantsData = [
        { loginId: 'ROOMHYINT001', name: 'Priya Mehta',      phone: '9911223301', email: 'priya.mehta@roomhy.test',     propIdx: 0, roomIdx: 0, bedIdx: 0 },
        { loginId: 'ROOMHYINT002', name: 'Anjali Singh',     phone: '9911223302', email: 'anjali.singh@roomhy.test',    propIdx: 0, roomIdx: 0, bedIdx: 1 },
        { loginId: 'ROOMHYINT003', name: 'Kavita Sharma',    phone: '9911223303', email: 'kavita.sharma@roomhy.test',   propIdx: 0, roomIdx: 1, bedIdx: 0 },
        { loginId: 'ROOMHYINT004', name: 'Ritu Verma',       phone: '9911223304', email: 'ritu.verma@roomhy.test',      propIdx: 0, roomIdx: 1, bedIdx: 1 },
        { loginId: 'ROOMHYINT005', name: 'Sneha Patel',      phone: '9911223305', email: 'sneha.patel@roomhy.test',     propIdx: 1, roomIdx: 3, bedIdx: 0 },
        { loginId: 'ROOMHYINT006', name: 'Divya Agarwal',   phone: '9911223306', email: 'divya.agarwal@roomhy.test',   propIdx: 1, roomIdx: 3, bedIdx: 1 },
        { loginId: 'ROOMHYINT007', name: 'Megha Jain',       phone: '9911223307', email: 'megha.jain@roomhy.test',      propIdx: 1, roomIdx: 4, bedIdx: 0 },
        { loginId: 'ROOMHYINT008', name: 'Pooja Choudhary',  phone: '9911223308', email: 'pooja.choudhary@roomhy.test', propIdx: 2, roomIdx: 6, bedIdx: 0 },
        { loginId: 'ROOMHYINT009', name: 'Sunita Yadav',     phone: '9911223309', email: 'sunita.yadav@roomhy.test',    propIdx: 2, roomIdx: 6, bedIdx: 1 },
        { loginId: 'ROOMHYINT010', name: 'Aarti Saxena',     phone: '9911223310', email: 'aarti.saxena@roomhy.test',    propIdx: 2, roomIdx: 7, bedIdx: 0 },
    ];

    // Regular website user
    const websiteUserData = {
        name: 'Simran Kaur',
        email: 'simran.kaur@roomhy.test',
        phone: '9800000001',
        password: TEST_PASSWORD,
        role: 'tenant',
        city: 'Jaipur',
        status: 'active',
        isActive: true
    };

    // ─────────────────────────────────────────────────────────────────────────
    // CLEANUP STALE DEMO DATA BEFORE CREATING NEW FRESH RECORDS
    // ─────────────────────────────────────────────────────────────────────────
    const allLoginIds = [
        ...ownersData.map(o => o.loginId),
        ...employeesData.map(e => e.loginId),
        ...tenantsData.map(t => t.loginId),
        'HARSH001', 'EMP001', 'TENT001', 'TENT002'
    ];

    const allEmails = [
        ...ownersData.map(o => o.email),
        ...employeesData.map(e => e.email),
        ...tenantsData.map(t => t.email),
        websiteUserData.email,
        'owner.website@roomhy.test'
    ];

    const allPhones = [
        ...ownersData.map(o => o.phone),
        ...ownersData.map(o => o.altPhone).filter(Boolean),
        ...employeesData.map(e => e.phone),
        ...tenantsData.map(t => t.phone),
        websiteUserData.phone,
        '9800000002'
    ];

    console.log('🧹 Cleaning up stale demo records...');
    await User.deleteMany({ $or: [{ loginId: { $in: allLoginIds } }, { email: { $in: allEmails } }, { phone: { $in: allPhones } }] });
    await Owner.deleteMany({ $or: [{ loginId: { $in: allLoginIds } }, { email: { $in: allEmails } }, { phone: { $in: allPhones } }] });
    await Employee.deleteMany({ $or: [{ loginId: { $in: allLoginIds } }, { email: { $in: allEmails } }, { phone: { $in: allPhones } }] });
    await Tenant.deleteMany({ $or: [{ loginId: { $in: allLoginIds } }, { email: { $in: allEmails } }, { phone: { $in: allPhones } }] });
    console.log('✨ Cleanup finished.');

    // ─────────────────────────────────────────────────────────────────────────
    // 0. WEBSITE USER (General Public Visitor User)
    // ─────────────────────────────────────────────────────────────────────────
    await User.create(websiteUserData);
    console.log(`✅ Website User created: Simran Kaur (${websiteUserData.phone})`);

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PROPERTY OWNERS (Prefix: ROOMHY) — Web & Panel Single Login
    // ─────────────────────────────────────────────────────────────────────────
    const createdOwners = [];
    for (const od of ownersData) {
        // Create User record for single website & panel login
        await User.create({
            name:     od.name,
            loginId:  od.loginId,
            email:    od.email,
            phone:    od.phone,
            password: TEST_PASSWORD, // pre-save hook hashes plain string
            role:     'owner',
            city:     od.city,
            status:   'active',
            isActive: true
        });

        // Create Owner record
        const owner = await Owner.create({
            name:       od.name,
            loginId:    od.loginId,
            email:      od.email,
            phone:      od.phone,
            password:   hash,
            city:       od.city,
            area:       od.area,
            address:    od.address,
            status:     'active',
            isApproved: true,
            bankDetails: od.bankDetails
        });
        console.log(`✅ Property Owner created: ${owner.loginId} (${owner.name})`);
        createdOwners.push(owner);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. EMPLOYEES (Prefix: RY)
    // ─────────────────────────────────────────────────────────────────────────
    const createdEmployees = [];
    for (const ed of employeesData) {
        await User.create({
            name:     ed.name,
            loginId:  ed.loginId,
            email:    ed.email,
            phone:    ed.phone,
            password: TEST_PASSWORD,
            role:     'employee',
            city:     'Jaipur',
            status:   'active',
            isActive: true
        });

        const employee = await Employee.create({
            name:         ed.name,
            loginId:      ed.loginId,
            email:        ed.email,
            phone:        ed.phone,
            password:     hash,
            role:         ed.role,
            employeeType: 'Field Executive',
            area:         ed.area,
            city:         'Jaipur',
            isActive:     true,
            permissions:  ['properties', 'tenants', 'visits', 'complaints']
        });
        console.log(`✅ Employee created: ${employee.loginId} (${employee.name})`);
        createdEmployees.push(employee);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. PROPERTIES & ROOMS
    // ─────────────────────────────────────────────────────────────────────────
    const propertiesData = [
        {
            ownerLoginId: 'ROOMHY001',
            ownerIdx: 0,
            title: 'Roomhy Premium PG — Malviya Nagar',
            area: 'Malviya Nagar',
            address: '12, Malviya Nagar, Jaipur, Rajasthan 302017',
            pincode: '302017',
            gender: 'female',
            monthlyRent: 8500,
            roomCount: 3
        },
        {
            ownerLoginId: 'ROOMHY002',
            ownerIdx: 1,
            title: 'Roomhy Executive Residency — Vaishali Nagar',
            area: 'Vaishali Nagar',
            address: '45, Vaishali Nagar, Jaipur, Rajasthan 302021',
            pincode: '302021',
            gender: 'any',
            monthlyRent: 9500,
            roomCount: 3
        },
        {
            ownerLoginId: 'ROOMHY003',
            ownerIdx: 2,
            title: 'Roomhy Luxury Stay — Raja Park',
            area: 'Raja Park',
            address: '78, Raja Park, Jaipur, Rajasthan 302004',
            pincode: '302004',
            gender: 'male',
            monthlyRent: 8000,
            roomCount: 2
        }
    ];

    const createdProperties = [];
    const allRooms = [];

    for (const pd of propertiesData) {
        let property = await Property.findOne({ title: pd.title });
        const ownerObj = createdOwners[pd.ownerIdx];
        if (!property) {
            property = await Property.create({
                title:          pd.title,
                ownerLoginId:   pd.ownerLoginId,
                owner:          ownerObj._id,
                owner_id:       pd.ownerLoginId,
                city:           'Jaipur',
                area:           pd.area,
                address:        pd.address,
                pincode:        pd.pincode,
                propertyType:   'PG',
                gender:         pd.gender,
                totalRooms:     pd.roomCount,
                status:         'approved',
                isApproved:     true,
                amenities: [
                    { name: 'WiFi',     icon: 'wifi',       category: 'basic' },
                    { name: 'AC',       icon: 'wind',       category: 'comfort' },
                    { name: 'Laundry',  icon: 'shirt',      category: 'basic' },
                    { name: 'Meals',    icon: 'utensils',   category: 'basic' },
                    { name: 'CCTV',     icon: 'camera',     category: 'basic' },
                    { name: 'Parking',  icon: 'car',        category: 'basic' },
                ],
                description:    `Premium PG accommodation in ${pd.area}, Jaipur.`,
                monthlyRent:    pd.monthlyRent,
                securityDeposit: pd.monthlyRent * 2,
                isDeleted:      false
            });
            console.log(`✅ Property created: ${property.title}`);
        } else {
            property.ownerLoginId = pd.ownerLoginId;
            property.owner = ownerObj._id;
            property.owner_id = pd.ownerLoginId;
            await property.save();
        }
        createdProperties.push(property);

        const existingRooms = await Room.find({ property: property._id });
        if (existingRooms.length === 0) {
            for (let i = 1; i <= pd.roomCount; i++) {
                const room = await Room.create({
                    property:    property._id,
                    ownerLoginId:pd.ownerLoginId,
                    title:       `Room ${i}0${i}`,
                    number:      `${i}0${i}`,
                    floor:       i,
                    type:        'Double Sharing',
                    beds:        2,
                    price:       pd.monthlyRent,
                    status:      'available',
                    bedAssignments: [{}, {}],
                    isDeleted:   false
                });
                allRooms.push(room);
            }
            console.log(`✅ ${pd.roomCount} Rooms created for ${property.title}`);
        } else {
            allRooms.push(...existingRooms);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. TENANTS (Prefix: ROOMHYINT)
    // ─────────────────────────────────────────────────────────────────────────
    const createdTenants = [];
    for (const td of tenantsData) {
        await User.create({
            name:     td.name,
            loginId:  td.loginId,
            email:    td.email,
            phone:    td.phone,
            password: TEST_PASSWORD,
            role:     'tenant',
            city:     'Jaipur',
            status:   'active',
            isActive: true
        });

        const prop = createdProperties[td.propIdx] || createdProperties[0];
        const room = allRooms[td.roomIdx] || allRooms[0];

        const tenant = await Tenant.create({
            name:           td.name,
            loginId:        td.loginId,
            email:          td.email,
            phone:          td.phone,
            password:       hash,
            ownerLoginId:   prop.ownerLoginId,
            property:       prop._id,
            room:           room._id,
            roomNo:         room.title,
            bedNo:          td.bedIdx + 1,
            agreedRent:     prop.monthlyRent || 8500,
            securityDeposit:(prop.monthlyRent || 8500) * 2,
            status:         'active',
            moveInDate:     new Date('2026-07-01'),
            kycStatus:      'verified',
            isDeleted:      false
        });

        if (room) {
            const assignments = room.bedAssignments || [{}, {}];
            assignments[td.bedIdx] = {
                tenantId:      tenant._id,
                tenantName:    td.name,
                tenantLoginId: td.loginId,
                assignedAt:    new Date()
            };
            await Room.findByIdAndUpdate(room._id, { $set: { bedAssignments: assignments } });
        }

        console.log(`✅ Tenant created: ${tenant.loginId} — ${td.name}`);
        createdTenants.push(tenant);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. VISIT REPORTS (Submitted by Employees)
    // ─────────────────────────────────────────────────────────────────────────
    const visitsToCreate = [
        { empLoginId: 'RY001', staffName: 'Rahul Sharma', ownerLoginId: 'ROOMHY001', ownerName: 'Harshdeep Kaur', propName: 'Roomhy Premium PG — Malviya Nagar', area: 'Malviya Nagar' },
        { empLoginId: 'RY002', staffName: 'Pooja Verma',  ownerLoginId: 'ROOMHY002', ownerName: 'Suresh Kumar',   propName: 'Roomhy Executive Residency — Vaishali Nagar', area: 'Vaishali Nagar' },
        { empLoginId: 'RY003', staffName: 'Amit Singh',   ownerLoginId: 'ROOMHY003', ownerName: 'Rajesh Verma',   propName: 'Roomhy Luxury Stay — Raja Park', area: 'Raja Park' },
    ];

    for (const vd of visitsToCreate) {
        let visit = await VisitData.findOne({ submittedByLoginId: vd.empLoginId });
        if (!visit) {
            await VisitData.create({
                visitId:            'VID-' + Date.now() + '-' + vd.empLoginId,
                submittedByLoginId: vd.empLoginId,
                staffName:          vd.staffName,
                submittedBy:        vd.staffName,
                ownerLoginId:       vd.ownerLoginId,
                ownerName:          vd.ownerName,
                propertyName:       vd.propName,
                city:               'Jaipur',
                area:               vd.area,
                address:            `${vd.area}, Jaipur, Rajasthan`,
                pincode:            '302001',
                status:             'approved',
                employeeRating:     5,
                cleanlinessRating:  4,
                internalRemarks:    `Property visit completed successfully by ${vd.staffName}. All amenities verified.`,
                roomCount:          3,
                bedCount:           6,
                vacantRooms:        1,
                vacantBeds:         2,
                occupiedRooms:      2,
                occupiedBeds:       4,
                amenities:          ['WiFi', 'AC', 'Laundry', 'Meals', 'CCTV'],
                photos:             []
            });
            console.log(`✅ Visit Report created for employee: ${vd.empLoginId}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. SUPPORT TICKETS (Raised by Tenants)
    // ─────────────────────────────────────────────────────────────────────────
    const ticketsToCreate = [
        { raisedBy: 'ROOMHYINT001', name: 'Priya Mehta',   subject: 'Bathroom tap leaking in Room 101', priority: 'High', ownerId: 'ROOMHY001', ownerName: 'Harshdeep Kaur', propName: 'Roomhy Premium PG — Malviya Nagar' },
        { raisedBy: 'ROOMHYINT002', name: 'Anjali Singh',  subject: 'WiFi connection slow in evening',  priority: 'Medium', ownerId: 'ROOMHY001', ownerName: 'Harshdeep Kaur', propName: 'Roomhy Premium PG — Malviya Nagar' },
        { raisedBy: 'ROOMHYINT005', name: 'Sneha Patel',   subject: 'AC remote battery replacement',     priority: 'Low', ownerId: 'ROOMHY002', ownerName: 'Suresh Kumar',   propName: 'Roomhy Executive Residency — Vaishali Nagar' },
    ];

    const { resolvePropertyEmployee } = require('./utils/propertyEmployeeResolver');
    for (const st of ticketsToCreate) {
        let ticket = await SupportTicket.findOne({ raised_by: st.raisedBy, subject: st.subject });
        if (!ticket) {
            const propEmp = await resolvePropertyEmployee({
                ownerLoginId: st.ownerId,
                city: 'Jaipur'
            });

            await SupportTicket.create({
                ticket_type:    'Tenant Complaint',
                subject:        st.subject,
                description:    `${st.subject}. Please resolve as soon as possible.`,
                priority:       st.priority,
                status:         propEmp ? 'Assigned' : 'Open',
                assigned_admin: propEmp?.loginId || null,
                assigned_admin_name: propEmp?.name || null,
                raised_by:      st.raisedBy,
                raised_by_name: st.name,
                raised_by_role: 'tenant',
                owner_id:       st.ownerId,
                owner_name:     st.ownerName,
                property_id:    createdProperties[0]._id.toString(),
                property_name:  st.propName,
                city:           'Jaipur',
                area:           'Jaipur Area',
            });
            console.log(`✅ Support Ticket created for tenant: ${st.raisedBy} (Assigned to: ${propEmp?.name || 'Unassigned'})`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. RENT RECORDS
    // ─────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < 5; i++) {
        const t = createdTenants[i];
        if (t) {
            let rent = await Rent.findOne({ tenantLoginId: t.loginId, collectionMonth: '2026-09' });
            if (!rent) {
                await Rent.create({
                    tenantId:        t._id,
                    tenantLoginId:   t.loginId,
                    tenantName:      t.name,
                    ownerLoginId:    t.ownerLoginId,
                    propertyId:      t.property,
                    propertyName:    t.propertyTitle || 'Roomhy PG',
                    roomNumber:      t.roomNo || '101',
                    rentAmount:      t.agreedRent || 8500,
                    totalDue:        t.agreedRent || 8500,
                    paidAmount:      i < 3 ? (t.agreedRent || 8500) : 0,
                    collectionMonth: '2026-09',
                    paymentStatus:   i < 3 ? 'paid' : 'pending',
                    paymentDate:     i < 3 ? new Date('2026-09-05') : null,
                    paymentMethod:   i < 3 ? 'bank_transfer' : null,
                });
                console.log(`✅ Rent record created for tenant: ${t.loginId} (${i < 3 ? 'PAID' : 'PENDING'})`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SUMMARY — Print formatted output for User
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    ROOMHY DEMO SEED — ALL LOGIN CREDENTIALS');
    console.log('                            🔑 PASSWORD FOR ALL: 123456');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    console.log('🌐 1. PUBLIC WEBSITE USER (General Visitor)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log(` • Name: Simran Kaur | Mobile: 9800000001 | Email: simran.kaur@roomhy.test | Password: 123456`);

    console.log('\n🏠 2. WEBSITE PROPERTY OWNER (Harshdeep Kaur — Listed Property Owner)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log(` • Login ID : ROOMHY001`);
    console.log(` • Mobile   : 9876543210`);
    console.log(` • Email    : harshdeepkaur@roomhy.test`);
    console.log(` • Password : 123456`);
    console.log(` • Property : Roomhy Premium PG — Malviya Nagar (3 Rooms, 6 Beds)`);
    console.log(` • Bank     : Jio Payments Bank (Acc: 000621711001303, IFSC: JIOP0000001)`);

    console.log('\n🏠 3. OTHER PROPERTY OWNERS (Prefix: ROOMHY)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    ownersData.forEach(o => {
        console.log(` • Login ID: ${o.loginId.padEnd(12)} | Mobile: ${o.phone} | Email: ${o.email.padEnd(28)} | Name: ${o.name}`);
    });

    console.log('\n👔 4. EMPLOYEES (Prefix: RY)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    employeesData.forEach(e => {
        console.log(` • Login ID: ${e.loginId.padEnd(12)} | Mobile: ${e.phone} | Email: ${e.email.padEnd(28)} | Name: ${e.name}`);
    });

    console.log('\n👤 5. TENANTS (Prefix: ROOMHYINT)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    tenantsData.forEach(t => {
        console.log(` • Login ID: ${t.loginId.padEnd(15)} | Mobile: ${t.phone} | Email: ${t.email.padEnd(28)} | Name: ${t.name}`);
    });

    console.log('\n═══════════════════════════════════════════════════════════════════════════════');

    await mongoose.disconnect();
    console.log('\n✅ Seed complete! MongoDB disconnected successfully.');
    process.exit(0);
}

seed().catch(err => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
});
