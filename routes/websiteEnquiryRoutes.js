const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const WebsiteEnquiry = require('../models/WebsiteEnquiry');
const Owner = require('../models/Owner');
const Employee = require('../models/Employee');
const { sendMail } = require('../utils/mailer');
const { notifySuperadmin } = require('../utils/superadminNotifier');
const { formLimiter, captchaProtection } = require('../middleware/security');
const { protect, authorize } = require('../middleware/authMiddleware');
const { auditTrail } = require('../middleware/auditTrail');

// ============================================================
// POST: Submit a new website enquiry
// ============================================================
router.post('/submit', formLimiter, captchaProtection({ required: false }), async (req, res) => {
    try {
        const {
            property_type,
            property_name,
            city,
            locality,
            address,
            pincode,
            description,
            amenities,
            gender_suitability,
            rent,
            deposit,
            owner_name,
            owner_email,
            owner_phone,
            contact_name,
            country,
            tenants_managed,
            additional_message,
            photos
        } = req.body;

        // Validate required fields
        if (!property_name || !city || !owner_name || !owner_phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: property_name, city, owner_name, owner_phone'
            });
        }

        // Create unique enquiry ID
        const enquiry_id = Date.now() + '_' + Math.random().toString(36).substr(2, 9);

        // Create new enquiry
        const enquiry = new WebsiteEnquiry({
            enquiry_id,
            property_type,
            property_name,
            city,
            locality,
            address,
            pincode,
            description,
            amenities: amenities || [],
            gender_suitability,
            rent: parseInt(rent) || 0,
            deposit,
            owner_name,
            owner_email,
            owner_phone,
            contact_name,
            country,
            tenants_managed: Number(tenants_managed) || 0,
            additional_message,
            photos: photos || [],
            status: 'pending'
        });

        // Save to MongoDB
        await enquiry.save();

        try {
            await notifySuperadmin({
                type: 'new_enquiry',
                from: 'website',
                subject: `New Website Enquiry - ${property_name || 'Property'}`,
                message: 'A new website property enquiry is waiting for review.',
                meta: {
                    enquiryId: enquiry_id,
                    userName: owner_name || '',
                    userEmail: owner_email || '',
                    propertyName: property_name || '',
                    city: city || '',
                    ownerPhone: owner_phone || ''
                }
            });
        } catch (notifyErr) {
            console.warn('website enquiry notification failed:', notifyErr.message);
        }

        res.status(201).json({
            success: true,
            message: 'Enquiry submitted successfully',
            enquiry_id: enquiry_id,
            enquiry: enquiry
        });

    } catch (error) {
        console.error('Error submitting enquiry:', error);
        res.status(500).json({
            success: false,
            message: 'Error submitting enquiry',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch all website enquiries
// ============================================================
router.get('/all', async (req, res) => {
    try {
        const enquiries = await WebsiteEnquiry.find().sort({ created_at: -1 });

        res.status(200).json({
            success: true,
            count: enquiries.length,
            enquiries: enquiries
        });

    } catch (error) {
        console.error('Error fetching enquiries:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching enquiries',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch enquiries by city
// ============================================================
router.get('/city/:city', async (req, res) => {
    try {
        const { city } = req.params;
        const enquiries = await WebsiteEnquiry.find({ city }).sort({ created_at: -1 });

        res.status(200).json({
            success: true,
            count: enquiries.length,
            enquiries: enquiries
        });

    } catch (error) {
        console.error('Error fetching enquiries by city:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching enquiries',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch enquiries by status
// ============================================================
router.get('/status/:status', async (req, res) => {
    try {
        const { status } = req.params;
        const enquiries = await WebsiteEnquiry.find({ status }).sort({ created_at: -1 });

        res.status(200).json({
            success: true,
            count: enquiries.length,
            enquiries: enquiries
        });

    } catch (error) {
        console.error('Error fetching enquiries by status:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching enquiries',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch active marketing employees for assignment modal
// ============================================================
router.get('/employees/marketing', async (req, res) => {
    try {
        const employees = await Employee.find({
            role: 'Marketing Team',
            isActive: true
        })
            .sort({ createdAt: -1 })
            .select('name loginId email phone role area city areaCode locationCode isActive')
            .lean();

        return res.status(200).json({
            success: true,
            count: employees.length,
            employees
        });
    } catch (error) {
        console.error('Error fetching marketing employees:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching marketing employees',
            error: error.message
        });
    }
});

// ============================================================
// POST: Assign enquiry to an employee and send notification email
// ============================================================
router.post('/assign/:enquiryId', async (req, res) => {
    try {
        const { enquiryId } = req.params;
        const {
            assigned_to_loginId,
            assigned_to,
            assigned_area,
            status = 'assigned',
            notes
        } = req.body || {};

        const lookup = [{ enquiry_id: enquiryId }];
        if (mongoose.Types.ObjectId.isValid(enquiryId)) {
            lookup.push({ _id: enquiryId });
        }
        const enquiry = await WebsiteEnquiry.findOne({ $or: lookup });

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        let employee = null;
        if (assigned_to_loginId) {
            employee = await Employee.findOne({ loginId: assigned_to_loginId, isActive: true }).lean();
        }
        if (!employee && assigned_to) {
            employee = await Employee.findOne({ name: assigned_to, isActive: true }).lean();
        }

        if (!employee) {
            return res.status(400).json({
                success: false,
                message: 'Valid active employee not found for assignment'
            });
        }

        enquiry.status = status || 'assigned';
        enquiry.assigned_to = employee.name;
        enquiry.assigned_to_loginId = employee.loginId;
        enquiry.assigned_email = employee.email || null;
        enquiry.assigned_area = assigned_area || employee.area || employee.city || null;
        enquiry.assigned_date = new Date();
        if (typeof notes === 'string') enquiry.notes = notes;
        await enquiry.save();

        let employeeEmailSent = false;
        if (employee.email) {
            try {
                const subject = `New Website Enquiry Assigned - ${enquiry.property_name || 'Property'}`;
                const html = `
                    <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.6;">
                        <h2>New Enquiry Assigned</h2>
                        <p>Hi ${employee.name || 'Team Member'},</p>
                        <p>A website property enquiry has been assigned to you.</p>
                        <hr />
                        <p><strong>Property:</strong> ${enquiry.property_name || '-'}</p>
                        <p><strong>Owner Name:</strong> ${enquiry.owner_name || '-'}</p>
                        <p><strong>Contact Name:</strong> ${enquiry.contact_name || '-'}</p>
                        <p><strong>Owner Phone:</strong> ${enquiry.owner_phone || '-'}</p>
                        <p><strong>City:</strong> ${enquiry.city || '-'}</p>
                        <p><strong>Country:</strong> ${enquiry.country || '-'}</p>
                        <p><strong>Tenants Managed:</strong> ${enquiry.tenants_managed || 0}</p>
                        <p><strong>Additional Message:</strong> ${enquiry.additional_message || enquiry.description || '-'}</p>
                        <hr />
                        <p>Please follow up from the Web Enquiry panel.</p>
                    </div>
                `;
                employeeEmailSent = await sendMail(employee.email, subject, '', html);
            } catch (mailErr) {
                console.warn('website enquiry assignment email failed:', mailErr.message);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Enquiry assigned successfully',
            enquiry,
            employee: {
                loginId: employee.loginId,
                name: employee.name,
                email: employee.email || '',
                area: employee.area || '',
                city: employee.city || ''
            },
            email: {
                attempted: !!employee.email,
                sent: employeeEmailSent
            }
        });
    } catch (error) {
        console.error('Error assigning enquiry:', error);
        return res.status(500).json({
            success: false,
            message: 'Error assigning enquiry',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch enquiry by ID
// ============================================================
router.get('/:id', async (req, res) => {
    try {
        const enquiry = await WebsiteEnquiry.findById(req.params.id);

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        res.status(200).json({
            success: true,
            enquiry: enquiry
        });

    } catch (error) {
        console.error('Error fetching enquiry:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching enquiry',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Update/Approve enquiry
// ============================================================
router.put('/:id', protect, authorize('superadmin', 'areamanager'), auditTrail('website-enquiry'), async (req, res) => {
    try {
        const {
            status,
            notes,
            assigned_to,
            assigned_area,
            assigned_date
        } = req.body;

        const updateData = {
            status,
            notes,
            assigned_to: assigned_to || null,
            assigned_area: assigned_area || null,
            assigned_date: assigned_date || null,
            updated_at: new Date()
        };

        const enquiry = await WebsiteEnquiry.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true }
        );

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Enquiry updated successfully',
            enquiry: enquiry
        });

    } catch (error) {
        console.error('Error updating enquiry:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating enquiry',
            error: error.message
        });
    }
});

// ============================================================
// DELETE: Delete enquiry
// ============================================================
router.delete('/:id', protect, authorize('superadmin', 'areamanager'), auditTrail('website-enquiry'), async (req, res) => {
    try {
        const enquiry = await WebsiteEnquiry.findByIdAndDelete(req.params.id);

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Enquiry deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting enquiry:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting enquiry',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch enquiries assigned to specific employee
// ============================================================
router.get('/assigned-to/:loginId', async (req, res) => {
    try {
        const { loginId } = req.params;
        const enquiries = await WebsiteEnquiry.find({
            $or: [{ assigned_to_loginId: loginId }, { assigned_to: loginId }]
        }).sort({ created_at: -1 });

        res.status(200).json({
            success: true,
            count: enquiries.length,
            enquiries: enquiries
        });

    } catch (error) {
        console.error('Error fetching enquiries assigned to employee:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching enquiries',
            error: error.message
        });
    }
});

// ============================================================
// GET: Fetch enquiries by owner email/id and status (for chat integration)
// ============================================================
router.get('/', async (req, res) => {
    try {
        const { owner_email, owner_id, status } = req.query;

        let query = {};
        if (owner_email) {
            query.owner_email = owner_email;
        } else if (owner_id) {
            // If owner_id is provided, we need to find enquiries by owner_id
            // Since the model stores owner_email, we need to find enquiries where owner_email matches
            // For now, we'll assume owner_id might be stored differently or we need to handle this case
            // Let's check if owner_id is actually an email or if we need to look up the owner
            if (owner_id.includes('@')) {
                // If owner_id contains @, treat it as email
                query.owner_email = owner_id;
            } else {
                // If it's a loginId like ROOMHY9603, we need to find enquiries by this ID
                // For now, let's assume the owner_id is stored in a way we can query
                // This might need adjustment based on how enquiries are actually stored
                // Look up the owner by loginId to get their email
                const owner = await Owner.findOne({ loginId: owner_id });
                if (owner && owner.email) {
                    query.owner_email = owner.email;
                } else {
                    // If owner not found or no email, return empty result
                    return res.status(200).json({
                        success: true,
                        count: 0,
                        enquiries: []
                    });
                }
            }
        }
        if (status) query.status = status;

        const enquiries = await WebsiteEnquiry.find(query).sort({ created_at: -1 });

        res.status(200).json({
            success: true,
            count: enquiries.length,
            enquiries: enquiries
        });

    } catch (error) {
        console.error('Error fetching enquiries:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching enquiries',
            error: error.message
        });
    }
});

// ============================================================
// PUT: Update enquiry (assign to manager)
// ============================================================
router.put('/:enquiry_id', protect, authorize('superadmin', 'areamanager'), auditTrail('website-enquiry'), async (req, res) => {
    try {
        const { enquiry_id } = req.params;
        const { assigned_to, assigned_area, status, notes } = req.body;

        const enquiry = await WebsiteEnquiry.findOneAndUpdate(
            { enquiry_id },
            {
                assigned_to: assigned_to || undefined,
                assigned_area: assigned_area || undefined,
                status: status || undefined,
                notes: notes || undefined,
                assigned_date: (assigned_to && new Date()) || undefined
            },
            { new: true, runValidators: true }
        );

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Enquiry updated successfully',
            enquiry: enquiry
        });

    } catch (error) {
        console.error('Error updating enquiry:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating enquiry',
            error: error.message
        });
    }
});

// ============================================================
// DELETE: Delete an enquiry
// ============================================================
router.delete('/:enquiry_id', protect, authorize('superadmin', 'areamanager'), auditTrail('website-enquiry'), async (req, res) => {
    try {
        const { enquiry_id } = req.params;

        const enquiry = await WebsiteEnquiry.findOneAndDelete({ enquiry_id });

        if (!enquiry) {
            return res.status(404).json({
                success: false,
                message: 'Enquiry not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Enquiry deleted successfully',
            enquiry: enquiry
        });

    } catch (error) {
        console.error('Error deleting enquiry:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting enquiry',
            error: error.message
        });
    }
});

module.exports = router;
