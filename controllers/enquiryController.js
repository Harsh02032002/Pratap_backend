const Enquiry = require('../models/Enquiry');
const { notifySuperadmin } = require('../utils/superadminNotifier');

// Create a new enquiry
exports.createEnquiry = async (req, res) => {
  try {
    // Force status to 'request to connect' if not provided
    const payload = { ...req.body };
    if (!payload.status || payload.status === 'pending') {
      payload.status = 'request to connect';
    }
    const enquiry = await Enquiry.create(payload);

    try {
      await notifySuperadmin({
        type: 'new_enquiry',
        from: 'owner',
        subject: `New Property Enquiry - ${payload.propertyName || 'Property'}`,
        message: 'A new property enquiry was submitted and is pending review.',
        meta: {
          enquiryId: enquiry._id?.toString?.() || '',
          userName: payload.ownerName || payload.studentName || '',
          userEmail: payload.email || payload.studentEmail || '',
          propertyName: payload.propertyName || '',
          location: payload.location || ''
        }
      });
    } catch (notifyErr) {
      console.warn('enquiry notification failed:', notifyErr.message);
    }

    // Send email notification to superadmin
    try {
      const mailer = require('../utils/mailer');
      const superadminEmail = 'roomhy01@gmail.com';
      const subject = 'New Property Enquiry Submitted';
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">New Property Enquiry</h2>
          <p>A property owner has submitted a new enquiry.</p>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <p><strong>Owner:</strong> ${payload.ownerName || 'N/A'}</p>
            <p><strong>Property:</strong> ${payload.propertyName || 'N/A'}</p>
            <p><strong>Location:</strong> ${payload.location || 'N/A'}</p>
            <p><strong>Phone:</strong> ${payload.phone || 'N/A'}</p>
            <p><strong>Email:</strong> ${payload.email || 'Not provided'}</p>
            <p><strong>Message:</strong> ${payload.message || 'No message'}</p>
          </div>
          <p>Please review this enquiry in the superadmin panel.</p>
        </div>
      `;
      await mailer.sendMail(superadminEmail, subject, '', html);
    } catch (emailError) {
      console.error('Failed to send enquiry notification email:', emailError);
    }

    res.status(201).json(enquiry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// List all enquiries for an owner
exports.listEnquiries = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const enquiries = await Enquiry.find({ ownerLoginId }).sort({ ts: -1 });
    res.json(enquiries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update enquiry status (accept/reject)
exports.updateEnquiry = async (req, res) => {
  try {
    const { id } = req.params;
    const update = req.body;
    // If status is accepted, enable chat
    if (update.status === 'accepted') {
      update.chatOpen = true;
      update.visitAllowed = true;
    }
    if (update.status === 'rejected') {
      update.chatOpen = false;
      update.visitAllowed = false;
    }
    const enquiry = await Enquiry.findByIdAndUpdate(id, update, { new: true });
    if (!enquiry) return res.status(404).json({ error: 'Enquiry not found' });
    res.json(enquiry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
