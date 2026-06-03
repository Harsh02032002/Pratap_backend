const Report = require('../models/Report');
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Property = require('../models/Property');
const Complaint = require('../models/Complaint');

exports.generateReport = async (req, res) => {
  try {
    const { ownerLoginId, reportName, format, fields } = req.body;

    if (!ownerLoginId || !reportName) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Generate CSV content using the fields provided
    let csvData = "";
    if (fields && fields.length > 0) {
      csvData += fields.join(',') + '\n';
      
      // Try to fetch actual data based on report type
      const reportNameLower = reportName.toLowerCase();
      
      // Fetch properties for owner
      const properties = await Property.find({ ownerLoginId }).lean();
      const propertyIds = properties.map(p => p._id);

      if (reportNameLower.includes('tenant') || reportNameLower.includes('booking') || reportNameLower.includes('attendance')) {
        // Fetch Tenants
        const tenants = await Tenant.find({ property: { $in: propertyIds } }).populate('room').populate('property').lean();
        if (tenants.length > 0) {
          for (const t of tenants) {
            const row = fields.map(f => {
              const fLower = f.toLowerCase();
              if (fLower.includes('tenant') || fLower.includes('name')) return `"${t.name || 'N/A'}"`;
              if (fLower.includes('room')) return `"${t.room?.title || 'N/A'}"`;
              if (fLower.includes('phone') || fLower.includes('contact')) return `"${t.phone || 'N/A'}"`;
              if (fLower.includes('doj') || fLower.includes('joining')) return `"${t.doj ? new Date(t.doj).toLocaleDateString() : 'N/A'}"`;
              if (fLower.includes('rent') || fLower.includes('amount')) return `"${t.rentAmount || 0}"`;
              if (fLower.includes('unpaid') || fLower.includes('dues')) return `"${t.unpaidDues || 0}"`;
              if (fLower.includes('status')) return `"${t.status || 'Active'}"`;
              return '"-"'; // default empty
            });
            csvData += row.join(',') + '\n';
          }
        } else {
           csvData += fields.map(() => '"No tenants found"').join(',') + '\n';
        }
      } else if (reportNameLower.includes('room') || reportNameLower.includes('property') || reportNameLower.includes('occupancy')) {
        // Fetch Rooms
        const rooms = await Room.find({ property: { $in: propertyIds } }).populate('property').lean();
        if (rooms.length > 0) {
           for (const r of rooms) {
             const row = fields.map(f => {
                const fLower = f.toLowerCase();
                if (fLower.includes('room')) return `"${r.title || 'N/A'}"`;
                if (fLower.includes('property')) return `"${r.property?.title || 'N/A'}"`;
                if (fLower.includes('status') || fLower.includes('occupancy')) return `"${r.status || 'N/A'}"`;
                if (fLower.includes('rent') || fLower.includes('amount')) return `"${r.price || 0}"`;
                return '"-"';
             });
             csvData += row.join(',') + '\n';
           }
        } else {
           csvData += fields.map(() => '"No rooms found"').join(',') + '\n';
        }
      } else if (reportNameLower.includes('complaint')) {
        // Fetch Complaints
        const complaints = await Complaint.find({ property: { $in: propertyIds } }).populate('tenant').populate('room').lean();
        if (complaints.length > 0) {
           for (const c of complaints) {
             const row = fields.map(f => {
                const fLower = f.toLowerCase();
                if (fLower.includes('complaint') || fLower.includes('details')) return `"${c.description || c.title || 'N/A'}"`;
                if (fLower.includes('status')) return `"${c.status || 'N/A'}"`;
                if (fLower.includes('tenant')) return `"${c.tenant?.name || 'N/A'}"`;
                if (fLower.includes('room')) return `"${c.room?.title || 'N/A'}"`;
                return '"-"';
             });
             csvData += row.join(',') + '\n';
           }
        } else {
           csvData += fields.map(() => '"No complaints found"').join(',') + '\n';
        }
      } else {
        // Fallback for others
        csvData += fields.map(() => '"Data not yet available for this module"').join(',') + '\n';
      }
    } else {
      csvData = "Column 1,Column 2\nData 1,Data 2\n";
    }

    const newReport = new Report({
      ownerLoginId,
      reportName,
      status: 'Completed',
      metadata: { format: format || 'Excel' }
    });

    await newReport.save();

    res.status(201).json({ 
      success: true, 
      message: `${reportName} generated successfully.`,
      report: newReport,
      fileContent: csvData
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.getPastReports = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const reports = await Report.find({ ownerLoginId }).sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, reports });
  } catch (error) {
    console.error('Error fetching past reports:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};
