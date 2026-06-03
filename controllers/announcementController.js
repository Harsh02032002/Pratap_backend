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
