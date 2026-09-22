const Announcement = require('../models/Announcement');

exports.getAnnouncementsByOwner = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const announcements = await Announcement.find({ ownerLoginId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, announcements });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.createAnnouncement = async (req, res) => {
  try {
    const { ownerLoginId, title, content, priority, date } = req.body;
    
    if (!ownerLoginId || !title || !content) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const newAnnouncement = new Announcement({
      ownerLoginId,
      title,
      content,
      priority: priority || 'Normal',
      date: date || new Date().toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' })
    });

    await newAnnouncement.save();
    res.status(201).json({ success: true, announcement: newAnnouncement });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedAnnouncement = await Announcement.findByIdAndDelete(id);
    
    if (!deletedAnnouncement) {
      return res.status(404).json({ success: false, message: 'Announcement not found' });
    }

    res.status(200).json({ success: true, message: 'Announcement deleted successfully' });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

/**
 * Broadcast announcement(s) to all tenants of an owner via push notification
 * POST /api/announcements/broadcast
 * Body: { announcementIds: string[], ownerLoginId: string, channels?: ['push','whatsapp'] }
 */
exports.broadcastAnnouncement = async (req, res) => {
  try {
    const { announcementIds, ownerLoginId, channels = ['push'] } = req.body;
    if (!Array.isArray(announcementIds) || announcementIds.length === 0 || !ownerLoginId) {
      return res.status(400).json({ success: false, message: 'announcementIds[] and ownerLoginId are required' });
    }

    const announcements = await Announcement.find({ _id: { $in: announcementIds }, ownerLoginId });
    if (announcements.length === 0) {
      return res.status(404).json({ success: false, message: 'No matching announcements found' });
    }

    // Fetch all active tenants for this owner and send push notifications
    const Tenant = require('../models/Tenant');
    const Notification = require('../models/Notification');
    const tenants = await Tenant.find({ ownerLoginId: ownerLoginId.toUpperCase(), status: 'active' }).select('_id name fcmToken loginId');

    let pushed = 0;
    for (const ann of announcements) {
      for (const tenant of tenants) {
        try {
          await Notification.create({
            userId: tenant._id,
            title: ann.title,
            message: ann.content,
            type: 'announcement',
            relatedId: ann._id,
          });
          pushed++;
        } catch (_) {}
      }
    }

    res.json({ success: true, message: `Broadcast sent to ${tenants.length} tenant(s) for ${announcements.length} announcement(s)`, pushed });
  } catch (error) {
    console.error('Error broadcasting announcement:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};
