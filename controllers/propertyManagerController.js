const PropertyManager = require('../models/PropertyManager');
const Property = require('../models/Property');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { sendMail } = require('../utils/mailer');

const getManagerLoginUrl = () => {
  const frontendBaseUrl = (
    process.env.FRONTEND_URL ||
    process.env.WEB_APP_URL ||
    'https://admin.roomhy.com'
  ).replace(/\/$/, '');

  return `${frontendBaseUrl}/manager/login`;
};

// Generate unique manager login ID
const generateManagerLoginId = async () => {
  const prefix = 'MGR';
  let loginId;
  let exists = true;
  
  while (exists) {
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    loginId = `${prefix}${randomNum}`;
    const existing = await PropertyManager.findOne({ loginId });
    exists = !!existing;
  }
  
  return loginId;
};

// Generate random password
const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

// Login property manager
exports.loginPropertyManager = async (req, res) => {
  try {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Login ID and password are required' 
      });
    }

    const manager = await PropertyManager.findOne({ loginId })
      .populate('assignedProperty', 'title name address city');

    if (!manager) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    if (manager.status !== 'active') {
      return res.status(403).json({ 
        success: false, 
        message: 'Your account is inactive. Contact property owner.' 
      });
    }

    const isPasswordValid = await bcrypt.compare(password, manager.password);
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    if (manager.requirePasswordReset) {
      return res.status(200).json({
        success: true,
        requireReset: true,
        message: 'Password reset required',
        managerId: manager._id,
        loginId: manager.loginId
      });
    }

    const token = jwt.sign(
      { 
        managerId: manager._id, 
        loginId: manager.loginId,
        propertyId: manager.assignedProperty._id 
      },
      process.env.JWT_SECRET || 'roomhy-secret-key',
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      manager: {
        _id: manager._id,
        name: manager.name,
        email: manager.email,
        phone: manager.phone,
        loginId: manager.loginId,
        ownerLoginId: manager.ownerLoginId,
        assignedProperty: manager.assignedProperty,
        permissions: manager.permissions,
        status: manager.status
      }
    });
  } catch (err) {
    console.error('Error logging in:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Create property manager
exports.createPropertyManager = async (req, res) => {
  try {
    const { name, email, phone, assignedProperty, ownerLoginId, permissions } = req.body;
    const normalizedName = String(name || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPhone = String(phone || '').trim();

    if (!normalizedName || !normalizedEmail || !normalizedPhone || !assignedProperty || !ownerLoginId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name, email, phone, property, and owner are required' 
      });
    }

    // Check if property exists
    const property = await Property.findById(assignedProperty);
    if (!property) {
      return res.status(404).json({ 
        success: false, 
        message: 'Property not found' 
      });
    }

    // Check if property belongs to owner
    if (property.ownerLoginId !== ownerLoginId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Property does not belong to this owner' 
      });
    }

    const existingManager = await PropertyManager.findOne({
      ownerLoginId,
      $or: [
        { email: normalizedEmail },
        { phone: normalizedPhone }
      ]
    });

    if (existingManager) {
      return res.status(409).json({
        success: false,
        message: 'A property manager with this email or phone already exists for this owner.'
      });
    }

    // Generate credentials
    const loginId = await generateManagerLoginId();
    const plainPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // Create manager
    const manager = await PropertyManager.create({
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      loginId,
      password: hashedPassword,
      ownerLoginId,
      assignedProperty,
      permissions: permissions || {
        canViewTenants: true,
        canAddTenants: true,
        canCollectRent: true,
        canViewReports: true,
        canManageComplaints: true,
        canManageRooms: true
      },
      requirePasswordReset: true
    });

    // Send credentials email
    try {
      const propertyName = property.title || property.name || 'Property';
      const loginUrl = getManagerLoginUrl();
      console.log('🔗 EMAIL LOGIN URL:', loginUrl);
      const subject = `Property Manager Account Created - ${propertyName}`;
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f2f5}.container{max-width:600px;margin:40px auto;padding:20px}.card{background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);overflow:hidden}.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:40px 30px;text-align:center}.header h1{margin:0;color:white;font-size:32px;font-weight:600}.header p{margin:10px 0 0;color:rgba(255,255,255,0.9);font-size:16px}.content{padding:40px 30px}.greeting{color:#333;font-size:18px;margin-bottom:20px;line-height:1.6}.property-info{background:linear-gradient(135deg,#e0f2fe 0%,#dbeafe 100%);border-radius:12px;padding:20px;margin:25px 0;border-left:4px solid #3b82f6}.property-info h3{margin:0 0 10px;color:#1e40af;font-size:16px}.credential-card{background:linear-gradient(135deg,#f5f7fa 0%,#e4e8ec 100%);border-radius:12px;padding:25px;margin:25px 0;border-left:4px solid #10b981}.credential-item{margin:20px 0}.credential-label{color:#666;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:600}.credential-value{color:#111;font-size:20px;font-weight:700;background:white;padding:12px 18px;border-radius:8px;display:inline-block;font-family:'Courier New',monospace;letter-spacing:1px}.permissions{background:#fef3c7;border-radius:12px;padding:20px;margin:25px 0;border-left:4px solid #f59e0b}.permissions h3{margin:0 0 15px;color:#92400e;font-size:16px}.permissions ul{margin:0;padding-left:20px;color:#78350f}.permissions li{margin:8px 0;font-size:14px}.warning{background:#fee2e2;border:1px solid #ef4444;border-radius:8px;padding:18px;margin-top:25px;font-size:14px;color:#991b1b}.btn{display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:14px 35px;text-decoration:none;border-radius:8px;margin-top:25px;font-weight:600;font-size:16px}.footer{background:#f8f9fa;padding:25px;text-align:center;border-top:1px solid #eee}.footer p{margin:8px 0;color:#666;font-size:13px}</style></head><body><div class="container"><div class="card"><div class="header"><h1>🏠 RoomHy</h1><p>Property Manager Account</p></div><div class="content"><p class="greeting">Hello <strong>${name}</strong>,</p><p class="greeting">You have been assigned as a Property Manager for <strong>${propertyName}</strong>. Your account has been created successfully!</p><div class="property-info"><h3>📍 Assigned Property</h3><p><strong>${propertyName}</strong></p><p style="color:#64748b;font-size:13px;margin-top:8px">You will have full access to manage this property only</p></div><div class="credential-card"><h3 style="margin:0 0 20px;color:#10b981;font-size:18px">🔐 Your Login Credentials</h3><div class="credential-item"><div class="credential-label">Manager ID</div><div class="credential-value">${loginId}</div></div><div class="credential-item"><div class="credential-label">Password</div><div class="credential-value">${plainPassword}</div></div></div><div class="permissions"><h3>✅ Full Access Permissions</h3><ul><li>View & Manage Tenants</li><li>Add New Tenants</li><li>Collect Rent Payments</li><li>View Reports & Analytics</li><li>Manage Complaints & Maintenance</li><li>Manage Rooms & Beds</li></ul><p style="margin-top:15px;font-size:13px;color:#92400e"><strong>Note:</strong> All permissions are for your assigned property only</p></div><div class="warning">⚠️ <strong>Important:</strong> Change your password after first login. Never share credentials. You can only access data for your assigned property.</div><div style="text-align:center"><a href="${loginUrl}" class="btn">Login to Dashboard</a></div></div><div class="footer"><p><strong>© 2025 RoomHy</strong></p><p>Need help? Contact support@roomhy.com</p></div></div></div></body></html>`;
      const text = `Property Manager Account Created\n\nHello ${name},\n\nYou have been assigned as Property Manager for ${propertyName}.\n\nYour Login Credentials:\nManager ID: ${loginId}\nPassword: ${plainPassword}\n\nLogin at: ${loginUrl}\n\n- RoomHy Team`;
      await sendMail(email, subject, text, html);
      console.log(`✅ Credentials email sent to ${email}`);
    } catch (emailError) {
      console.error('❌ Email failed:', emailError);
    }

    return res.status(201).json({
      success: true,
      message: 'Property manager created successfully. Credentials sent via email.',
      manager: {
        _id: manager._id,
        name: manager.name,
        email: manager.email,
        phone: manager.phone,
        loginId: manager.loginId,
        plainPassword,
        assignedProperty: manager.assignedProperty,
        permissions: manager.permissions,
        status: manager.status
      }
    });
  } catch (err) {
    console.error('Error creating property manager:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get all managers for an owner
exports.getManagersByOwner = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;

    const managers = await PropertyManager.find({ ownerLoginId })
      .populate('assignedProperty', 'title address city')
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      managers
    });
  } catch (err) {
    console.error('Error fetching managers:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Get single manager
exports.getManagerById = async (req, res) => {
  try {
    const { managerId } = req.params;

    const manager = await PropertyManager.findById(managerId)
      .populate('assignedProperty', 'title address city ownerLoginId');

    if (!manager) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager not found' 
      });
    }

    return res.json({
      success: true,
      manager
    });
  } catch (err) {
    console.error('Error fetching manager:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Update manager
exports.updatePropertyManager = async (req, res) => {
  try {
    const { managerId } = req.params;
    const { name, email, phone, permissions, status } = req.body;

    const manager = await PropertyManager.findById(managerId);
    if (!manager) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager not found' 
      });
    }

    if (name) manager.name = name;
    if (email) manager.email = email;
    if (phone) manager.phone = phone;
    if (permissions) manager.permissions = { ...manager.permissions, ...permissions };
    if (status) manager.status = status;
    manager.updatedAt = Date.now();

    await manager.save();

    return res.json({
      success: true,
      message: 'Manager updated successfully',
      manager
    });
  } catch (err) {
    console.error('Error updating manager:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Delete manager
exports.deletePropertyManager = async (req, res) => {
  try {
    const { managerId } = req.params;

    const manager = await PropertyManager.findByIdAndDelete(managerId);
    if (!manager) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager not found' 
      });
    }

    return res.json({
      success: true,
      message: 'Manager deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting manager:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Reset manager password
exports.resetManagerPassword = async (req, res) => {
  try {
    const { managerId } = req.params;

    const manager = await PropertyManager.findById(managerId);
    if (!manager) {
      return res.status(404).json({ 
        success: false, 
        message: 'Manager not found' 
      });
    }

    const newPassword = generatePassword();
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    manager.password = hashedPassword;
    manager.updatedAt = Date.now();
    manager.requirePasswordReset = true;
    await manager.save();

    // Send password reset email
    try {
      const property = await Property.findById(manager.assignedProperty);
      const propertyName = property ? (property.title || property.name || 'Property') : 'Property';
      const loginUrl = getManagerLoginUrl();
      const subject = 'Password Reset - Property Manager Account';
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f2f5}.container{max-width:550px;margin:40px auto;padding:20px}.card{background:white;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);overflow:hidden}.header{background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%);padding:35px 30px;text-align:center}.header h1{margin:0;color:white;font-size:28px;font-weight:600}.header p{margin:10px 0 0;color:rgba(255,255,255,0.95);font-size:15px}.content{padding:35px 30px}.greeting{color:#333;font-size:16px;margin-bottom:20px;line-height:1.6}.credential-card{background:linear-gradient(135deg,#fef2f2 0%,#fee2e2 100%);border-radius:12px;padding:25px;margin:25px 0;border-left:4px solid #ef4444}.credential-item{margin:18px 0}.credential-label{color:#666;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:600}.credential-value{color:#111;font-size:20px;font-weight:700;background:white;padding:12px 18px;border-radius:8px;display:inline-block;font-family:'Courier New',monospace;letter-spacing:1px}.warning{background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:18px;margin-top:25px;font-size:14px;color:#92400e}.btn{display:inline-block;background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%);color:white;padding:14px 35px;text-decoration:none;border-radius:8px;margin-top:25px;font-weight:600;font-size:16px}.footer{background:#f8f9fa;padding:25px;text-align:center;border-top:1px solid #eee}.footer p{margin:8px 0;color:#666;font-size:13px}</style></head><body><div class="container"><div class="card"><div class="header"><h1>🔐 Password Reset</h1><p>Property Manager Account</p></div><div class="content"><p class="greeting">Hello <strong>${manager.name}</strong>,</p><p class="greeting">Your password has been reset by the property owner. Here is your new password for <strong>${propertyName}</strong>:</p><div class="credential-card"><h3 style="margin:0 0 20px;color:#dc2626;font-size:18px">🔑 New Login Credentials</h3><div class="credential-item"><div class="credential-label">Manager ID</div><div class="credential-value">${manager.loginId}</div></div><div class="credential-item"><div class="credential-label">New Password</div><div class="credential-value">${newPassword}</div></div></div><div class="warning">⚠️ <strong>Security Reminder:</strong> Change this password immediately after logging in.</div><div style="text-align:center"><a href="${loginUrl}" class="btn">Login Now</a></div></div><div class="footer"><p><strong>© 2025 RoomHy</strong></p><p>Need help? Contact support@roomhy.com</p></div></div></div></body></html>`;
      const text = `Password Reset\n\nHello ${manager.name},\n\nYour password has been reset.\n\nManager ID: ${manager.loginId}\nNew Password: ${newPassword}\n\nLogin at: ${loginUrl}\n\n- RoomHy Team`;
      await sendMail(manager.email, subject, text, html);
      console.log(`✅ Password reset email sent to ${manager.email}`);
    } catch (emailError) {
      console.error('❌ Email failed:', emailError);
    }

    return res.json({
      success: true,
      message: 'Password reset successfully. New credentials sent via email.',
      newPassword
    });
  } catch (err) {
    console.error('Error resetting password:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
};

// Reset initial password for manager
exports.resetInitialPassword = async (req, res) => {
  try {
    const { loginId, oldPassword, newPassword } = req.body;

    if (!loginId || !oldPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: 'Login ID, old password, and new password are required' 
      });
    }

    const manager = await PropertyManager.findOne({ loginId });

    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const isPasswordValid = await bcrypt.compare(oldPassword, manager.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid old password' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    manager.password = hashedPassword;
    manager.requirePasswordReset = false;
    manager.updatedAt = Date.now();
    await manager.save();

    return res.json({
      success: true,
      message: 'Password reset successfully. You can now login.'
    });
  } catch (err) {
    console.error('Error in resetInitialPassword:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Add tenant to property (Property Manager)
exports.addTenantToProperty = async (req, res) => {
  try {
    const { managerId } = req.params;
    const {
      name, phone, email, roomNo, bedNo, moveInDate, agreedRent,
      dob, gender, building, floor, rentAgreementType, paymentFrequency, 
      additional, idProof,
      securityDepositTotal, securityDepositPaid, securityDepositBalance,
      electricityCharge, maintenanceCharge, electricityUnitCost
    } = req.body;

    // Verify manager exists and has permission
    const manager = await PropertyManager.findById(managerId)
      .populate('assignedProperty');

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: 'Property manager not found'
      });
    }

    if (!manager.permissions?.canAddTenants) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to add tenants'
      });
    }

    if (manager.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Your account is inactive'
      });
    }

    // Prepare tenant assignment request
    const tenantAssignmentPayload = {
      name,
      phone,
      email,
      propertyId: manager.assignedProperty._id,
      roomNo,
      bedNo,
      moveInDate,
      agreedRent,
      dob,
      gender,
      building,
      floor,
      rentAgreementType,
      paymentFrequency,
      additional,
      idProof,
      securityDepositTotal,
      securityDepositPaid,
      securityDepositBalance,
      electricityCharge,
      maintenanceCharge,
      electricityUnitCost,
      ownerLoginId: manager.ownerLoginId,
      propertyTitle: manager.assignedProperty.title
    };

    // Create request object for tenant assignment
    const mockReq = {
      body: tenantAssignmentPayload,
      user: {
        id: manager._id
      }
    };

    // Create response object to capture tenant assignment response
    let tenantResponse = null;
    let tenantError = null;

    const mockRes = {
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(data) {
        tenantResponse = { statusCode: this.statusCode || 200, data };
        return this;
      },
      status201: function(code) {
        this.statusCode = 201;
        return this;
      }
    };

    // Import and call tenant assignment
    const tenantController = require('./tenantController');
    
    // Create a custom response handler
    await new Promise((resolve, reject) => {
      const originalJson = mockRes.json;
      mockRes.json = function(data) {
        tenantResponse = { statusCode: this.statusCode || 200, data };
        resolve();
        return this;
      };
      mockRes.status = function(code) {
        this.statusCode = code;
        return this;
      };

      tenantController.assignTenant(mockReq, mockRes).catch((err) => {
        tenantError = err;
        reject(err);
      });
    });

    if (tenantError) {
      return res.status(500).json({
        success: false,
        message: 'Failed to assign tenant',
        error: tenantError.message
      });
    }

    if (!tenantResponse || !tenantResponse.data.success) {
      return res.status(tenantResponse?.statusCode || 400).json(
        tenantResponse?.data || { success: false, message: 'Failed to assign tenant' }
      );
    }

    // Log action for audit
    console.log(`✅ Tenant ${name} (${email}) added to property ${manager.assignedProperty.title} by manager ${manager.name}`);

    // Return response with tenant assignment data
    return res.status(201).json({
      success: true,
      message: 'Tenant added successfully to your property',
      tenant: tenantResponse.data.tenant,
      tenantCheckinLink: tenantResponse.data.tenantCheckinLink,
      onboarding: tenantResponse.data.onboarding
    });

  } catch (err) {
    console.error('Error adding tenant:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to add tenant',
      error: err.message
    });
  }
};

// Get tenants for property manager's assigned property
exports.getPropertyManagerTenants = async (req, res) => {
  try {
    const { managerId } = req.params;

    const manager = await PropertyManager.findById(managerId)
      .populate('assignedProperty');

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: 'Property manager not found'
      });
    }

    // Get tenants for the assigned property
    const Tenant = require('../models/Tenant');
    const tenants = await Tenant.find({ property: manager.assignedProperty._id })
      .populate('property', 'title roomType locationCode ownerLoginId')
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      propertyId: manager.assignedProperty._id,
      propertyTitle: manager.assignedProperty.title,
      totalTenants: tenants.length,
      tenants
    });

  } catch (err) {
    console.error('Error fetching manager tenants:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch tenants',
      error: err.message
    });
  }
};
