const mongoose = require('mongoose');
const Property = require('../models/Property');
const Enquiry = require('../models/Enquiry');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const ApprovedProperty = require('../models/ApprovedProperty');
const { geocodeAddress } = require('../utils/geocode');
const { clearCache } = require('../middleware/apiCache');
const { flattenListingImages } = require('../utils/propertyGallery');

const deriveLocationCode = (input = {}) => {
  const candidates = [
    input.locationCode,
    input.location_code,
    input.areaCode,
    input.area_code,
    input.locality,
    input.city
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (compact.length >= 3) return compact.slice(0, 12);
    if (compact.length > 0) return compact.padEnd(3, 'X');
  }

  return 'GEN';
};

// Helper: strip empty values for ObjectId paths (e.g. owner: "") so Mongoose
// does not throw a CastError and abort the whole save.
const sanitizePropertyPayload = (data = {}) => {
  const cleaned = { ...data };
  delete cleaned._id;
  delete cleaned.id;

  for (const key of Object.keys(cleaned)) {
    const schemaPath = Property.schema.path(key);
    // Mongoose 8 reports 'ObjectId'; older versions used 'ObjectID'.
    if (!schemaPath || String(schemaPath.instance).toLowerCase() !== 'objectid') continue;

    const value = cleaned[key];
    // Owner may arrive as a populated object from the panel — keep just the id.
    const raw = value && typeof value === 'object' && value._id ? value._id : value;
    if (!raw || !mongoose.Types.ObjectId.isValid(String(raw))) {
      delete cleaned[key];
    } else {
      cleaned[key] = raw;
    }
  }

  return cleaned;
};

// A property belongs on the public website when it is active/approved and has not
// been explicitly taken offline. Legacy documents predate isLiveOnWebsite, so only
// an explicit `false` counts as offline.
const isPropertyLive = (property) =>
  property.isLiveOnWebsite !== false && ['active', 'approved'].includes(property.status);

// Helper: Sync Property to ApprovedProperty for website visibility
const syncToApprovedProperty = async (property) => {
  if (!isPropertyLive(property)) return;
  try {
    const vId = property.visitId || property._id.toString();
    const listingImages = flattenListingImages(property);
    const featuredImage = property.featuredImage || listingImages[0] || "";
    const approvedPropertyData = {
      visitId: vId,
      propertyId: property.propertyId || property._id.toString(),
      enquiry_id: property.enquiry_id || property._id.toString(),
      propertyCategory: property.propertyCategory || "",
      tier: property.tier || "",
      state: property.state || "",
      pincode: property.pincode || "",
      landmark: property.landmark || "",
      contact: property.contact || {},
      videoUrl: property.videoUrl || "",
      images: listingImages,
      featuredImage,
      propertyInfo: {
        name: property.title || 'Property',
        city: property.city || 'Unknown',
        area: property.locality || property.area || 'Unknown',
        address: property.address || '',
        rent: property.monthlyRent || 0,
        propertyType: property.propertyType || 'pg',
        genderSuitability: property.gender || 'any',
        amenities: property.amenities?.map(a => typeof a === 'string' ? a : a.name) || [],
        photos: listingImages,
        latitude: property.latitude,
        longitude: property.longitude,
        description: property.description || ''
      },
      // Sync root level fields for premium UI
      amenities: property.amenities || [],
      propertyViews: (property.propertyViews || []).filter((v) => {
        const label = String(v?.label || '').toLowerCase();
        return !label.includes('camera') && !label.includes('live');
      }),
      facilities: property.facilities || {},
      exclusiveBenefits: property.exclusiveBenefits || [],
      roomTypes: property.roomTypes || [],
      propertyDetails: property.propertyDetails || {},
      pricing: property.pricing || {},
      policies: property.policies || {},
      tenantDescription: property.tenantDescription || "",
      seo: property.seo || {},
      latitude: property.latitude,
      longitude: property.longitude,
      generatedCredentials: {
        ownerName: property.ownerName || 'Verified Owner',
        loginId: property.ownerLoginId || ''
      },
      isLiveOnWebsite: true,
      // Must stay 'approved': the public website endpoints
      // (/api/approved-properties/public/approved and /all) filter on it.
      status: 'approved',
      updatedAt: new Date()
    };

    await ApprovedProperty.findOneAndUpdate(
      { visitId: vId },
      approvedPropertyData,
      { upsert: true, new: true }
    );
    console.log(`✅ Synced property ${property._id} to website`);

    // Auto-complete any pending Property Edit / Room Photo Edit tickets for this property/owner
    try {
      const SupportTicket = require('../models/SupportTicket');
      const mailer = require('../utils/mailer');
      const fcmService = require('../services/fcmService');
      
      const openEditTickets = await SupportTicket.find({
        $or: [
          { property_id: String(property._id) },
          { property_id: property.visitId },
          { owner_id: property.ownerLoginId || property.owner }
        ],
        ticket_type: { $in: ['Property Edit Request', 'Room Photo Edit Request'] },
        status: { $in: ['Open', 'In Progress', 'Assigned', 'Waiting For Response'] }
      });

      for (const t of openEditTickets) {
        t.status = 'Completed';
        t.resolution_notes = 'Property & Room edit request completed and synced live to Roomhy.';
        t.resolved_at = new Date();
        t.activity_log.push({
          action: 'Auto-Completed on Property Edit',
          performed_by: 'system',
          performed_by_name: 'System Sync Engine',
          from_status: t.status,
          to_status: 'Completed',
          note: 'Property edit was approved/updated and synced live.',
          at: new Date()
        });
        await t.save();
        console.log(`🎉 Support ticket ${t.ticket_id} auto-completed on property sync!`);

        // Notify Owner via Email & Push
        if (t.user_email) {
          await mailer.sendMail(
            t.user_email,
            `✅ Ticket Completed: [${t.ticket_id}] ${t.subject}`,
            `Your property edit request ${t.ticket_id} has been completed!`,
            `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;"><div style="background: #10b981; color: #fff; padding: 20px; text-align: center;"><h2>Ticket Completed ✅</h2><p>Ref ID: <strong>${t.ticket_id}</strong></p></div><div style="padding: 20px;"><p>Hi <strong>${t.raised_by_name}</strong>,</p><p>Your property edit request <strong>"${t.subject}"</strong> has been completed and synced live to Roomhy.</p></div></div>`
          ).catch(() => {});
        }
        if (t.raised_by) {
          await fcmService.sendToUser(t.raised_by, {
            title: `✅ Ticket Completed: ${t.ticket_id}`,
            body: `Your property edit request "${t.subject}" has been updated live!`,
            icon: '/pwa-192x192.png',
            clickAction: '/propertyowner/support'
          }).catch(() => {});
        }
      }
    } catch (ticketErr) {
      console.warn('Auto-ticket completion warning:', ticketErr.message);
    }
  } catch (err) {
    console.error('❌ Sync to ApprovedProperty failed:', err);
  }
};

// Create / Add a new Property with auto-geocoding
exports.addProperty = async (req, res) => {
  try {
    const propertyData = sanitizePropertyPayload(req.body);
    propertyData.locationCode = deriveLocationCode(propertyData);

    // Auto-geocode address to lat/long ONLY IF coordinates are not already provided
    if ((!propertyData.latitude || !propertyData.longitude) && propertyData.address && propertyData.address.trim()) {
      try {
        const geo = await geocodeAddress(propertyData.address);
        propertyData.latitude = geo.latitude;
        propertyData.longitude = geo.longitude;
        console.log(`Geocoded "${propertyData.address}" → ${geo.latitude}, ${geo.longitude}`);
      } catch (geoErr) {
        console.warn('Geocoding failed, saving without coordinates:', geoErr.message);
      }
    }

    // Only superadmin/admin can directly make a property active/live.
    // Employees and area managers submit properties for admin approval.
    const isSuperAdmin = req.user && ['superadmin', 'admin'].includes(req.user.role);
    const isEmployeeOrManager = req.user && ['employee', 'manager', 'areamanager'].includes(req.user.role);
    const isStaff = isSuperAdmin || req.body.status === 'active';

    if (isSuperAdmin || req.body.status === 'active') {
      propertyData.status = req.body.status || 'active';
      propertyData.isPublished = propertyData.status === 'active';
      propertyData.isLiveOnWebsite = propertyData.status === 'active';
    } else {
      // employee, areamanager, owner — all go to pending_approval
      propertyData.status = 'pending_approval';
      propertyData.isPublished = false;
      propertyData.isLiveOnWebsite = false;
      if (isEmployeeOrManager) {
        propertyData.isEmployeeSubmitted = true;
        propertyData.submittedByRole = req.user.role;
        propertyData.submittedByLoginId = req.user.loginId || '';
      }
    }

    // Auto-assign to area employee for pending properties
    // 🤖 Auto-assign property verification to employee (with fallbacks)
    let autoAssignedTo = null;
    let autoAssignedToName = null;
    // Captured alongside the two above so the later assignment-email block
    // doesn't need a second Employee.findOne() just to fetch this same
    // employee's address again (was T-9 in the audit).
    let autoAssignedEmail = null;
    if (propertyData.status === 'pending_approval') {
      try {
        const Employee = require('../models/Employee');
        const User = require('../models/user');
        const pCity = propertyData.city || propertyData.locationCode || '';
        const pArea = propertyData.locality || propertyData.area || '';

        let areaEmployee = null;
        if (pCity || pArea) {
          areaEmployee = await Employee.findOne({
            isActive: { $ne: false },
            isDeleted: { $ne: true },
            $or: [
              { city: new RegExp(pCity, 'i'), area: new RegExp(pArea, 'i') },
              { city: new RegExp(pCity, 'i') },
              { locationCode: new RegExp(pCity, 'i') },
              { area: new RegExp(pArea, 'i') }
            ]
          }).select('name loginId role email').lean();
        }

        if (!areaEmployee) {
          areaEmployee = await Employee.findOne({
            isActive: { $ne: false },
            isDeleted: { $ne: true }
          }).select('name loginId role email').lean();
        }

        if (!areaEmployee) {
          areaEmployee = await User.findOne({
            role: 'employee',
            isActive: { $ne: false }
          }).select('name loginId role email').lean();
        }

        if (areaEmployee) {
          autoAssignedTo = areaEmployee.loginId || String(areaEmployee._id);
          autoAssignedToName = areaEmployee.name || areaEmployee.loginId;
          autoAssignedEmail = areaEmployee.email || null;
        }
      } catch (autoErr) {
        console.warn('Auto-assign property verification warning:', autoErr.message);
      }
    }

    const property = new Property(propertyData);
    if (autoAssignedTo) {
      property.assignedTo = autoAssignedTo;
      property.assignedToName = autoAssignedToName;
      console.log(`🤖 Property "${property.title}" auto-assigned for verification to employee ${autoAssignedToName} (${autoAssignedTo})`);

      try {
        const fcmService = require('../services/fcmService');
        fcmService.sendToUser(autoAssignedTo, {
          title: `🏢 Property Verification Assigned`,
          body: `New property "${property.title}" in ${property.city || property.address} assigned for verification.`,
          icon: '/pwa-192x192.png',
          clickAction: '/employee/properties',
          data: { propertyId: String(property._id), type: 'property_assigned' }
        }).catch(() => {});
      } catch (_) {}
    }
    await property.save();

    // Notify superadmins if it requires approval
    if (!isStaff) {
      try {
        const User = require('../models/user');
        const { sendMail } = require('../utils/mailer');
        const superAdmins = await User.find({ role: 'superadmin' }).lean();
        for (const sa of superAdmins) {
          await Notification.create({
            toRole: 'superadmin',
            toLoginId: sa.loginId || '',
            from: req.user?.loginId || 'owner',
            type: 'new_property_request',
            message: `New property approval request submitted for "${property.title}" — ${autoAssignedTo ? `assigned to ${autoAssignedToName || autoAssignedTo} for verification` : 'no employee matched, needs manual assignment'}`,
            meta: {
              propertyId: property._id.toString(),
              propertyTitle: property.title
            }
          });
        }
        // Email to superadmin
        const superadminEmail = process.env.SUPERADMIN_EMAIL || 'team@roomhy.com';
        const propUrl = `${(process.env.APP_URL || 'https://app.roomhy.com').replace(/\/$/, '')}/superadmin/properties`;
        const assignedLine = autoAssignedTo
          ? `<li><strong>Assigned To:</strong> ${autoAssignedToName || autoAssignedTo} (${autoAssignedTo}) — verification pending in employee panel</li>`
          : `<li><strong>Assigned To:</strong> No matching employee found — requires manual assignment</li>`;
        const emailHtml = `<div style="font-family:Arial,sans-serif;">
          <h3>New Property Listing Request</h3>
          <p>A new property has been submitted for verification.</p>
          <ul>
            <li><strong>Title:</strong> ${property.title || '-'}</li>
            <li><strong>City:</strong> ${property.city || '-'}</li>
            <li><strong>Area:</strong> ${property.area || '-'}</li>
            <li><strong>Owner:</strong> ${req.user?.loginId || '-'}</li>
            ${assignedLine}
          </ul>
          <p><a href="${propUrl}" style="background:#6366f1;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Review in Admin Panel</a></p>
        </div>`;
        sendMail(superadminEmail, `New Property Request: ${property.title}`, '', emailHtml).catch(e => console.warn('Superadmin property email failed:', e.message));
      } catch (notifyErr) {
        console.warn('Property request notification failed:', notifyErr.message);
      }
    }

    // Auto-approve and make live on website
    await syncToApprovedProperty(property);

    // Clear cached listings so the new property shows up immediately
    clearCache('/api/approved-properties');
    clearCache('/api/properties');
    // Send assignment notification + email if auto-assigned
    if (autoAssignedTo && !isStaff) {
      try {
        await Notification.create({
          toRole: 'employee',
          toLoginId: autoAssignedTo,
          from: req.user?.loginId || 'system',
          type: 'property_assigned',
          message: `New property "${property.title}" assigned to you for verification (${property.city || ''} ${property.area || ''})`,
          meta: {
            propertyId: property._id.toString(),
            propertyTitle: property.title,
            city: property.city || '',
            area: property.area || ''
          }
        });
        // Email to matched employee — reuse the email already resolved above;
        // only re-query if it wasn't captured there for some reason.
        const { sendMail } = require('../utils/mailer');
        let empEmail = autoAssignedEmail || '';
        if (!empEmail) {
          const Employee = require('../models/Employee');
          const empDoc = await Employee.findOne({ loginId: autoAssignedTo }).select('email').lean();
          empEmail = empDoc?.email || '';
        }
        if (empEmail) {
          const empHtml = `<div style="font-family:Arial,sans-serif;">
            <h3>New Property Assigned for Verification</h3>
            <p>A new property in your area has been submitted and assigned to you.</p>
            <ul>
              <li><strong>Title:</strong> ${property.title || '-'}</li>
              <li><strong>City:</strong> ${property.city || '-'}</li>
              <li><strong>Area:</strong> ${property.area || '-'}</li>
              <li><strong>Owner:</strong> ${req.user?.loginId || '-'}</li>
            </ul>
            <p>Please review and verify this property in your panel.</p>
          </div>`;
          sendMail(empEmail, `Property Assigned: ${property.title}`, '', empHtml).catch(e => console.warn('Employee property email failed:', e.message));
        }
      } catch (notifyErr) {
        console.warn('Property assignment notification failed:', notifyErr.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Property created successfully',
      property
    });
  } catch (err) {
    console.error('Add Property Error:', err);
    res.status(500).json({ success: false, message: 'Failed to create property', error: err.message });
  }
};

// Get single property by ID
exports.getPropertyById = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid property ID format' });
    }
    const propertyDoc = await Property.findById(req.params.id).populate('owner', 'name phone email');
    if (!propertyDoc) return res.status(404).json({ success: false, message: 'Property not found' });
    const { flattenListingImages } = require('../utils/propertyGallery');
    const propertyObj = propertyDoc.toObject ? propertyDoc.toObject() : { ...propertyDoc };
    const cleanImages = flattenListingImages(propertyObj);
    propertyObj.images = cleanImages;
    propertyObj.featuredImage = cleanImages[0] || '';
    res.json({ success: true, property: propertyObj });
  } catch (err) {
    console.error('Get Property Error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get ALL Properties (For Super Admin & Area Manager lists) with Pagination
exports.getAllProperties = async (req, res) => {
  try {
    const { applyPropertyScope } = require('../utils/scopeHelpers');
    let filter = { isDeleted: { $ne: true } };

    if (req.employeeScope && req.employeeScope.isEmployee) {
      filter = applyPropertyScope(req, filter);
    }

    if (req.query.ownerLoginId) {
      filter.ownerLoginId = String(req.query.ownerLoginId).toUpperCase();
    }
    if (req.query.pendingApproval === 'true') {
      filter.status = 'pending_approval';
    }
    if (req.query.pendingChanges === 'true') {
      filter['pendingChanges.status'] = 'pending';
    }
    if (req.query.assignedTo) {
      const assignedVal = String(req.query.assignedTo).trim();
      const isObjId = mongoose.Types.ObjectId.isValid(assignedVal);
      const assignedClause = [
        { 'pendingChanges.assignedToName': new RegExp(`^${assignedVal}$`, 'i') },
        { 'assignedToName': new RegExp(`^${assignedVal}$`, 'i') }
      ];
      if (isObjId) {
        assignedClause.push({ 'pendingChanges.assignedTo': new mongoose.Types.ObjectId(assignedVal) });
        assignedClause.push({ 'assignedTo': new mongoose.Types.ObjectId(assignedVal) });
      }
      if (filter.$or) {
        filter = { $and: [filter, { $or: assignedClause }] };
      } else {
        filter.$or = assignedClause;
      }
    }

    const page = parseInt(req.query.page) || 1;
    const limit = req.query.limit ? parseInt(req.query.limit) : 1000;
    const skip = (page - 1) * limit;

    // Run counts in parallel
    const [total, publishedCount, inactiveCount, rejectedCount] = await Promise.all([
      Property.countDocuments(filter),
      Property.countDocuments({ ...filter, $or: [{ isLiveOnWebsite: true }, { status: 'active' }] }),
      Property.countDocuments({ ...filter, status: 'inactive' }),
      Property.countDocuments({ ...filter, status: 'blocked' })
    ]);

    const pendingCount = total - (publishedCount + inactiveCount + rejectedCount);

    const { flattenListingImages } = require('../utils/propertyGallery');
    const properties = await Property.find(filter)
      .populate('owner', 'name phone email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Auto-assignment of unassigned pending properties to an area employee used
    // to run inline here — up to 3 Employee lookups + a write per unassigned
    // property, on every GET. It now runs off the request path in
    // jobs/ownerPropertyHealJob.js's healPendingPropertyAssignments(), batched
    // and on a schedule (see that file for details). A newly-submitted pending
    // property will show no assignee here until that job's next run rather
    // than instantly — the read-only tradeoff is intentional.

    // Sanitize property images array to strictly exclude live camera photos
    const cleanedProperties = properties.map(p => {
      const obj = p.toObject ? p.toObject() : { ...p };
      const cleanImages = flattenListingImages(obj);
      obj.images = cleanImages;
      obj.featuredImage = cleanImages[0] || '';
      return obj;
    });

    res.json({
      success: true,
      properties: cleanedProperties,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      stats: {
        published: publishedCount,
        pending: Math.max(0, pendingCount),
        inactive: inactiveCount,
        rejected: rejectedCount
      }
    });
  } catch (err) {
    console.error("Get Properties Error:", err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update property with new fields (amenities, benefits, views)
exports.updateProperty = async (req, res) => {
  try {
    const propId = req.params.id;
    const updateData = sanitizePropertyPayload(req.body);
    if (Object.prototype.hasOwnProperty.call(updateData, 'locationCode') || !updateData.locationCode) {
      updateData.locationCode = deriveLocationCode(updateData);
    }

    // Auto-geocode if address changed and coordinates are not already provided
    if ((!updateData.latitude || !updateData.longitude) && updateData.address && updateData.address.trim()) {
      try {
        const geo = await geocodeAddress(updateData.address);
        updateData.latitude = geo.latitude;
        updateData.longitude = geo.longitude;
      } catch (geoErr) {
        console.warn('Geocoding failed:', geoErr.message);
      }
    }

    let property = await Property.findById(propId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    Object.assign(property, updateData);
    await property.save();

    // Re-fetch to populate owner details cleanly
    property = await Property.findById(propId).populate('owner', 'name phone email');

    // Sync with ApprovedProperty
    await syncToApprovedProperty(property);

    // If not active OR not live, ensure it's removed from website listing.
    // Must be the exact inverse of the sync guard, otherwise a synced property
    // gets deleted again in the same request.
    if (!isPropertyLive(property)) {
      try {
        await ApprovedProperty.deleteMany({
          visitId: property.visitId || property._id.toString()
        });
        console.log(`Removed property ${property._id} from ApprovedProperty (Inactive or Not Live)`);
      } catch (removeErr) {
        console.warn('Failed to remove property from website listing:', removeErr);
      }
    }

    // Clear API cache to reflect changes immediately
    clearCache('/api/approved-properties');
    clearCache('/api/properties');

    res.json({ success: true, message: 'Property updated successfully', property });
  } catch (err) {
    console.error('Update Property Error:', err);
    res.status(500).json({ success: false, message: 'Failed to update property', error: err.message });
  }
};

// =====================================================================
// OWNER EDIT REQUEST — saves changes as pendingChanges (no live update)
// =====================================================================
// Roles that manage properties on behalf of any owner (mirrors authorize('superadmin')'s
// expansion in authMiddleware.js) — exempt from the ownership check below.
const PROPERTY_ADMIN_ROLES = new Set(['superadmin', 'admin', 'employee', 'areamanager', 'manager']);

exports.ownerEditRequest = async (req, res) => {
  try {
    const propId = req.params.id;
    const { updatedData, reason, ownerLoginId } = req.body;

    const property = await Property.findById(propId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    // Only the property's own owner (or an admin-family role) may request
    // edits — never trust the ownerLoginId in the request body for this,
    // it's only used below for the notification text.
    if (!PROPERTY_ADMIN_ROLES.has(req.user.role) &&
      String(property.ownerLoginId || '').toUpperCase() !== String(req.user.loginId || '').toUpperCase()) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this property.' });
    }

    // A blocked property was rejected by admin review — it cannot be edited
    // back into shape by the owner; they must contact support instead.
    if (property.status === 'blocked') {
      return res.status(403).json({ success: false, message: 'This property has been blocked and cannot be edited. Please contact support.' });
    }

    // Save changes in pendingChanges — DO NOT update live fields
    property.pendingChanges = {
      data: updatedData || {},
      requestedAt: new Date(),
      requestedBy: ownerLoginId || property.ownerLoginId || 'Unknown',
      reason: reason || '',
      status: 'pending'
    };
    await property.save();

    // Also send notification to superadmin
    try {
      const notification = new Notification({
        to: 'SUPERADMIN',
        from: ownerLoginId || property.ownerLoginId || 'Owner',
        type: 'owner_edit_request',
        title: '✏️ Property Edit Request',
        message: `Owner ${ownerLoginId || property.ownerLoginId} has requested changes to "${property.title}". Reason: ${reason || 'Not specified'}`,
        data: {
          propertyId: property._id,
          propertyName: property.title,
          ownerLoginId: ownerLoginId || property.ownerLoginId,
          reason
        },
        read: false,
        createdAt: new Date()
      });
      await notification.save();
    } catch (notifErr) {
      console.warn('Notification save failed (non-critical):', notifErr.message);
    }

    res.json({
      success: true,
      message: 'Edit request submitted successfully. Awaiting admin approval.',
      pendingChanges: property.pendingChanges
    });
  } catch (err) {
    console.error('Owner Edit Request Error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit edit request', error: err.message });
  }
};

// =====================================================================
// APPROVE OWNER CHANGES — apply pendingChanges to live property
// =====================================================================
exports.approveOwnerChanges = async (req, res) => {
  try {
    const propId = req.params.id;
    const property = await Property.findById(propId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
    if (!property.pendingChanges || property.pendingChanges.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'No pending changes found' });
    }

    const changes = property.pendingChanges.data || {};

    // Apply safe fields only (exclude critical admin-only fields)
    const allowedFields = [
      'title', 'description', 'address', 'city', 'locality', 'landmark',
      'latitude', 'longitude', 'monthlyRent', 'discount', 'gender',
      'propertyType', 'images', 'propertyViews', 'amenities', 'facilities',
      'propertyDetails', 'pricing', 'policies', 'tenantDescription', 'roomTypes',
      'contact', 'videoUrl', 'seo'
    ];
    allowedFields.forEach(field => {
      if (changes[field] !== undefined) {
        property[field] = changes[field];
      }
    });

    property.pendingChanges.status = 'approved';
    property.updatedAt = new Date();
    await property.save();

    // Re-sync with website if live
    await syncToApprovedProperty(property);
    clearCache('/api/approved-properties');
    clearCache('/api/properties');

    // Notify owner
    try {
      const notification = new Notification({
        to: property.ownerLoginId,
        from: 'SUPERADMIN',
        type: 'edit_approved',
        title: '✅ Edit Request Approved',
        message: `Your edit request for "${property.title}" has been approved and is now live.`,
        data: { propertyId: property._id },
        read: false,
        createdAt: new Date()
      });
      await notification.save();
    } catch (notifErr) {
      console.warn('Notification save failed (non-critical):', notifErr.message);
    }

    res.json({ success: true, message: 'Changes approved and applied successfully', property });
  } catch (err) {
    console.error('Approve Changes Error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve changes', error: err.message });
  }
};

// =====================================================================
// REJECT OWNER CHANGES — discard pendingChanges
// =====================================================================
exports.rejectOwnerChanges = async (req, res) => {
  try {
    const propId = req.params.id;
    const { rejectReason } = req.body;
    const property = await Property.findById(propId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
    if (!property.pendingChanges || property.pendingChanges.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'No pending changes found' });
    }

    property.pendingChanges.status = 'rejected';
    property.pendingChanges.reason = rejectReason || property.pendingChanges.reason;
    await property.save();

    // Notify owner of rejection
    try {
      const notification = new Notification({
        to: property.ownerLoginId,
        from: 'SUPERADMIN',
        type: 'edit_rejected',
        title: '❌ Edit Request Rejected',
        message: `Your edit request for "${property.title}" was rejected. ${rejectReason ? 'Reason: ' + rejectReason : ''}`,
        data: { propertyId: property._id, rejectReason },
        read: false,
        createdAt: new Date()
      });
      await notification.save();
    } catch (notifErr) {
      console.warn('Notification save failed (non-critical):', notifErr.message);
    }

    res.json({ success: true, message: 'Changes rejected successfully' });
  } catch (err) {
    console.error('Reject Changes Error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject changes', error: err.message });
  }
};

// Publish property (Super Admin action)
exports.publishProperty = async (req, res) => {
  try {
    const propId = req.params.id;
    const property = await Property.findById(propId);
    if (!property) return res.status(404).json({ message: 'Property not found' });

    property.status = 'active';
    property.isPublished = true;
    property.isLiveOnWebsite = true;
    await property.save();

    // Sync with ApprovedProperty collection for website visibility
    await syncToApprovedProperty(property);

    // Clear API cache to reflect changes immediately
    clearCache('/api/approved-properties');
    clearCache('/api/properties');

    res.json({ success: true, message: 'Property published successfully', property });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Unpublish property (Super Admin action)
exports.unpublishProperty = async (req, res) => {
  try {
    const propId = req.params.id;
    const property = await Property.findById(propId);
    if (!property) return res.status(404).json({ message: 'Property not found' });

    property.isPublished = false;
    property.isLiveOnWebsite = false;
    await property.save();

    // Remove from ApprovedProperty
    try {
      await ApprovedProperty.deleteMany({
        $or: [
          { visitId: property.visitId || property._id.toString() },
          { propertyId: property.propertyId || "" },
          { 'generatedCredentials.loginId': property.ownerLoginId || "" }
        ]
      });
    } catch (syncErr) {
      console.error('Removal from ApprovedProperty failed during unpublish:', syncErr);
    }

    // Clear API cache to reflect changes immediately
    clearCache('/api/approved-properties');
    clearCache('/api/properties');

    res.json({ success: true, message: 'Property unpublished successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Submit property enquiry (from list.html)
exports.submitEnquiry = async (req, res) => {
  try {
    const enquiryData = req.body;

    // Find area manager based on city/locality
    const city = enquiryData.city || enquiryData.locality;
    let assignedManager = null;

    if (city) {
      // Try to find area manager by city or area code
      assignedManager = await Employee.findOne({
        role: 'areamanager',
        $or: [
          { city: new RegExp(city, 'i') },
          { area: new RegExp(city, 'i') },
          { areaCode: new RegExp(city.substring(0, 2), 'i') },
          { locationCode: new RegExp(city.substring(0, 2), 'i') }
        ],
        isActive: true
      });
    }

    // If no specific manager found, assign to first available area manager
    if (!assignedManager) {
      assignedManager = await Employee.findOne({
        role: 'areamanager',
        isActive: true
      });
    }

    // Create the enquiry
    const enquiry = new Enquiry({
      ...enquiryData,
      status: 'pending_review',
      assignedTo: assignedManager ? assignedManager.loginId : null,
      ts: Date.now()
    });

    await enquiry.save();

    // Send notification to area manager if assigned
    if (assignedManager) {
      const notification = new Notification({
        to: assignedManager.loginId,
        from: 'SYSTEM',
        type: 'property_enquiry',
        title: 'New Property Enquiry',
        message: `New property enquiry from ${enquiryData.owner_name || 'Unknown'} for ${enquiryData.property_name || 'Property'} in ${city || 'Unknown location'}`,
        data: {
          enquiryId: enquiry._id,
          propertyName: enquiryData.property_name,
          ownerName: enquiryData.owner_name,
          city: city
        },
        read: false,
        createdAt: new Date()
      });

      await notification.save();
    }

    res.json({
      success: true,
      message: 'Property enquiry submitted successfully',
      enquiry: enquiry,
      assignedTo: assignedManager ? `${assignedManager.name} (${assignedManager.loginId})` : 'No area manager found'
    });

  } catch (err) {
    console.error('Submit Enquiry Error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to submit enquiry',
      error: err.message
    });
  }
};

// Delete property
exports.deleteProperty = async (req, res) => {
  try {
    const propId = req.params.id;
    const property = await Property.findById(propId);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });

    // Remove ALL instances from ApprovedProperty as well (to clear duplicates)
    await ApprovedProperty.deleteMany({
      $or: [
        { visitId: property.visitId || property._id.toString() },
        { propertyId: property.propertyId || "" },
        { 'generatedCredentials.loginId': property.ownerLoginId || "" }
      ]
    });

    // 1. Soft delete all rooms belonging to this property
    const Room = require('../models/Room');
    await Room.updateMany({ property: propId }, { $set: { isDeleted: true } });

    // 2. Mark all active/pending tenants in this property as checked out / inactive (Ex-Tenants) and soft-delete their credentials
    const Tenant = require('../models/Tenant');
    const User = require('../models/user');

    // Batched: Tenant has no pre('save') hook and every tenant here gets the
    // exact same fields set, so this no longer needs a per-tenant loop (was
    // T-10 in the audit — an unselective fetch plus 2-3 writes per tenant).
    const propertyTenants = await Tenant.find({ property: propId }).select('_id user loginId').lean();

    const tenantUserIds = propertyTenants.map(t => t.user).filter(Boolean);
    const tenantLoginIds = propertyTenants.map(t => t.loginId).filter(Boolean);

    if (tenantUserIds.length > 0) {
      await User.updateMany({ _id: { $in: tenantUserIds } }, { $set: { isDeleted: true, isActive: false } });
    }
    if (tenantLoginIds.length > 0) {
      await User.updateMany({ loginId: { $in: tenantLoginIds }, role: 'tenant' }, { $set: { isDeleted: true, isActive: false } });
    }

    if (propertyTenants.length > 0) {
      await Tenant.updateMany(
        { property: propId },
        { $set: { status: 'inactive', isDeleted: true }, $unset: { room: '' } }
      );
    }

    // Soft delete the property itself
    property.isDeleted = true;
    property.status = 'inactive';
    property.isPublished = false;
    property.isLiveOnWebsite = false;
    await property.save();

    // Clear API cache to reflect changes immediately
    clearCache('/api/approved-properties');
    clearCache('/api/properties');

    res.json({ success: true, message: 'Property deleted successfully' });
  } catch (err) {
    console.error('Delete Property Error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete property', error: err.message });
  }
};

// Assign property verification task to employee
// Exported for maintenance scripts (scripts/repair-website-visibility.js) so
// backfills reuse the exact same sync logic instead of copying it.
exports.syncToApprovedProperty = syncToApprovedProperty;
exports.isPropertyLive = isPropertyLive;

exports.assignPropertyVerification = async (req, res) => {
  try {
    const propId = req.params.id;
    const { employeeId, employeeName } = req.body;
    const property = await Property.findById(propId);
    if (!property) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }

    // Auto-assign to employee of same city/area if no employee specified
    let assignedEmployeeId = employeeId;
    let assignedEmployeeName = employeeName;

    if (!assignedEmployeeId) {
      // Find employee matching property's city/area
      const propertyCity = property.city || property.locationCode || '';
      const propertyArea = property.locality || property.area || '';

      const matchingEmployee = await Employee.findOne({
        isActive: true,
        isDeleted: false,
        $or: [
          { city: propertyCity },
          { locationCode: propertyCity },
          { area: propertyArea },
          { areaCode: propertyArea }
        ]
      });

      if (matchingEmployee) {
        assignedEmployeeId = matchingEmployee._id;
        assignedEmployeeName = matchingEmployee.name;
      } else {
        // No employee found for this area
        return res.json({
          success: false,
          message: "No employee of that area, you can assign",
          autoAssignFailed: true,
          property
        });
      }
    }

    // If it's a new property pending approval (status === 'pending_approval')
    if (property.status === 'pending_approval') {
      property.assignedTo = assignedEmployeeId;
      property.assignedToName = assignedEmployeeName;
    } else if (property.pendingChanges && property.pendingChanges.status === 'pending') {
      // If it's an edit request
      property.pendingChanges.assignedTo = assignedEmployeeId;
      property.pendingChanges.assignedToName = assignedEmployeeName;
    } else {
      return res.status(400).json({ success: false, message: "Property has no pending creation or edit request to assign" });
    }

    await property.save();
    res.json({ success: true, message: `Property verification assigned to ${assignedEmployeeName}`, property });
  } catch (err) {
    console.error("Error assigning property verification:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
