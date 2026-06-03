const fs = require('fs');
const path = require('path');

// POST /api/admin/recordings
// body: { meetingId, filename, data } where data is base64 (dataURL or base64 string)
exports.uploadRecording = async (req, res) => {
  try {
    const { meetingId, filename, data } = req.body;
    if (!meetingId || !filename || !data) return res.status(400).json({ message: 'meetingId, filename and data required' });

    // prepare folder
    const recordingsDir = path.join(__dirname, '..', 'public', 'recordings');
    fs.mkdirSync(recordingsDir, { recursive: true });

    // strip data URL prefix if present
    const base64 = data.indexOf(',') > -1 ? data.split(',')[1] : data;
    const buffer = Buffer.from(base64, 'base64');

    // sanitize filename
    const safeFilename = filename.replace(/[^a-zA-Z0-9-_.]/g, '_');
    const outPath = path.join(recordingsDir, safeFilename);
    fs.writeFileSync(outPath, buffer);

    const publicUrl = `/recordings/${encodeURIComponent(safeFilename)}`;
    return res.json({ url: publicUrl });
  } catch (err) {
    console.error('Recording upload failed', err);
    res.status(500).json({ message: err.message });
  }
};
