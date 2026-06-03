const AreaManager = require('../models/AreaManager');

// Get all area managers
exports.getAllAreaManagers = async (req, res) => {
    try {
        const managers = await AreaManager.find({ isActive: true })
            .select('-password')
            .sort({ createdAt: -1 });
        
        res.json({
            success: true,
            count: managers.length,
            data: managers
        });
    } catch (err) {
        console.error('Error fetching area managers:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Get area manager by ID
exports.getAreaManagerById = async (req, res) => {
    try {
        const { id } = req.params;
        
        const manager = await AreaManager.findById(id).select('-password');
        
        if (!manager) {
            return res.status(404).json({ success: false, message: 'Area manager not found' });
        }
        
        res.json({ success: true, data: manager });
    } catch (err) {
        console.error('Error fetching area manager:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Get area manager by email
exports.getAreaManagerByEmail = async (req, res) => {
    try {
        const { email } = req.params;
        
        const manager = await AreaManager.findOne({ email: email.toLowerCase() }).select('-password');
        
        if (!manager) {
            return res.status(404).json({ success: false, message: 'Area manager not found' });
        }
        
        res.json({ success: true, data: manager });
    } catch (err) {
        console.error('Error fetching area manager by email:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Create new area manager
exports.createAreaManager = async (req, res) => {
    try {
        const { name, loginId, email, password, phone, area, areaName, areaCode, city, permissions } = req.body;
        
        // Validation
        if (!name || !loginId || !email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields: name, loginId, email, password' 
            });
        }
        
        // Check if already exists
        const existing = await AreaManager.findOne({ 
            $or: [{ email: email.toLowerCase() }, { loginId: loginId.toUpperCase() }] 
        });
        
        if (existing) {
            return res.status(409).json({ 
                success: false, 
                message: 'Area manager with this email or login ID already exists' 
            });
        }
        
        // Create new manager
        const manager = new AreaManager({
            name,
            loginId: loginId.toUpperCase(),
            email: email.toLowerCase(),
            password,
            phone,
            area,
            areaName,
            areaCode,
            city,
            permissions: permissions || [],
            isActive: true
        });
        
        await manager.save();
        
        res.status(201).json({
            success: true,
            message: 'Area manager created successfully',
            data: manager.toJSON()
        });
    } catch (err) {
        console.error('Error creating area manager:', err);
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
};

// Update area manager
exports.updateAreaManager = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Don't allow password update through this endpoint
        if (updates.password) {
            delete updates.password;
        }
        
        const manager = await AreaManager.findByIdAndUpdate(
            id,
            { ...updates, updatedAt: new Date() },
            { new: true, runValidators: true }
        ).select('-password');
        
        if (!manager) {
            return res.status(404).json({ success: false, message: 'Area manager not found' });
        }
        
        res.json({
            success: true,
            message: 'Area manager updated successfully',
            data: manager
        });
    } catch (err) {
        console.error('Error updating area manager:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Delete area manager (soft delete)
exports.deleteAreaManager = async (req, res) => {
    try {
        const { id } = req.params;
        
        const manager = await AreaManager.findByIdAndUpdate(
            id,
            { isActive: false, updatedAt: new Date() },
            { new: true }
        ).select('-password');
        
        if (!manager) {
            return res.status(404).json({ success: false, message: 'Area manager not found' });
        }
        
        res.json({
            success: true,
            message: 'Area manager deleted successfully',
            data: manager
        });
    } catch (err) {
        console.error('Error deleting area manager:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Get managers by area
exports.getManagersByArea = async (req, res) => {
    try {
        const { area } = req.params;
        
        const managers = await AreaManager.find({ 
            area: area,
            isActive: true 
        })
        .select('-password')
        .sort({ name: 1 });
        
        res.json({
            success: true,
            count: managers.length,
            data: managers
        });
    } catch (err) {
        console.error('Error fetching managers by area:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update area manager password
exports.updatePassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ 
                success: false, 
                message: 'Current password and new password are required' 
            });
        }
        
        const manager = await AreaManager.findById(id);
        
        if (!manager) {
            return res.status(404).json({ success: false, message: 'Area manager not found' });
        }
        
        // Verify current password
        const isMatch = await manager.matchPassword(currentPassword);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }
        
        // Update password
        manager.password = newPassword;
        await manager.save();
        
        res.json({
            success: true,
            message: 'Password updated successfully'
        });
    } catch (err) {
        console.error('Error updating password:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Search area managers
exports.searchAreaManagers = async (req, res) => {
    try {
        const { query } = req.query;
        
        if (!query) {
            return res.status(400).json({ 
                success: false, 
                message: 'Search query is required' 
            });
        }
        
        const managers = await AreaManager.find({
            $or: [
                { name: { $regex: query, $options: 'i' } },
                { email: { $regex: query, $options: 'i' } },
                { loginId: { $regex: query, $options: 'i' } },
                { area: { $regex: query, $options: 'i' } }
            ],
            isActive: true
        })
        .select('-password')
        .limit(20);
        
        res.json({
            success: true,
            count: managers.length,
            data: managers
        });
    } catch (err) {
        console.error('Error searching area managers:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Bulk import area managers
exports.bulkImportAreaManagers = async (req, res) => {
    try {
        const { managers } = req.body;
        
        if (!Array.isArray(managers)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Managers should be an array' 
            });
        }
        
        const results = [];
        
        for (const managerData of managers) {
            try {
                // Check if already exists
                const existing = await AreaManager.findOne({
                    $or: [
                        { email: managerData.email?.toLowerCase() },
                        { loginId: managerData.loginId?.toUpperCase() }
                    ]
                });
                
                if (existing) {
                    results.push({
                        ...managerData,
                        status: 'skipped',
                        reason: 'Already exists'
                    });
                    continue;
                }
                
                const manager = new AreaManager({
                    ...managerData,
                    loginId: managerData.loginId?.toUpperCase(),
                    email: managerData.email?.toLowerCase()
                });
                
                await manager.save();
                results.push({
                    ...managerData,
                    status: 'created',
                    id: manager._id
                });
            } catch (err) {
                results.push({
                    ...managerData,
                    status: 'error',
                    message: err.message
                });
            }
        }
        
        res.json({
            success: true,
            message: 'Bulk import completed',
            results
        });
    } catch (err) {
        console.error('Error in bulk import:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
