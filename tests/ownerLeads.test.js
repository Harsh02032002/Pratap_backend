const test = require('node:test');
const assert = require('node:assert');
const {
  buildOwnerBookingQuery,
  scopeBookingsToProperty,
  mapBookingToLead,
  escapeRegex,
} = require('../services/ownerLeads');

const identity = {
  propIds: ['prop_abc123'],
  propVisitIds: ['visit_xyz789'],
  propNames: ['Rajnesh Hostel'],
  ownerCities: ['kota'],
};
const candidates = ['ROOMHY3259'];

test('owner query matches a booking by property visitId, not just _id', () => {
  const q = buildOwnerBookingQuery({ ownerIdCandidates: candidates, identity });
  const byVisit = q.$or.find(c => c.property_id && Array.isArray(c.property_id.$in) && c.property_id.$in.includes('visit_xyz789'));
  assert.ok(byVisit, 'visitId branch missing — website bookings are keyed by visitId');
});

test('owner query matches the tier-decorated property name by containment', () => {
  const q = buildOwnerBookingQuery({ ownerIdCandidates: candidates, identity });
  const nameBranch = q.$or.find(c => c.property_name instanceof RegExp);
  assert.ok(nameBranch, 'no property_name branch');
  assert.ok(nameBranch.property_name.test('ROOMHYPROP CREST Rajnesh Hostel'),
    'decorated website name must still match the plain panel title');
});

test('regex metacharacters in a property name cannot break the query', () => {
  const q = buildOwnerBookingQuery({
    ownerIdCandidates: candidates,
    identity: { ...identity, propNames: ['Sunrise (PG) [A+]'] },
  });
  const nameBranch = q.$or.find(c => c.property_name instanceof RegExp);
  assert.ok(nameBranch.property_name.test('ROOMHYPROP ESTATE Sunrise (PG) [A+]'));
  assert.equal(escapeRegex('a+b'), 'a\\+b');
});

test('property scoping keeps this property and drops another', () => {
  const scope = { ids: ['prop_abc123', 'visit_xyz789'], names: ['Rajnesh Hostel'] };
  const bookings = [
    { _id: 'b1', property_id: 'visit_xyz789', property_name: 'ROOMHYPROP CREST Rajnesh Hostel' },
    { _id: 'b2', property_id: 'prop_abc123',  property_name: 'Rajnesh Hostel' },
    { _id: 'b3', property_id: null,           property_name: 'ROOMHYPROP CREST Rajnesh Hostel' },
    { _id: 'b4', property_id: 'prop_other',   property_name: 'Sunrise PG' },
  ];
  const kept = scopeBookingsToProperty(bookings, scope).map(b => b._id);
  assert.deepEqual(kept, ['b1', 'b2', 'b3']);
});

test('no property scope leaves the list untouched', () => {
  const bookings = [{ _id: 'b1' }, { _id: 'b2' }];
  assert.equal(scopeBookingsToProperty(bookings, null).length, 2);
});

test('mapped booking carries the fields the owner surfaces render', () => {
  const lead = mapBookingToLead({
    _id: 'b1', owner_id: 'ROOMHY3259', property_id: 'visit_xyz789',
    property_name: 'ROOMHYPROP CREST Rajnesh Hostel',
    name: 'Harshdeep Kaur', email: 'h@example.com', phone: '9464165010',
    request_type: 'direct', rent_amount: 2500, city: 'kota',
    created_at: new Date('2026-08-29T06:15:00Z'),
  });
  assert.equal(lead.studentName, 'Harshdeep Kaur');   // dashboard reads studentName
  assert.ok(lead.ts instanceof Date);                  // ...and ts, not createdAt
  assert.equal(lead.budget, '₹2,500');                 // already formatted with ₹
  assert.equal(lead.status, 'pending');
  assert.equal(lead.isBookingRequest, true);
  assert.equal(lead.isBid, false);
});

test('a lead whose person already moved in reads as confirmed', () => {
  const movedIn = { phones: new Set(['9464165010']), emails: new Set(['h@example.com']) };
  assert.equal(
    mapBookingToLead({ _id: 'b1', phone: '94641 65010', request_type: 'direct' }, movedIn).status,
    'confirmed');
  assert.equal(
    mapBookingToLead({ _id: 'b2', email: 'H@Example.com ', request_type: 'direct' }, movedIn).status,
    'confirmed');
});

// Pre-existing behaviour, moved here verbatim and pinned so a later change to the
// matching is a deliberate one: both sides are only stripped of non-digits, so a
// booking stored with a country code does not match a tenant stored without it.
test('country-code prefixed phone does not match a 10-digit tenant record', () => {
  const movedIn = { phones: new Set(['9464165010']), emails: new Set() };
  const lead = mapBookingToLead({ _id: 'b3', phone: '+919464165010', request_type: 'direct' }, movedIn);
  assert.equal(lead.status, 'pending');
});

test('bid budget is taken from the message amount when present', () => {
  const lead = mapBookingToLead({
    _id: 'b2', request_type: 'bid', bid_amount: 5000,
    message: 'Tenant Max Budget: ₹7,000. If you can offer this property for ₹7,000/month...',
  });
  assert.equal(lead.isBid, true);
  assert.equal(lead.budget, '₹7,000');
});
