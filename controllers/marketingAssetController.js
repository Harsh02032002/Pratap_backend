const MarketingAsset = require('../models/MarketingAsset');

exports.getAssetsByOwner = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const assets = await MarketingAsset.find({ ownerLoginId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, assets });
  } catch (error) {
    console.error('Error fetching marketing assets:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.createAsset = async (req, res) => {
  try {
    const { ownerLoginId, name, category, size } = req.body;
    
    if (!ownerLoginId || !name || !category) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const newAsset = new MarketingAsset({
      ownerLoginId,
      name,
      category,
      size: size || 'A4 Printable PDF',
      file_url: '' // Will implement upload later if needed
    });

    await newAsset.save();
    res.status(201).json({ success: true, asset: newAsset });
  } catch (error) {
    console.error('Error creating marketing asset:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

exports.deleteAsset = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedAsset = await MarketingAsset.findByIdAndDelete(id);
    
    if (!deletedAsset) {
      return res.status(404).json({ success: false, message: 'Asset not found' });
    }

    res.status(200).json({ success: true, message: 'Asset deleted successfully' });
  } catch (error) {
    console.error('Error deleting marketing asset:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};
