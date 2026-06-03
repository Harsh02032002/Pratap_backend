const Gate = require('../models/Gate');

// Get all gates for an owner
exports.getGatesByOwner = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const gates = await Gate.find({ ownerLoginId });
    res.status(200).json({ success: true, gates });
  } catch (err) {
    console.error('Error fetching gates:', err);
    res.status(500).json({ success: false, message: 'Server error fetching gates', error: err.message });
  }
};

// Create a new gate
exports.createGate = async (req, res) => {
  try {
    const { ownerLoginId, name, type, status } = req.body;
    
    if (!ownerLoginId || !name || !type) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const newGate = new Gate({
      ownerLoginId,
      name,
      type,
      status: status || 'Unlocked'
    });

    await newGate.save();
    res.status(201).json({ success: true, gate: newGate });
  } catch (err) {
    console.error('Error creating gate:', err);
    res.status(500).json({ success: false, message: 'Server error creating gate', error: err.message });
  }
};

// Toggle gate status
exports.toggleGateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const gate = await Gate.findById(id);
    
    if (!gate) {
      return res.status(404).json({ success: false, message: 'Gate not found' });
    }

    gate.status = gate.status === 'Unlocked' ? 'Locked' : 'Unlocked';
    await gate.save();

    res.status(200).json({ success: true, gate });
  } catch (err) {
    console.error('Error toggling gate status:', err);
    res.status(500).json({ success: false, message: 'Server error toggling gate status', error: err.message });
  }
};

// Delete a gate
exports.deleteGate = async (req, res) => {
  try {
    const { id } = req.params;
    const gate = await Gate.findByIdAndDelete(id);

    if (!gate) {
      return res.status(404).json({ success: false, message: 'Gate not found' });
    }

    res.status(200).json({ success: true, message: 'Gate deleted successfully' });
  } catch (err) {
    console.error('Error deleting gate:', err);
    res.status(500).json({ success: false, message: 'Server error deleting gate', error: err.message });
  }
};
