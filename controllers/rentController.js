const Rent = require("../models/Rent");
const Tenant = require("../models/Tenant");
const Property = require("../models/Property");
const { sendMail } = require("../utils/mailer");
const Notification = require("../models/Notification");
const Owner = require("../models/Owner");
const RentAuditLog = require("../models/RentAuditLog");
const RentInvoice = require("../models/RentInvoice");
const RentPayment = require("../models/RentPayment");
const crypto = require("crypto");
const { evaluateInvoice } = require("../services/invoiceService");

async function getTenantProfileByLoginId(loginId) {
  const normalizedLoginId = String(loginId || "")
    .trim()
    .toUpperCase();
  if (!normalizedLoginId) return null;
  try {
    const tenant = await Tenant.findOne({ loginId: normalizedLoginId }).lean();
    return tenant || null;
  } catch (err) {
    console.warn(
      "Failed to load tenant profile for rent hydration:",
      err.message,
    );
    return null;
  }
}

function applyTenantProfileToRent(rent, tenantProfile = {}) {
  if (!rent || !tenantProfile) return rent;

  rent.tenantLoginId = rent.tenantLoginId || tenantProfile.loginId;
  rent.tenantId = rent.tenantId || tenantProfile._id;
  rent.tenantName = rent.tenantName || tenantProfile.name || "";
  rent.tenantEmail = rent.tenantEmail || tenantProfile.email || "";
  rent.tenantPhone = rent.tenantPhone || tenantProfile.phone || "";
  rent.roomNumber = rent.roomNumber || tenantProfile.roomNo || "";
  rent.ownerLoginId = rent.ownerLoginId || tenantProfile.ownerLoginId || "";
  rent.propertyName = rent.propertyName || tenantProfile.propertyTitle || "";
  rent.rentAmount = Number(rent.rentAmount || tenantProfile.agreedRent || 0);
  rent.totalDue = Number(
    rent.totalDue || rent.rentAmount || tenantProfile.agreedRent || 0,
  );
  return rent;
}

function hashCashOtp(otp, salt = crypto.randomBytes(16).toString("hex")) {
  const value = String(otp || "").trim();
  const digest = crypto.createHmac("sha256", salt).update(value).digest("hex");
  return `${salt}:${digest}`;
}

function verifyCashOtpHash(otp, stored) {
  if (!stored || !otp) return false;
  const [salt, digest] = String(stored).split(":");
  if (!salt || !digest) return false;
  const nextDigest = crypto
    .createHmac("sha256", salt)
    .update(String(otp).trim())
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(nextDigest));
}

/**
 * [PHASE 6.5] Verify Payment Page Identity
 * Public-facing endpoint for front-end to safely validate the tenant's entry before showing payment options.
 */
exports.verifyPaymentPageIdentity = async (req, res) => {
  try {
    const { token, enteredLoginId } = req.body;
    if (!token || !enteredLoginId) {
      return res.status(400).json({ message: 'Token and Login ID are required' });
    }

    const jwt = require('jsonwebtoken'); // Lazy load
    const jwtSecret = process.env.JWT_SECRET;
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') return res.status(410).json({ message: 'This payment link has expired. Please contact support.' });
      return res.status(401).json({ message: 'Invalid payment link.' });
    }

    if (decoded.purpose !== 'onboarding_payment') {
      return res.status(401).json({ message: 'Invalid link purpose.' });
    }

    let rentId = decoded.rentRecordId;
    let rent;

    if (rentId) {
      rent = await Rent.findById(rentId);
    } else {
      // Backward compatibility for tokens generated without a rentRecordId
      const Tenant = require('../models/Tenant');
      const tenant = await Tenant.findOne({ loginId: decoded.loginId });
      if (tenant) {
        rent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        if (!rent) {
          rent = new Rent({
            tenantId: tenant._id,
            tenantLoginId: tenant.loginId,
            tenantName: tenant.name,
            tenantEmail: tenant.email,
            tenantPhone: tenant.phone,
            ownerLoginId: tenant.ownerLoginId,
            propertyName: tenant.propertyTitle || 'RoomHy Property',
            roomNumber: tenant.roomNo || '',
            rentAmount: (tenant.agreedRent || 0),
            totalDue: (tenant.agreedRent || 0),
            paymentStatus: 'pending'
          });
          await rent.save();
        }
        rentId = rent._id;
      }
    }

    if (!rent) {
      return res.status(404).json({ message: 'Associated payment record not found.' });
    }

    if (rent.paymentStatus === 'paid') {
      return res.status(409).json({ message: 'This payment has already been completed. Thank you!' });
    }

    // Lockout Guard (5 attempts max)
    const currentAttempts = rent.loginAttempts || 0;
    if (currentAttempts >= 5) {
      return res.status(429).json({ message: 'Too many incorrect attempts. This link is locked for security. Please contact support.' });
    }

    // Validate Identity (case-insensitive)
    if (String(decoded.loginId).toUpperCase() !== String(enteredLoginId).toUpperCase().trim()) {
      await Rent.updateOne({ _id: rentId }, { $inc: { loginAttempts: 1 } });
      return res.status(403).json({ message: 'The entered Login ID does not match this link.' });
    }

    // Reset attempts on success
    if (currentAttempts > 0) {
      await Rent.updateOne({ _id: rentId }, { $set: { loginAttempts: 0 } });
    }

    // Fetch safe UI data
    const Tenant = require('../models/Tenant');
    const Owner = require('../models/Owner');

    const tenant = await Tenant.findOne({ loginId: decoded.loginId }).select('name').lean();
    const owner = await Owner.findOne({ loginId: rent.ownerLoginId }).select('name profile.name').lean();

    const ownerName = owner ? (owner.name || owner.profile?.name || 'Owner') : 'Owner';
    const tenantName = tenant ? tenant.name : rent.tenantName;

    res.json({
      propertyName: rent.propertyName || 'RoomHy Property',
      ownerName,
      tenantName,
      rentAmount: rent.totalDue || rent.rentAmount,
      rentId: rent._id
    });
  } catch (err) {
    console.error('[verifyPaymentPageIdentity] Error:', err);
    res.status(500).json({ message: 'Failed to verify identity.' });
  }
};

/**
 * [PHASE 6.5] Token-gated Razorpay Order Creation
 * Intended for the public frontend payment gateway, safely relying on server-side `Rent.totalDue`
 */
exports.createOnboardingRazorpayOrder = async (req, res) => {
  try {
    const { token } = req.query; // From the GET query string
    if (!token) return res.status(400).json({ message: 'Token is required' });

    const jwtSecret = process.env.JWT_SECRET;
    const jwt = require('jsonwebtoken'); // Lazy load
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid or expired payment link' });
    }

    if (decoded.purpose !== 'onboarding_payment') {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    let rentId = decoded.rentRecordId;
    let rent;

    if (rentId) {
      rent = await Rent.findById(rentId).lean();
    } else {
      const Tenant = require('../models/Tenant');
      const tenant = await Tenant.findOne({ loginId: decoded.loginId });
      if (tenant) {
        rent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 }).lean();
      }
    }

    if (!rent || rent.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Payment no longer required' });
    }

    const amountToPay = Number(rent.totalDue || rent.rentAmount || 0);
    if (amountToPay <= 0) return res.status(400).json({ message: 'Amount invalid' });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    // Fallback for local testing so frontend doesn't crash if RZP isn't configured
    if (!keyId || !keySecret || keySecret === "your_key_secret_here") {
      return res.status(500).json({ message: 'Razorpay is not configured on this server' });
    }

    const Razorpay = require("razorpay");
    const instance = new Razorpay({ key_id: keyId, key_secret: keySecret });

    const options = {
      amount: Math.round(amountToPay * 100), // convert to paise
      currency: "INR",
      receipt: `ONB_${String(rent._id).slice(-8)}`,
      notes: {
        rentId: String(rent._id),
        tenantId: String(rent.tenantId || ''),
        loginId: decoded.loginId,
        paymentType: 'onboarding'
      }
    };

    const order = await instance.orders.create(options);

    // Fetch Tenant for prefill
    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findOne({ loginId: decoded.loginId }).lean();

    res.json({
      orderId: order.id,
      amount: options.amount,
      currency: options.currency,
      key: keyId,
      userDetails: {
        name: tenant?.name || rent.tenantName || 'RoomHy Tenant',
        email: tenant?.email || rent.tenantEmail || '',
        contact: tenant?.phone || rent.tenantPhone || ''
      },
      notes: options.notes
    });
  } catch (err) {
    console.error('[createOnboardingRazorpayOrder] Error:', err);
    res.status(500).json({ message: 'Failed to create payment order' });
  }
};

function buildCashPaymentReceipt({ rent, invoice, paidAt }) {
  const paymentDate = paidAt || rent?.paymentDate || new Date();
  const amount = Number(
    invoice?.totalDue || rent?.totalDue || rent?.rentAmount || 0,
  );
  const receiptNumber = `RCPT-${String(rent?._id || invoice?._id || "CASH")
    .slice(-6)
    .toUpperCase()}-${String(Date.now()).slice(-6)}`;

  return {
    receiptNumber,
    paymentMethod: "cash",
    status: "PAID",
    amount,
    tenantName: rent?.tenantName || "",
    tenantPhone: rent?.tenantPhone || "",
    tenantEmail: rent?.tenantEmail || "",
    propertyName: rent?.propertyName || "",
    roomNumber: rent?.roomNumber || "",
    collectionMonth: rent?.collectionMonth || invoice?.billingMonth || "",
    ownerLoginId: rent?.ownerLoginId || "",
    invoiceId: invoice?._id ? String(invoice._id) : "",
    rentId: rent?._id ? String(rent._id) : "",
    paidAt: paymentDate.toISOString(),
    verifiedAt: paymentDate.toISOString(),
    billingMonth: invoice?.billingMonth || rent?.collectionMonth || "",
    totalDue: Number(invoice?.totalDue || rent?.totalDue || amount),
    totalPenalty: Number(invoice?.totalPenalty || 0),
    rentAmount: Number(invoice?.rentAmount || rent?.rentAmount || amount),
  };
}

async function resolveOwnerEmail(ownerLoginId) {
  const ownerId = String(ownerLoginId || "")
    .trim()
    .toUpperCase();
  if (!ownerId) return "";
  const owner = await Owner.findOne({ loginId: ownerId })
    .select("email profile.email")
    .lean();
  return (owner && (owner.email || owner.profile?.email)) || "";
}

async function createRentAudit(action, meta = {}, performedBy = "system") {
  try {
    await RentAuditLog.create({
      action,
      invoiceId: meta.invoiceId,
      tenantId: meta.tenantId,
      ownerId: meta.ownerId,
      propertyId: meta.propertyId,
      performedBy,
      meta,
    });
  } catch (_) { }
}

function buildRazorpayReceipt(prefix, primaryId, fallbackId) {
  const safePrefix =
    String(prefix || "rcpt")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 6) || "rcpt";
  const safePrimary =
    String(primaryId || fallbackId || "na")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 12) || "na";
  const stamp = Date.now().toString(36).slice(-8);
  return `${safePrefix}_${safePrimary}_${stamp}`.slice(0, 40);
}

// Create rent record for tenant
exports.createRent = async (req, res) => {
  try {
    const {
      tenantId,
      propertyId,
      rentAmount,
      deposit,
      tenantName,
      tenantEmail,
      tenantPhone,
      roomNumber,
      ownerLoginId,
      area,
    } = req.body;

    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ error: "Property not found" });

    const rent = new Rent({
      tenantId,
      propertyId,
      propertyName: property.title,
      rentAmount,
      deposit,
      totalDue: rentAmount + (deposit || 0),
      tenantName,
      tenantEmail,
      tenantPhone,
      roomNumber,
      area,
      ownerLoginId,
      collectionMonth: new Date().toISOString().slice(0, 7),
    });

    await rent.save();
    res.json({ success: true, rent });
  } catch (err) {
    console.error("Create rent error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Get all rents for owner with filtering
exports.getRentsByOwner = async (req, res) => {
  try {
    const { ownerLoginId } = req.params;
    const { month, status } = req.query;

    let query = { ownerLoginId };
    if (month) query.collectionMonth = month;
    if (status) query.paymentStatus = status;

    const activeTenants = await Tenant.find({
      isDeleted: { $ne: true },
      status: { $nin: ["inactive", "suspended"] },
    }).select("_id loginId");
    const activeTenantIds = activeTenants.map((t) => t._id);
    const activeTenantLoginIds = activeTenants
      .map((t) => t.loginId)
      .filter(Boolean);

    query.$or = [
      { tenantId: { $in: activeTenantIds } },
      { tenantLoginId: { $in: activeTenantLoginIds } },
    ];

    const rents = await Rent.find(query)
      .sort({ updatedAt: -1 })
      .populate("tenantId", "name email phone")
      .populate("propertyId", "title");

    res.json({ success: true, rents });
  } catch (err) {
    console.error("Get rents error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Get all rents (superadmin view)
exports.getAllRents = async (req, res) => {
  try {
    const { month, status, ownerLoginId, paymentStatus } = req.query;
    let query = {};

    if (month) query.collectionMonth = month;
    if (status) query.paymentStatus = status;
    if (ownerLoginId) query.ownerLoginId = ownerLoginId;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const activeTenants = await Tenant.find({
      isDeleted: { $ne: true },
      status: { $nin: ["inactive", "suspended"] },
    }).select("_id loginId");
    const activeTenantIds = activeTenants.map((t) => t._id);
    const activeTenantLoginIds = activeTenants
      .map((t) => t.loginId)
      .filter(Boolean);

    query.$or = [
      { tenantId: { $in: activeTenantIds } },
      { tenantLoginId: { $in: activeTenantLoginIds } },
    ];

    const rents = await Rent.find(query)
      .sort({ createdAt: -1 })
      .populate("tenantId", "name email phone")
      .populate("propertyId", "title");

    res.json({ success: true, rents });
  } catch (err) {
    console.error("Get all rents error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Get single rent
exports.getRent = async (req, res) => {
  try {
    const { rentId } = req.params;
    const rent = await Rent.findById(rentId)
      .populate("tenantId")
      .populate("propertyId");
    if (!rent) return res.status(404).json({ error: "Rent not found" });
    res.json({ success: true, rent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update payment status after successful Razorpay payment
exports.recordPayment = async (req, res) => {
  try {
    const { rentId, razorpayPaymentId, paidAmount, paymentMethod } = req.body;

    const rent = await Rent.findById(rentId);
    if (!rent) return res.status(404).json({ error: "Rent not found" });

    rent.paidAmount = (rent.paidAmount || 0) + paidAmount;
    rent.razorpayPaymentId = razorpayPaymentId;
    rent.paymentMethod = paymentMethod || "razorpay";
    rent.paymentDate = new Date();

    if (rent.paidAmount >= rent.totalDue) {
      rent.paymentStatus = "paid";
      rent.autoReminderEnabled = false;
      rent.autoReminderLastSentAt = undefined;
    } else if (rent.paidAmount > 0) {
      rent.paymentStatus = "partially_paid";
    }

    await rent.save();
    await createRentPaymentHistory({
      rent,
      paidAt: rent.paymentDate,
      recordedBy: req.user?.loginId || "system",
      transactionId:
        razorpayPaymentId || rent.razorpayPaymentId || String(Date.now()),
      notes: "Razorpay payment recorded via recordPayment",
    });

    // Send payment confirmation email
    await sendPaymentConfirmationEmail(rent);

    res.json({ success: true, rent, message: "Payment recorded successfully" });
  } catch (err) {
    console.error("Record payment error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Record payment by tenant (for Razorpay callback)
exports.recordPaymentByTenant = async (req, res) => {
  try {
    const { tenantId, razorpayPaymentId, paidAmount, paymentMethod } = req.body;

    console.log(
      `🔍 [recordPaymentByTenant] Searching for rent - tenantId: ${tenantId}, amount: ${paidAmount}`,
    );

    if (!tenantId || !paidAmount) {
      return res
        .status(400)
        .json({ error: "tenantId and paidAmount required" });
    }

    const tenantProfile = await getTenantProfileByLoginId(tenantId);

    // Find the most recent unpaid or partially paid rent for this tenant
    // Search by tenantLoginId (string field) instead of tenantId (ObjectId)
    let rent = await Rent.findOne({
      $and: [
        {
          $or: [
            { tenantLoginId: tenantId }, // Primary search by login ID
            { tenantEmail: tenantId }, // Try email as fallback
          ],
        },
        {
          $or: [
            { paymentStatus: { $in: ["pending", "partially_paid"] } },
            { paymentStatus: { $exists: false } },
          ],
        },
      ],
    }).sort({ dueDate: -1 });

    console.log(`📊 [recordPaymentByTenant] Rent found:`, rent ? "YES" : "NO");

    if (!rent) {
      // If not found, try to create a minimal rent record for this first payment
      console.log(
        `⚠️ [recordPaymentByTenant] No rent found. Attempting to create one...`,
      );

      rent = new Rent({
        tenantLoginId: tenantId,
        tenantId: tenantProfile?._id,
        ownerLoginId: tenantProfile?.ownerLoginId || "",
        tenantName: tenantProfile?.name || `Tenant ${tenantId}`,
        tenantEmail: tenantProfile?.email || "",
        tenantPhone: tenantProfile?.phone || "",
        propertyName: tenantProfile?.propertyTitle || "",
        roomNumber: tenantProfile?.roomNo || "",
        rentAmount: Number(tenantProfile?.agreedRent || paidAmount),
        totalDue: Number(tenantProfile?.agreedRent || paidAmount),
        paidAmount: paidAmount,
        paymentStatus: paidAmount > 0 ? "paid" : "pending",
        paymentMethod: paymentMethod || "razorpay",
        razorpayPaymentId: razorpayPaymentId,
        paymentDate: new Date(),
        collectionMonth: new Date().toISOString().slice(0, 7),
      });
      applyTenantProfileToRent(rent, tenantProfile);

      await rent.save();
      await createRentPaymentHistory({
        rent,
        paidAt: rent.paymentDate,
        recordedBy: tenantId,
        transactionId: razorpayPaymentId || String(Date.now()),
        notes:
          "Razorpay payment recorded via recordPaymentByTenant (new rent record)",
      });
      console.log(
        `✅ [recordPaymentByTenant] Created new rent record: ${rent._id}`,
      );

      // Send confirmation
      await sendPaymentConfirmationEmail(rent);

      return res.json({
        success: true,
        rent,
        message: "Payment recorded and rent record created",
        paymentStatus: rent.paymentStatus,
        isNewRecord: true,
      });
    }

    console.log(`✅ [recordPaymentByTenant] Found rent: ${rent._id}`);
    applyTenantProfileToRent(rent, tenantProfile);

    rent.paidAmount = (rent.paidAmount || 0) + paidAmount;
    rent.razorpayPaymentId = razorpayPaymentId;
    rent.paymentMethod = paymentMethod || "razorpay";
    rent.paymentDate = new Date();

    // Update payment status
    if (rent.paidAmount >= rent.totalDue) {
      rent.paymentStatus = "paid";
      rent.autoReminderEnabled = false;
      rent.autoReminderLastSentAt = undefined;
      console.log(
        `💳 [recordPaymentByTenant] Payment complete: ₹${rent.paidAmount} >= ₹${rent.totalDue}`,
      );
    } else if (rent.paidAmount > 0) {
      rent.paymentStatus = "partially_paid";
      console.log(
        `💳 [recordPaymentByTenant] Partial payment: ₹${rent.paidAmount} of ₹${rent.totalDue}`,
      );
    }

    await rent.save();
    await createRentPaymentHistory({
      rent,
      paidAt: rent.paymentDate,
      recordedBy: tenantId,
      transactionId: razorpayPaymentId || String(Date.now()),
      notes: "Razorpay payment recorded via recordPaymentByTenant",
    });

    // ── Sync RentInvoice so the owner panel shows the correct paid status ──────
    try {
      const invoiceQuery = { billingMonth: rent.collectionMonth };
      if (tenantProfile?._id) invoiceQuery.tenantId = tenantProfile._id;

      const matchedInvoice = await RentInvoice.findOne(invoiceQuery);
      if (matchedInvoice) {
        const newPaidAmount = (matchedInvoice.paidAmount || 0) + Number(paidAmount);
        const newOutstanding = Math.max(0, (matchedInvoice.totalDue || 0) - newPaidAmount);
        const isFullyPaid = newOutstanding <= 0;
        await RentInvoice.findByIdAndUpdate(matchedInvoice._id, {
          $set: {
            paidAmount: newPaidAmount,
            rentPaidAmount: Math.min(newPaidAmount, matchedInvoice.rentAmount || 0),
            outstandingAmount: newOutstanding,
            status: isFullyPaid ? "PAID" : newPaidAmount > 0 ? "PARTIAL" : "PENDING",
            lastEvaluatedAt: new Date(),
          },
        });
      }
    } catch (invoiceSyncErr) {
      console.warn(
        "recordPaymentByTenant: invoice sync failed:",
        invoiceSyncErr.message,
      );
    }

    // Send payment confirmation email
    await sendPaymentConfirmationEmail(rent);

    console.log(`✅ Payment recorded for tenant ${tenantId}: ₹${paidAmount}`);

    res.json({
      success: true,
      rent,
      message: "Payment recorded successfully",
      paymentStatus: rent.paymentStatus,
    });
  } catch (err) {
    console.error("❌ Record payment by tenant error:", err.message);
    res.status(500).json({ error: err.message || "Failed to record payment" });
  }
};

exports.verifyRazorpayPayment = async (req, res) => {
  try {
    const {
      tenantId,
      rentId,
      paidAmount,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (
      !tenantId ||
      !paidAmount ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error:
            "tenantId, paidAmount and Razorpay payment fields are required",
        });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res
        .status(500)
        .json({ success: false, error: "Razorpay secret is not configured" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid Razorpay payment signature" });
    }

    req.body.razorpayPaymentId = razorpay_payment_id;
    req.body.paymentMethod = "razorpay";

    const originalJson = res.json.bind(res);
    res.json = async (payload) => {
      try {
        // Strict security: ONLY trust the rent document resolved by the server, and ONLY if the operation succeeded.
        // Never fall back to the unverified rentId from req.body.
        const resolvedRentId = payload?.success ? payload?.rent?._id : null;
        if (resolvedRentId) {
          await Rent.findByIdAndUpdate(resolvedRentId, {
            $set: {
              razorpayOrderId: razorpay_order_id,
              razorpayPaymentId: razorpay_payment_id,
              razorpaySignature: razorpay_signature,
              paymentMethod: "razorpay",
            },
          });
        }



      } catch (e) {
        console.warn(
          "Failed to persist Razorpay verification metadata:",
          e.message,
        );
      }
      return originalJson({ ...payload, verified: true });
    };

    return exports.recordPaymentByTenant(req, res);
  } catch (err) {
    console.error("verifyRazorpayPayment error:", err);
    return res
      .status(500)
      .json({
        success: false,
        error: err.message || "Failed to verify Razorpay payment",
      });
  }
};

// Get rent/payment history for a tenant by loginId
exports.getRentsByTenant = async (req, res) => {
  try {
    const tenantLoginId = String(req.params.tenantLoginId || "")
      .trim()
      .toUpperCase();
    const limit = Math.min(Number(req.query.limit || 12), 100);

    if (!tenantLoginId) {
      return res
        .status(400)
        .json({ success: false, message: "tenantLoginId is required" });
    }

    const rents = await Rent.find({ tenantLoginId })
      .sort({ paymentDate: -1, updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, rents });
  } catch (err) {
    console.error("Get rents by tenant error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Get invoice-based rent data for the authenticated tenant dashboard
exports.getTenantInvoiceSummary = async (req, res) => {
  try {
    const tenantLoginId = String(req.user?.loginId || "")
      .trim()
      .toUpperCase();
    if (!tenantLoginId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Authenticated tenant loginId is required",
        });
    }

    const tenant = await Tenant.findOne({ loginId: tenantLoginId })
      .select("_id loginId ownerLoginId")
      .lean();
    if (!tenant) {
      return res
        .status(404)
        .json({ success: false, message: "Tenant record not found" });
    }

    const invoices = await require("../models/RentInvoice")
      .find({ tenantId: tenant._id })
      .sort({ billingMonth: -1, dueDate: -1, createdAt: -1 })
      .lean();

    // Always prefer the current billing month invoice regardless of paid/unpaid status,
    // so a freshly-paid invoice is still displayed correctly in the tenant dashboard.
    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentMonthInvoice = invoices.find((inv) => inv.billingMonth === currentMonth);

    const activeInvoices = invoices.filter(
      (inv) =>
        !["PAID", "WAIVED", "CANCELLED"].includes(
          String(inv.status || "").toUpperCase(),
        ),
    );
    const fallbackInvoice =
      activeInvoices.sort((a, b) => {
        const phaseDiff =
          Number(b.currentPhase || 0) - Number(a.currentPhase || 0);
        if (phaseDiff !== 0) return phaseDiff;
        const dueDiff =
          Number(b.outstandingAmount || b.totalDue || 0) -
          Number(a.outstandingAmount || a.totalDue || 0);
        if (dueDiff !== 0) return dueDiff;
        const aDate = new Date(a.dueDate || a.createdAt || 0).getTime();
        const bDate = new Date(b.dueDate || b.createdAt || 0).getTime();
        return bDate - aDate;
      })[0] ||
      invoices[0] ||
      null;

    const currentInvoice = currentMonthInvoice || fallbackInvoice;

    // Skip re-evaluation for already-PAID invoices to avoid overwriting the paid state
    const invoiceIsPaid = ["PAID", "WAIVED"].includes(
      String(currentInvoice?.status || "").toUpperCase(),
    );
    let liveInvoice = currentInvoice;
    if (currentInvoice && !invoiceIsPaid) {
      try {
        const evaluated = await evaluateInvoice(currentInvoice);
        liveInvoice = {
          ...currentInvoice,
          ...evaluated.updates,
        };
      } catch (evalErr) {
        console.warn(
          "getTenantInvoiceSummary evaluateInvoice failed:",
          evalErr.message,
        );
      }
    }

    return res.json({
      success: true,
      invoice: liveInvoice,
      invoices,
    });
  } catch (err) {
    console.error("getTenantInvoiceSummary error:", err);
    return res
      .status(500)
      .json({
        success: false,
        message: err.message || "Failed to load tenant invoice summary",
      });
  }
};

// Send payment confirmation email
async function sendPaymentConfirmationEmail(rent) {
  try {
    const subject = `Payment Confirmation - ${rent.propertyName}`;
    const transactionId =
      rent.razorpayPaymentId || rent.razorpayOrderId || "N/A";
    const html = `
                <h2>Payment Confirmation</h2>
                <p>Dear ${rent.tenantName},</p>
                <p>Your rent payment has been recorded successfully.</p>
                <hr>
                <p><strong>Payment Details:</strong></p>
                <ul>
                    <li>Property: ${rent.propertyName}</li>
                    <li>Amount Paid: ₹${rent.paidAmount}</li>
                    <li>Total Due: ₹${rent.totalDue}</li>
                    <li>Payment Status: ${rent.paymentStatus}</li>
                    <li>Payment Method: ${rent.paymentMethod || "N/A"}</li>
                    <li>Transaction ID: ${transactionId}</li>
                    <li>Payment Date: ${new Date(rent.paymentDate).toLocaleDateString()}</li>
                </ul>
                <p>Thank you for your payment!</p>
            `;

    if (rent.tenantEmail) {
      await sendMail(rent.tenantEmail, subject, "", html);
    }
    if (process.env.ADMIN_EMAIL) {
      await sendMail(process.env.ADMIN_EMAIL, `[Copy] ${subject}`, "", html);
    }

    console.log(
      "Payment confirmation email attempted for",
      rent.tenantEmail || "no-tenant-email",
    );
  } catch (err) {
    console.error("Failed to send payment email:", err.message);
  }
}

async function createRentPaymentHistory({
  rent,
  invoice = null,
  paidAt = new Date(),
  recordedBy = "system",
  transactionId = null,
  notes = "",
}) {
  if (!rent) return null;

  let invoiceDoc = invoice;
  if (!invoiceDoc) {
    try {
      const query = { billingMonth: rent.collectionMonth };
      const tenantCandidates = [];

      if (rent.tenantId) {
        tenantCandidates.push({ tenantId: rent.tenantId });
      }
      if (rent.tenantLoginId) {
        const tenantDoc = await Tenant.findOne({
          loginId: String(rent.tenantLoginId).trim().toUpperCase(),
        })
          .select("_id")
          .lean();
        if (tenantDoc?._id) tenantCandidates.push({ tenantId: tenantDoc._id });
      }
      if (rent.tenantEmail) {
        tenantCandidates.push({ tenantEmail: rent.tenantEmail });
      }

      if (tenantCandidates.length) {
        query.$or = tenantCandidates;
        invoiceDoc = await RentInvoice.findOne(query).lean();
      }

      if (!invoiceDoc) {
        // Fallback search by property + billingMonth if tenant matching fails
        invoiceDoc = await RentInvoice.findOne({
          billingMonth: rent.collectionMonth,
          propertyId: rent.propertyId,
        }).lean();
      }
    } catch (err) {
      console.warn(
        "createRentPaymentHistory invoice lookup failed:",
        err.message,
      );
    }
  }

  if (!invoiceDoc) {
    console.warn(
      "createRentPaymentHistory skipped: invoice not found for rent",
      rent._id,
      "billingMonth",
      rent.collectionMonth,
    );
    return null;
  }

  const ownerId = invoiceDoc.ownerId || (rent.ownerId ? rent.ownerId : null);
  const tenantId = rent.tenantId || invoiceDoc.tenantId;
  const propertyId = rent.propertyId || invoiceDoc.propertyId;

  if (!ownerId || !tenantId || !propertyId) {
    console.warn(
      "createRentPaymentHistory skipped: missing owner/tenant/property id for rent",
      rent._id,
    );
    return null;
  }

  const amount = Number(
    invoiceDoc.totalDue || rent.totalDue || rent.rentAmount || 0,
  );
  const rentPaidAmount = Number(invoiceDoc.rentAmount || rent.rentAmount || 0);
  const penaltyPaidAmount = Number(invoiceDoc.totalPenalty || 0);
  const remainingAfter = Math.max(0, amount - Number(rent.paidAmount || 0));
  const isPartial = Number(rent.paidAmount || 0) < amount;
  const method = String(rent.paymentMethod || "cash").toLowerCase();

  try {
    console.log("createRentPaymentHistory create payload", {
      rentId: rent._id,
      invoiceId: invoiceDoc._id,
      tenantId,
      amount,
      rentPaidAmount,
      penaltyPaidAmount,
      paymentDate: paidAt,
      recordedBy,
      transactionId:
        transactionId ||
        rent.razorpayPaymentId ||
        rent.razorpayOrderId ||
        String(Date.now()),
    });

    const payment = await RentPayment.create({
      invoiceId: invoiceDoc._id,
      tenantId,
      propertyId,
      ownerId,
      amount,
      paymentMethod:
        method === "razorpay" ? "online" : method === "cash" ? "cash" : method,
      transactionId:
        transactionId ||
        rent.razorpayPaymentId ||
        rent.razorpayOrderId ||
        String(Date.now()),
      isPartial,
      remainingAfter,
      rentPaidAmount,
      penaltyPaidAmount,
      paymentDate: paidAt,
      recordedBy,
      notes: notes || "Rent payment record created",
    });

    console.log("SUCCESS: RentPayment created with ID:", payment._id);
    return payment;
  } catch (err) {
    console.error("createRentPaymentHistory failed:", err.message, err.stack);
    return null;
  }
}

// Send rent reminder (called during collection period: 10-15th)
exports.sendRentReminder = async (req, res) => {
  try {
    const today = new Date().getDate();

    if (today < 10 || today > 15) {
      return res.json({ message: "Not in collection period (10-15th)" });
    }

    const currentMonth = new Date().toISOString().slice(0, 7);
    const pendingRents = await Rent.find({
      collectionMonth: currentMonth,
      paymentStatus: { $in: ["pending", "partially_paid"] },
    });

    let sent = 0;
    for (const rent of pendingRents) {
      const emailSent = await sendRentReminderEmail(rent, "initial");
      if (emailSent) {
        rent.reminders.push({
          sentAt: new Date(),
          type: "initial",
          status: "sent",
          message: "Initial rent reminder",
        });
        await rent.save();
        sent++;
      }
    }

    res.json({ success: true, sent, message: `Sent ${sent} rent reminders` });
  } catch (err) {
    console.error("Send reminder error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Send delayed payment reminder (3x daily for overdue rents)
exports.sendDelayedPaymentReminder = async (req, res) => {
  try {
    const today = new Date().getDate();

    if (today > 15 && today <= 31) {
      // Collection period ended, find overdue rents
      const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1))
        .toISOString()
        .slice(0, 7);

      const overdueRents = await Rent.find({
        collectionMonth: lastMonth,
        paymentStatus: { $in: ["pending", "partially_paid", "overdue"] },
      });

      let sent = 0;
      for (const rent of overdueRents) {
        // Limit to 3 reminders per day for each rent
        const todayReminders = rent.reminders.filter((r) => {
          const sentDate = new Date(r.sentAt);
          return (
            sentDate.toDateString() === new Date().toDateString() &&
            r.type.includes("delayed")
          );
        });

        if (todayReminders.length < 3) {
          const reminderType = `delayed_${todayReminders.length + 1}`;
          const emailSent = await sendDelayedReminderEmail(rent, reminderType);

          if (emailSent) {
            rent.paymentStatus = "overdue";
            if (!rent.overdueStartDate) rent.overdueStartDate = new Date();

            rent.reminders.push({
              sentAt: new Date(),
              type: reminderType,
              status: "sent",
              message: `Delayed payment reminder #${todayReminders.length + 1}`,
            });
            await rent.save();
            sent++;
          }
        }
      }

      res.json({
        success: true,
        sent,
        message: `Sent ${sent} delayed payment reminders`,
      });
    } else {
      res.json({ message: "Collection period still active" });
    }
  } catch (err) {
    console.error("Send delayed reminder error:", err);
    res.status(500).json({ error: err.message });
  }
};

// Email function for rent reminder
async function sendRentReminderEmail(rent, type = "initial") {
  try {
    const appBaseUrl = (
      process.env.APP_BASE_URL || "https://app.roomhy.com"
    ).replace(/\/$/, "");
    const dashboardUrl = `${appBaseUrl}/tenant/tenantdashboard`;
    const onlinePayUrl = `${dashboardUrl}?pay=online`;
    const cashPayUrl = `${dashboardUrl}?pay=cash`;
    const subject = `Rent Due Reminder - ${rent.propertyName}`;
    const text = [
      `Hi ${rent.tenantName || "Tenant"},`,
      `Your rent for ${rent.propertyName || "your property"} is due by 15th (${rent.collectionMonth || "current month"}).`,
      `Amount: INR ${Number(rent.rentAmount || 0)}`,
      "",
      "Payment options:",
      `1) Pay Online (Razorpay): ${onlinePayUrl}`,
      `2) Pay by Cash (Owner collection + OTP): ${cashPayUrl}`,
      "",
      "If already paid, please ignore this reminder.",
    ].join("\n");
    const html = `
                <h2>Rent Due Reminder</h2>
                <p>Dear ${rent.tenantName},</p>
                <p>This is a reminder that rent is due between <strong>10th to 15th</strong> of the month.</p>
                <hr>
                <p><strong>Rent Details:</strong></p>
                <ul>
                    <li>Property: ${rent.propertyName}</li>
                    <li>Room: ${rent.roomNumber}</li>
                    <li>Rent Amount: ₹${rent.rentAmount}</li>
                    <li>Collection Period: 10th - 15th of the month</li>
                    <li>Current Month: ${rent.collectionMonth}</li>
                </ul>
                <p style="color: #d32f2f;"><strong>Please complete your payment by 15th to avoid late fees.</strong></p>
                <p>Choose a payment method:</p>
                <p>
                    <a href="${onlinePayUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-right: 8px;">Pay Online (Razorpay)</a>
                    <a href="${cashPayUrl}" style="background-color: #16a34a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Pay by Cash</a>
                </p>
                <p style="font-size: 13px; color: #444;">
                    Cash flow: Request cash in tenant dashboard, owner marks received, then enter OTP to complete.
                </p>
            `;

    if (rent.tenantEmail) {
      await sendMail(rent.tenantEmail, subject, text, html);
    }
    if (process.env.ADMIN_EMAIL) {
      await sendMail(process.env.ADMIN_EMAIL, `[Copy] ${subject}`, text, html);
    }

    console.log(
      "Rent reminder email attempted for",
      rent.tenantEmail || "no-tenant-email",
    );
    return true;
  } catch (err) {
    console.error("Failed to send rent reminder:", err.message);
    return false;
  }
}

// Email function for delayed payment reminder
async function sendDelayedReminderEmail(rent, reminderType) {
  try {
    const reminderNumber = reminderType.split("_")[1];
    const urgency = ["", "URGENT", "VERY URGENT", "FINAL NOTICE"];
    const appBaseUrl = (
      process.env.APP_BASE_URL || "https://app.roomhy.com"
    ).replace(/\/$/, "");
    const dashboardUrl = `${appBaseUrl}/tenant/tenantdashboard`;
    const onlinePayUrl = `${dashboardUrl}?pay=online`;
    const cashPayUrl = `${dashboardUrl}?pay=cash`;

    const subject = `${urgency[reminderNumber]} - Overdue Rent Payment - ${rent.propertyName}`;
    const text = [
      `${urgency[reminderNumber]}: Overdue rent payment`,
      `Property: ${rent.propertyName || "-"}`,
      `Room: ${rent.roomNumber || "-"}`,
      `Amount Due: INR ${Number((rent.totalDue || 0) - (rent.paidAmount || 0))}`,
      `Days Overdue: ${getDaysOverdue(rent.overdueStartDate)}`,
      "",
      "Pay now using:",
      `1) Razorpay Online: ${onlinePayUrl}`,
      `2) Cash + OTP flow: ${cashPayUrl}`,
    ].join("\n");
    const html = `
                <h2 style="color: #d32f2f;">${urgency[reminderNumber]}</h2>
                <p>Dear ${rent.tenantName},</p>
                <p style="color: #d32f2f; font-weight: bold;">Your rent payment is overdue!</p>
                <hr>
                <p><strong>Overdue Details:</strong></p>
                <ul>
                    <li>Property: ${rent.propertyName}</li>
                    <li>Room: ${rent.roomNumber}</li>
                    <li>Amount Due: ₹${rent.totalDue - rent.paidAmount}</li>
                    <li>Due Date: 15th of ${rent.collectionMonth}</li>
                    <li>Days Overdue: ${getDaysOverdue(rent.overdueStartDate)}</li>
                </ul>
                <p style="color: #d32f2f; background-color: #fff3cd; padding: 10px; border-left: 4px solid #d32f2f;">
                    <strong>Reminder #${reminderNumber}:</strong> Please arrange payment immediately to avoid late fees and legal action.
                </p>
                <p>
                    <a href="${onlinePayUrl}" style="background-color: #d32f2f; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; margin-right: 8px;">Pay Online (Razorpay)</a>
                    <a href="${cashPayUrl}" style="background-color: #16a34a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Pay by Cash</a>
                </p>
            `;

    if (rent.tenantEmail) {
      await sendMail(rent.tenantEmail, subject, text, html);
    }
    if (process.env.ADMIN_EMAIL) {
      await sendMail(process.env.ADMIN_EMAIL, `[Copy] ${subject}`, text, html);
    }

    console.log(
      `Delayed payment reminder #${reminderNumber} attempted for`,
      rent.tenantEmail || "no-tenant-email",
    );
    return true;
  } catch (err) {
    console.error("Failed to send delayed reminder:", err.message);
    return false;
  }
}

// Helper function to calculate days overdue
function getDaysOverdue(overdueStartDate) {
  if (!overdueStartDate) return 0;
  const today = new Date();
  const start = new Date(overdueStartDate);
  return Math.floor((today - start) / (1000 * 60 * 60 * 24));
}

// Update rent details (admin)
exports.updateRent = async (req, res) => {
  try {
    const { rentId } = req.params;
    const updateData = req.body;

    const rent = await Rent.findByIdAndUpdate(
      rentId,
      { $set: updateData },
      { new: true },
    );
    if (!rent) return res.status(404).json({ error: "Rent not found" });

    res.json({ success: true, rent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Delete rent record
exports.deleteRent = async (req, res) => {
  try {
    const { rentId } = req.params;
    await Rent.findByIdAndDelete(rentId);
    res.json({ success: true, message: "Rent deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Create Razorpay order for rent payment
exports.createRazorpayOrder = async (req, res) => {
  try {
    const Razorpay = require("razorpay");
    const { amount, tenantId, rentId, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Check if Razorpay credentials are configured
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret || keySecret === "your_key_secret_here") {
      console.error(
        "⚠️  Razorpay credentials not configured. Add to .env file:",
      );
      console.error("RAZORPAY_KEY_ID=rzp_test_xxxxx");
      console.error("RAZORPAY_KEY_SECRET=your_actual_key_secret");
      return res.status(500).json({
        error:
          "Razorpay credentials not configured. Please add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env file",
        instructions:
          "Get your credentials from https://dashboard.razorpay.com/app/keys",
      });
    }

    const razorpay = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });

    const options = {
      amount: amount * 100, // Convert to paise
      currency: "INR",
      receipt: buildRazorpayReceipt("rent", rentId, tenantId),
      notes: {
        tenantId: tenantId || "unknown",
        rentId: rentId || "unknown",
        description: description || "Rent Payment",
        token: req.body.token || "none",
      },
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
      key: keyId,
    });
  } catch (err) {
    console.error("Razorpay order creation error:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to create payment order" });
  }
};

// Tenant requests cash payment collection by owner
exports.requestCashPayment = async (req, res) => {
  try {
    const {
      tenantLoginId,
      ownerLoginId,
      amount,
      propertyName,
      roomNumber,
      tenantName,
      tenantEmail,
      tenantPhone,
      rentId
    } = req.body || {};

    if (!tenantLoginId || !ownerLoginId || !amount) {
      return res
        .status(400)
        .json({
          success: false,
          message: "tenantLoginId, ownerLoginId and amount are required",
        });
    }

    const loginId = String(tenantLoginId).trim().toUpperCase();
    const ownerId = String(ownerLoginId).trim().toUpperCase();
    const rentAmount = Number(amount || 0);
    if (!Number.isFinite(rentAmount) || rentAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid amount" });
    }

    const month = new Date().toISOString().slice(0, 7);

    const tenantProfile = await getTenantProfileByLoginId(loginId);

    let rent;
    if (rentId) {
      rent = await Rent.findById(rentId);
    } else {
      rent = await Rent.findOne({
        tenantLoginId: loginId,
        ownerLoginId: ownerId,
        collectionMonth: month,
      }).sort({ createdAt: -1 });
    }

    if (!rent) {
      rent = await Rent.create({
        tenantLoginId: loginId,
        ownerLoginId: ownerId,
        tenantId: tenantProfile?._id,
        tenantName: tenantName || tenantProfile?.name || "",
        tenantEmail: tenantEmail || tenantProfile?.email || "",
        tenantPhone: tenantPhone || tenantProfile?.phone || "",
        propertyName: propertyName || tenantProfile?.propertyTitle || "",
        roomNumber: roomNumber || tenantProfile?.roomNo || "",
        rentAmount,
        totalDue: rentAmount,
        paidAmount: 0,
        paymentStatus: "pending",
        paymentMethod: "cash",
        collectionMonth: month,
        cashRequestStatus: "pending_approval",
        cashRequestedAt: new Date(),
      });
    } else {
      applyTenantProfileToRent(rent, tenantProfile);
      if (
        ["paid", "completed"].includes(
          String(rent.paymentStatus || "").toLowerCase(),
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message: "Already paid rent cannot create another cash request",
          });
      }
      if (
        [
          "requested",
          "pending_approval",
          "owner_approved",
          "otp_sent",
          "received",
        ].includes(String(rent.cashRequestStatus || "").toLowerCase())
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message: "A cash request already exists for this rent",
          });
      }
      rent.paymentMethod = "cash";
      rent.paymentStatus = rent.paymentStatus === "paid" ? "paid" : "pending";
      rent.rentAmount = rentAmount || rent.rentAmount;
      rent.totalDue = rentAmount || rent.totalDue;
      rent.tenantName = tenantName || rent.tenantName;
      rent.tenantEmail = tenantEmail || rent.tenantEmail;
      rent.tenantPhone = tenantPhone || rent.tenantPhone;
      rent.propertyName = propertyName || rent.propertyName;
      rent.roomNumber = roomNumber || rent.roomNumber;
      rent.cashRequestStatus = "pending_approval";
      rent.cashRequestedAt = new Date();
      rent.cashApprovedAt = undefined;
      rent.cashReceivedAt = undefined;
      rent.cashOtpHash = undefined;
      rent.cashOtpExpiry = undefined;
      rent.cashOtpSentAt = undefined;
      rent.cashOtpVerifiedAt = undefined;
      rent.cashVerifiedBy = undefined;
      rent.cashRejectedReason = undefined;
      rent.cashRejectedAt = undefined;
      rent.cashOtpAttempts = 0;
    }
    await rent.save();
    await createRentAudit(
      "CASH_REQUESTED",
      {
        ownerId: rent.ownerLoginId,
        tenantId: rent.tenantId,
        propertyId: rent.propertyId,
        invoiceId: undefined,
        rentId: rent._id,
        amount: rentAmount,
      },
      loginId,
    );

    const isPendingPast = rent.collectionMonth && rent.collectionMonth !== new Date().toISOString().slice(0, 7);
    const monthUi = rent.collectionMonth ? new Date(`${rent.collectionMonth}-01`).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : "Rent";
    const notificationTitle = isPendingPast ? `Pending Rent Cash Payment Request (${monthUi})` : "Cash Payment Request";
    const emailSubject = isPendingPast ? `RoomHy Pending Rent Cash Payment Request (${monthUi})` : "RoomHy Cash Payment Request";

    await Notification.create({
      toLoginId: ownerId,
      from: loginId,
      type: "cash_payment_requested",
      meta: {
        title: notificationTitle,
        message: `${tenantName || loginId} requested cash payment collection for ${monthUi}`,
        rentId: String(rent._id),
        tenantLoginId: loginId,
        amount: rentAmount,
      },
      read: false,
    });

    try {
      const ownerEmail = await resolveOwnerEmail(ownerId);
      if (ownerEmail) {
        const ownerPortalBaseUrl = (
          process.env.OWNER_PORTAL_URL ||
          process.env.API_URL ||
          process.env.APP_BASE_URL ||
          "https://api.roomhy.com"
        ).replace(/\/$/, "");
        const receivedUrl = `${ownerPortalBaseUrl}/propertyowner/payment?requestId=${encodeURIComponent(String(rent._id))}`;
        const html = `
                    <div style="font-family:Arial,sans-serif;">
                        <h3>Cash Payment Request</h3>
                        <p>Tenant has requested to pay rent by cash.</p>
                        <p><strong>Tenant:</strong> ${tenantName || loginId}</p>
                        <p><strong>Login ID:</strong> ${loginId}</p>
                        <p><strong>Amount:</strong> INR ${rentAmount}</p>
                        <p><strong>Property:</strong> ${propertyName || "-"}</p>
                        <p><strong>Room:</strong> ${roomNumber || "-"}</p>
                        <p style="margin:16px 0;">
                            <a href="${receivedUrl}" style="background:#16a34a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block;font-weight:600;">
                                Payment Received
                            </a>
                        </p>
                        <p style="font-size:12px;color:#666;">If button does not open, copy this link:<br>${receivedUrl}</p>
                    </div>
                `;
        await sendMail(ownerEmail, "RoomHy Cash Payment Request", "", html);
      }
    } catch (e) {
      console.warn("cash request owner email failed:", e.message);
    }

    try {
      const sseManager = require('../utils/sseManager');
      sseManager.notifyOwner(ownerId, 'CASH_REQUEST_NEW', { rentId: rent._id, tenantLoginId: loginId, tenantName: rent.tenantName });
    } catch (e) {
      console.warn("sse push failed:", e.message);
    }

    return res.json({
      success: true,
      message: "Cash payment request sent to owner",
      rent,
    });
  } catch (err) {
    console.error("requestCashPayment error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.listCashRequests = async (req, res) => {
  try {
    const ownerLoginId = String(
      req.query.ownerId || req.query.ownerLoginId || req.user?.loginId || "",
    )
      .trim()
      .toUpperCase();
    if (!ownerLoginId) {
      return res
        .status(400)
        .json({ success: false, message: "ownerId is required" });
    }

    const status = String(req.query.status || "")
      .trim()
      .toLowerCase();
    const statuses = status
      ? [status]
      : ["pending_approval", "requested", "owner_approved", "otp_sent"];

    const requests = await Rent.find({
      ownerLoginId,
      cashRequestStatus: { $in: statuses },
    })
      .sort({ cashRequestedAt: -1, updatedAt: -1 })
      .populate("tenantId", "name email phone roomNo bedNo")
      .populate("propertyId", "title")
      .lean();

    return res.json({ success: true, requests });
  } catch (err) {
    console.error("listCashRequests error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Start reminder campaign for all unpaid rents and send immediate reminder
exports.startManualUnpaidReminders = async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const unpaidRents = await Rent.find({
      collectionMonth: currentMonth,
      paymentStatus: {
        $in: ["pending", "partially_paid", "overdue", "defaulted"],
      },
    });

    if (!unpaidRents.length) {
      return res.json({
        success: true,
        sent: 0,
        enabled: 0,
        message: "No unpaid tenants found",
      });
    }

    let sent = 0;
    let enabled = 0;
    for (const rent of unpaidRents) {
      const sentNow = await sendRentReminderEmail(rent, "initial");

      rent.autoReminderEnabled = true;
      if (!rent.autoReminderStartedAt) {
        rent.autoReminderStartedAt = new Date();
      }
      if (sentNow) {
        rent.autoReminderLastSentAt = new Date();
        rent.reminders.push({
          sentAt: new Date(),
          type: "auto_daily",
          status: "sent",
          message: "Manual trigger + daily auto reminder enabled",
        });
        sent++;
      }
      enabled++;
      await rent.save();
    }

    return res.json({
      success: true,
      sent,
      enabled,
      message: `Reminder sent to ${sent} unpaid tenant(s). Daily auto reminders enabled until payment.`,
    });
  } catch (err) {
    console.error("startManualUnpaidReminders error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Owner approves cash request -> generate OTP and send it to the owner's email
exports.approveCashRequest = async (req, res) => {
  try {
    const requestId =
      req.params.requestId || req.body?.rentId || req.body?.requestId;
    const ownerLoginId = req.user?.loginId || req.body?.ownerLoginId;
    if (!requestId || !ownerLoginId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "requestId and ownerLoginId are required",
        });
    }

    const ownerId = String(ownerLoginId).trim().toUpperCase();
    const rent = await Rent.findById(requestId);
    if (!rent)
      return res
        .status(404)
        .json({ success: false, message: "Rent record not found" });
    if (String(rent.ownerLoginId || "").toUpperCase() !== ownerId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Not authorized for this rent record",
        });
    }

    if (
      ["paid", "completed"].includes(
        String(rent.paymentStatus || "").toLowerCase(),
      )
    ) {
      return res
        .status(409)
        .json({ success: false, message: "Rent already paid" });
    }
    if (
      !["pending_approval", "requested"].includes(
        String(rent.cashRequestStatus || "").toLowerCase(),
      )
    ) {
      return res
        .status(409)
        .json({
          success: false,
          message: "Cash request must be pending approval",
        });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiry = new Date(Date.now() + 5 * 60 * 1000);
    rent.cashRequestStatus = "owner_approved";
    rent.cashApprovedAt = new Date();
    rent.cashReceivedAt = new Date();
    rent.cashOtpHash = hashCashOtp(otp);
    rent.cashOtpExpiry = expiry;
    rent.cashOtpSentAt = new Date();
    rent.cashOtpAttempts = 0;
    rent.paymentMethod = "cash";
    await rent.save();

    await createRentAudit(
      "CASH_APPROVED",
      {
        ownerId: rent.ownerLoginId,
        tenantId: rent.tenantId,
        propertyId: rent.propertyId,
        rentId: rent._id,
      },
      ownerId,
    );
    await createRentAudit(
      "OTP_GENERATED",
      {
        ownerId: rent.ownerLoginId,
        tenantId: rent.tenantId,
        propertyId: rent.propertyId,
        rentId: rent._id,
      },
      ownerId,
    );

    const ownerEmail = await resolveOwnerEmail(ownerId);
    if (!ownerEmail) {
      return res
        .status(400)
        .json({ success: false, message: "Owner email missing in profile" });
    }

    const isPendingPast = rent.collectionMonth && rent.collectionMonth !== new Date().toISOString().slice(0, 7);
    const monthUi = rent.collectionMonth ? new Date(`${rent.collectionMonth}-01`).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : "Rent";
    const emailSubject = isPendingPast ? `RoomHy Pending Cash Payment Verification OTP (${monthUi})` : "RoomHy Cash Payment Verification OTP";

    const html = `
            <div style="font-family:Arial,sans-serif;">
                <h3>${emailSubject}</h3>
                <p>Share this OTP with the tenant after receiving cash.</p>
                <p style="font-size:26px;font-weight:700;letter-spacing:3px;">${otp}</p>
                <p style="font-size:12px;color:#666;">Expires in 5 minutes. Single use only.</p>
            </div>
        `;
    await sendMail(
      ownerEmail,
      emailSubject,
      "",
      html,
    );
    await createRentAudit(
      "OTP_SENT",
      {
        ownerId: rent.ownerLoginId,
        tenantId: rent.tenantId,
        propertyId: rent.propertyId,
        rentId: rent._id,
      },
      ownerId,
    );

    return res.json({
      success: true,
      message: "OTP sent to owner email",
      rentId: String(rent._id),
      cashRequestStatus: rent.cashRequestStatus,
    });
  } catch (err) {
    console.error("approveCashRequest error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.markCashReceivedByOwner = exports.approveCashRequest;

exports.rejectCashRequest = async (req, res) => {
  try {
    const requestId =
      req.params.requestId || req.body?.rentId || req.body?.requestId;
    const ownerLoginId = req.user?.loginId || req.body?.ownerLoginId;
    if (!requestId || !ownerLoginId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "requestId and ownerLoginId are required",
        });
    }

    const ownerId = String(ownerLoginId).trim().toUpperCase();
    const rent = await Rent.findById(requestId);
    if (!rent)
      return res
        .status(404)
        .json({ success: false, message: "Rent record not found" });
    if (String(rent.ownerLoginId || "").toUpperCase() !== ownerId) {
      return res
        .status(403)
        .json({
          success: false,
          message: "Not authorized for this rent record",
        });
    }

    const reason = String(req.body?.reason || "").trim();
    rent.cashRequestStatus = "rejected";
    rent.cashRejectedReason = reason || "Rejected by owner";
    rent.cashRejectedAt = new Date();
    rent.cashOtpHash = undefined;
    rent.cashOtpExpiry = undefined;
    rent.cashOtpSentAt = undefined;
    await rent.save();

    await Notification.create({
      toLoginId: String(rent.tenantLoginId || "").toUpperCase(),
      from: ownerId,
      type: "cash_payment_rejected",
      meta: {
        title: "Cash Payment Request Rejected",
        message:
          reason || "Your cash payment request was rejected by the owner",
        rentId: String(rent._id),
      },
      read: false,
    }).catch(() => { });

    try {
      const tenantEmail =
        rent.tenantEmail ||
        (
          await Tenant.findOne({ loginId: rent.tenantLoginId })
            .select("email")
            .lean()
        )?.email ||
        "";
      if (tenantEmail) {
        const isPendingPast = rent.collectionMonth && rent.collectionMonth !== new Date().toISOString().slice(0, 7);
        const monthUi = rent.collectionMonth ? new Date(`${rent.collectionMonth}-01`).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : "Rent";
        const emailSubject = isPendingPast ? `RoomHy Pending Cash Payment Request Rejected (${monthUi})` : "RoomHy Cash Payment Request Rejected";

        await sendMail(
          tenantEmail,
          emailSubject,
          reason || "Your cash payment request was rejected by the owner.",
          `<div style="font-family:Arial,sans-serif;"><h3>${emailSubject}</h3><p>${reason || "Your cash payment request was rejected by the owner."}</p></div>`,
        );
      }
    } catch (_) { }

    await createRentAudit(
      "CASH_REJECTED",
      {
        ownerId: rent.ownerLoginId,
        tenantId: rent.tenantId,
        propertyId: rent.propertyId,
        rentId: rent._id,
        reason,
      },
      ownerId,
    );

    return res.json({ success: true, message: "Cash request rejected", rent });
  } catch (err) {
    console.error("rejectCashRequest error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Tenant verifies cash OTP -> mark payment paid
exports.verifyCashPaymentOtp = async (req, res) => {
  try {
    const { tenantLoginId, otp, rentId } = req.body || {};
    if (!tenantLoginId || !otp) {
      return res
        .status(400)
        .json({
          success: false,
          message: "tenantLoginId and otp are required",
        });
    }
    const loginId = String(tenantLoginId).trim().toUpperCase();

    let rent;
    if (rentId) {
      rent = await Rent.findById(rentId);
      if (rent && !["owner_approved", "otp_sent"].includes(String(rent.cashRequestStatus).toLowerCase())) {
        rent = null;
      }
    } else {
      rent = await Rent.findOne({
        tenantLoginId: loginId,
        cashRequestStatus: { $in: ["owner_approved", "otp_sent"] },
      }).sort({ updatedAt: -1 });
    }

    if (!rent)
      return res
        .status(404)
        .json({ success: false, message: "No pending cash payment found" });
    if (!rent.cashOtpHash || !rent.cashOtpExpiry) {
      return res
        .status(400)
        .json({ success: false, message: "OTP not sent yet by owner" });
    }
    if (new Date() > new Date(rent.cashOtpExpiry)) {
      rent.cashRequestStatus = "expired";
      await rent.save();
      return res.status(400).json({ success: false, message: "OTP expired" });
    }
    if ((rent.cashOtpAttempts || 0) >= (rent.cashOtpMaxAttempts || 5)) {
      rent.cashRequestStatus = "expired";
      await rent.save();
      return res
        .status(400)
        .json({ success: false, message: "OTP attempts exhausted" });
    }
    if (!verifyCashOtpHash(otp, rent.cashOtpHash)) {
      rent.cashOtpAttempts = (rent.cashOtpAttempts || 0) + 1;
      if (rent.cashOtpAttempts >= (rent.cashOtpMaxAttempts || 5)) {
        rent.cashRequestStatus = "expired";
      }
      await rent.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    const paidAt = new Date();
    rent.cashRequestStatus = "verified";
    rent.cashOtpVerifiedAt = paidAt;
    rent.cashVerifiedBy = loginId;
    rent.paymentStatus = "paid";
    rent.paymentMethod = "cash";
    rent.paidAmount = rent.totalDue || rent.rentAmount || rent.paidAmount || 0;
    rent.paymentDate = paidAt;
    rent.autoReminderEnabled = false;
    rent.autoReminderLastSentAt = undefined;
    rent.cashOtpHash = undefined;
    rent.cashOtpExpiry = undefined;
    rent.cashOtpAttempts = 0;
    await rent.save();

    // Build receipt FIRST so it is available for createRentPaymentHistory below
    let invoice = null;

    try {
      const tenantDoc = await Tenant.findOne({ loginId }).select("_id").lean();
      const invoiceQuery = {
        billingMonth: rent.collectionMonth,
      };
      if (tenantDoc?._id) {
        invoiceQuery.tenantId = tenantDoc._id;
      } else if (rent.tenantId) {
        invoiceQuery.tenantId = rent.tenantId;
      }

      invoice = await RentInvoice.findOne(invoiceQuery).lean();
      if (invoice) {
        const invoicePaidAmount = Number(
          rent.paidAmount || rent.totalDue || invoice.totalDue || rent.rentAmount || 0,
        );
        const invoiceRentAmount = Number(
          invoice.rentAmount || rent.rentAmount || 1500,
        );
        const invoiceElectricity = Number(invoice.electricityBill || 0);
        // Correctly split out the penalty based on what was actually paid, discounting the electricity bill
        const truePenaltyAmount = Math.max(0, invoicePaidAmount - invoiceRentAmount - invoiceElectricity);

        await RentInvoice.findByIdAndUpdate(invoice._id, {
          $set: {
            status: "PAID",
            paidAmount: invoicePaidAmount,
            totalDue: invoicePaidAmount,
            totalPenalty: truePenaltyAmount,
            rentPaidAmount: invoiceRentAmount,
            penaltyPaidAmount: truePenaltyAmount,
            outstandingAmount: 0,
            lastEvaluatedAt: paidAt,
          },
        });
        invoice = await RentInvoice.findById(invoice._id).lean();

        // Build receipt after invoice is refreshed so the receipt has accurate data
        const receipt = buildCashPaymentReceipt({ rent, invoice, paidAt });

        console.log("verifyCashPaymentOtp createRentPaymentHistory payload", {
          rentId: rent._id,
          invoiceId: invoice._id,
          tenantId: rent.tenantId,
          paidAmount: rent.paidAmount,
        });

        await createRentPaymentHistory({
          rent,
          invoice,
          paidAt,
          recordedBy: loginId,
          transactionId: receipt ? receipt.receiptNumber : String(Date.now()),
          notes: "Cash payment verified by tenant OTP",
        });
      }
    } catch (invoiceErr) {
      console.warn(
        "verifyCashPaymentOtp invoice sync failed:",
        invoiceErr.message,
      );
    }

    // Build a final receipt for the response (using whatever invoice data we have)
    const receipt = buildCashPaymentReceipt({ rent, invoice, paidAt });

    try {
      await Notification.create({
        toLoginId: String(rent.ownerLoginId || "").toUpperCase(),
        from: loginId,
        type: "cash_payment_completed",
        meta: {
          title: "Cash Payment Completed",
          message: `${rent.tenantName || loginId} verified cash OTP and payment marked paid`,
          rentId: String(rent._id),
          amount: rent.paidAmount,
        },
        read: false,
      });
    } catch (_) { }

    try {
      const tenantEmail =
        rent.tenantEmail ||
        (await Tenant.findOne({ loginId }).select("email").lean())?.email ||
        "";
      if (tenantEmail) {
        const isPendingPast = rent.collectionMonth && rent.collectionMonth !== new Date().toISOString().slice(0, 7);
        const monthUi = rent.collectionMonth ? new Date(`${rent.collectionMonth}-01`).toLocaleString('en-US', { month: 'long', year: 'numeric' }) : "Rent";
        const emailSubject = isPendingPast ? `RoomHy Pending Cash Payment Verified (${monthUi})` : "RoomHy Cash Payment Verified";

        await sendMail(
          tenantEmail,
          emailSubject,
          "Your cash rent payment has been verified successfully.",
          `<div style="font-family:Arial,sans-serif;"><h3>Your cash rent payment has been verified successfully.</h3></div>`,
        );
      }
    } catch (_) { }

    await createRentAudit(
      "CASH_VERIFIED",
      {
        ownerId: rent.ownerLoginId,
        tenantId: rent.tenantId,
        propertyId: rent.propertyId,
        rentId: rent._id,
      },
      loginId,
    );

    return res.json({
      success: true,
      message: "Cash payment marked as paid",
      rent,
      receipt,
      invoice,
    });
  } catch (err) {
    console.error("verifyCashPaymentOtp error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.buildCashPaymentReceipt = buildCashPaymentReceipt;

function normalizeLoginId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeAccountNumber(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim();
}

function extractOwnerPayoutInfo(ownerDoc) {
  const profile = ownerDoc?.profile || {};
  return {
    ownerName: profile.name || ownerDoc?.name || "",
    ownerEmail: profile.email || ownerDoc?.email || "",
    bankName: profile.bankName || ownerDoc?.checkinBankName || "",
    accountHolderName:
      ownerDoc?.checkinAccountHolderName ||
      profile.name ||
      ownerDoc?.name ||
      "",
    accountNumber: normalizeAccountNumber(
      profile.accountNumber || ownerDoc?.checkinBankAccountNumber || "",
    ),
    ifscCode: (profile.ifscCode || ownerDoc?.checkinIfscCode || "")
      .trim()
      .toUpperCase(),
    branchName: profile.branchName || ownerDoc?.checkinBranchName || "",
  };
}

async function sendOwnerPayoutSuccessEmail({
  toEmail,
  ownerName,
  amount,
  reference,
  propertyName,
  tenantLoginId,
}) {
  if (!toEmail) return;
  const subject = "RoomHy Owner Payout Successful";
  const html = `
        <div style="font-family:Arial,sans-serif;color:#111">
            <h3>Owner Payout Completed</h3>
            <p>Hi ${ownerName || "Owner"},</p>
            <p>Your payout has been transferred successfully.</p>
            <ul>
                <li><strong>Amount:</strong> INR ${Number(amount || 0).toLocaleString("en-IN")}</li>
                <li><strong>Reference:</strong> ${reference || "-"}</li>
                <li><strong>Property:</strong> ${propertyName || "-"}</li>
                <li><strong>Tenant Login ID:</strong> ${tenantLoginId || "-"}</li>
            </ul>
            <p>Thank you,<br>RoomHy Team</p>
        </div>
    `;
  await sendMail(toEmail, subject, "", html);
}

// Platform payout to owner bank account (superadmin action from platform.html)
exports.processOwnerPayout = async (req, res) => {
  try {
    const {
      ownerLoginId,
      tenantLoginId,
      amount,
      rentAmount,
      commissionAmount,
      serviceFeeAmount,
      propertyName,
    } = req.body || {};

    const ownerId = normalizeLoginId(ownerLoginId);
    const tenantId = normalizeLoginId(tenantLoginId);
    const payoutAmount = Number(amount || 0);

    if (
      !ownerId ||
      !tenantId ||
      !Number.isFinite(payoutAmount) ||
      payoutAmount <= 0
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message: "ownerLoginId, tenantLoginId and valid amount are required",
        });
    }

    const ownerDoc = await Owner.findOne({ loginId: ownerId });
    if (!ownerDoc) {
      return res
        .status(404)
        .json({ success: false, message: `Owner not found: ${ownerId}` });
    }

    const ownerInfo = extractOwnerPayoutInfo(ownerDoc);
    if (!ownerInfo.accountNumber || !ownerInfo.ifscCode) {
      return res.status(400).json({
        success: false,
        message:
          "Owner bank details missing (account number / IFSC). Please complete owner profile first.",
      });
    }

    const month = new Date().toISOString().slice(0, 7);
    const rentDocs = await Rent.find({
      ownerLoginId: ownerId,
      tenantLoginId: tenantId,
      collectionMonth: month,
    }).sort({ createdAt: -1 });

    if (!rentDocs.length) {
      return res
        .status(404)
        .json({
          success: false,
          message:
            "No rent record found for this owner/tenant in current month",
        });
    }

    const anyAlreadyPaid = rentDocs.some((r) => r.ownerPayoutStatus === "paid");
    if (anyAlreadyPaid) {
      return res
        .status(409)
        .json({
          success: false,
          message: "Payout already completed for this owner/tenant",
        });
    }

    // Mark processing before external call
    await Rent.updateMany(
      { _id: { $in: rentDocs.map((r) => r._id) } },
      {
        $set: {
          ownerPayoutStatus: "processing",
          ownerPayoutAmount: payoutAmount,
          ownerPayoutNote: `Rent: ${Number(rentAmount || 0)}, Commission: ${Number(commissionAmount || 0)}, Service Fee: ${Number(serviceFeeAmount || 0)}`,
        },
      },
    );

    const Razorpay = require("razorpay");
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const payoutAccountNumber = process.env.RAZORPAY_PAYOUT_ACCOUNT_NUMBER;

    if (!keyId || !keySecret) {
      await Rent.updateMany(
        { _id: { $in: rentDocs.map((r) => r._id) } },
        {
          $set: {
            ownerPayoutStatus: "failed",
            ownerPayoutNote: "Razorpay key/secret not configured",
          },
        },
      );
      return res
        .status(500)
        .json({
          success: false,
          message: "Razorpay credentials are not configured",
        });
    }

    if (!payoutAccountNumber) {
      await Rent.updateMany(
        { _id: { $in: rentDocs.map((r) => r._id) } },
        {
          $set: {
            ownerPayoutStatus: "failed",
            ownerPayoutNote: "RAZORPAY_PAYOUT_ACCOUNT_NUMBER missing",
          },
        },
      );
      return res
        .status(500)
        .json({
          success: false,
          message:
            "RAZORPAY_PAYOUT_ACCOUNT_NUMBER is required for payout transfers",
        });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

    // Create contact and fund account for owner payout
    const contact = await razorpay.contacts.create({
      name: ownerInfo.ownerName || ownerId,
      email: ownerInfo.ownerEmail || undefined,
      type: "vendor",
      reference_id: `owner_${ownerId}`,
      notes: { ownerLoginId: ownerId },
    });

    const fundAccount = await razorpay.fundAccount.create({
      contact_id: contact.id,
      account_type: "bank_account",
      bank_account: {
        name: ownerInfo.accountHolderName || ownerInfo.ownerName || ownerId,
        ifsc: ownerInfo.ifscCode,
        account_number: ownerInfo.accountNumber,
      },
    });

    const payout = await razorpay.payouts.create({
      account_number: payoutAccountNumber,
      fund_account_id: fundAccount.id,
      amount: Math.round(payoutAmount * 100),
      currency: "INR",
      mode: "IMPS",
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: `roomhy_${ownerId}_${tenantId}_${Date.now()}`,
      narration: "RoomHy Rent Payout",
      notes: {
        ownerLoginId: ownerId,
        tenantLoginId: tenantId,
        propertyName: propertyName || "",
      },
    });

    const payoutRef = payout.id || payout.reference_id || "";
    await Rent.updateMany(
      { _id: { $in: rentDocs.map((r) => r._id) } },
      {
        $set: {
          ownerPayoutStatus: "paid",
          ownerPayoutAt: new Date(),
          ownerPayoutRef: payoutRef,
          ownerPayoutAmount: payoutAmount,
          ownerPayoutNote: "Transfer successful",
        },
      },
    );

    await sendOwnerPayoutSuccessEmail({
      toEmail: ownerInfo.ownerEmail,
      ownerName: ownerInfo.ownerName,
      amount: payoutAmount,
      reference: payoutRef,
      propertyName,
      tenantLoginId: tenantId,
    });

    return res.json({
      success: true,
      message: "Owner payout transferred successfully",
      payout: {
        id: payout.id,
        status: payout.status,
        amount: payoutAmount,
        reference: payoutRef,
      },
    });
  } catch (err) {
    console.error(
      "processOwnerPayout error:",
      err && err.message ? err.message : err,
    );
    return res
      .status(500)
      .json({
        success: false,
        message: err.message || "Failed to process owner payout",
      });
  }
};

exports.getPlatformPayoutSummary = async (req, res) => {
  try {
    const rents = await Rent.find({}).select(
      "ownerPayoutStatus ownerPayoutAmount commissionAmount serviceFeeAmount paidAmount totalDue rentAmount",
    );
    const summary = {
      totalPayoutTransferred: 0,
      totalPendingPayout: 0,
      totalRents: 0,
      paidRows: 0,
      pendingRows: 0,
    };

    rents.forEach((rent) => {
      summary.totalRents += Number(rent.rentAmount || rent.totalDue || 0);
      const payoutAmount = Number(rent.ownerPayoutAmount || 0);
      if (rent.ownerPayoutStatus === "paid") {
        summary.totalPayoutTransferred += payoutAmount;
        summary.paidRows += 1;
      } else if (
        rent.ownerPayoutStatus === "pending" ||
        rent.ownerPayoutStatus === "processing" ||
        rent.ownerPayoutStatus === "failed" ||
        !rent.ownerPayoutStatus
      ) {
        summary.totalPendingPayout += payoutAmount;
        summary.pendingRows += 1;
      }
    });

    return res.json({ success: true, summary });
  } catch (err) {
    console.error("getPlatformPayoutSummary error:", err);
    return res
      .status(500)
      .json({
        success: false,
        message: err.message || "Failed to fetch payout summary",
      });
  }
};

exports.testTenantEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email required" });

    const mailer = require("../utils/mailer");
    const subject = "RoomHy System Check - Multiple Channel Verification";
    const text =
      "Testing email delivery priorities: 1. Mailjet API, 2. Gmail SMTP.";
    const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #6366f1; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin: 0;">RoomHy System Check</h2>
                </div>
                <div style="padding: 25px; color: #374151; line-height: 1.6;">
                    <p>Hello,</p>
                    <p>This is a <strong>multi-channel delivery test</strong> triggered from the RoomHy server.</p>
                    <p>Current configuration status:</p>
                    <ul style="padding-left: 20px;">
                        <li><strong>Primary:</strong> Mailjet HTTP API</li>
                        <li><strong>Fallback:</strong> Gmail SMTP Relay</li>
                    </ul>
                    <p>If you received this, the delivery system is functional.</p>
                </div>
            </div>
        `;

    const sent = await mailer.sendMail(email, subject, text, html);
    return res.json({
      success: sent,
      message: sent
        ? "Email sent successfully"
        : "Email delivery failed (check mail_log.txt)",
    });
  } catch (error) {
    console.error("testTenantEmail controller error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ==========================================
// Phase 4: Standalone Razorpay Onboarding Endpoint
// ==========================================

exports.verifyRazorpayOnboardingPayment = async (req, res) => {
  try {
    const { token, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!token) return res.status(400).json({ success: false, error: 'Token is required' });
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Incomplete Razorpay payload' });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ success: false, error: 'JWT_SECRET missing' });

    let decoded;
    try {
      // PROBE GUARD: Validates payload purely by crypto signature before touching the database
      decoded = require('jsonwebtoken').verify(token, jwtSecret);
    } catch (err) {
      // Generic response on token fail: impossible to probe if the user or rentId exists
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    if (decoded.purpose !== 'onboarding_payment' || !decoded.loginId) {
      return res.status(400).json({ success: false, error: 'Unauthorized token' });
    }
    let fallbackRentId = decoded.rentRecordId;
    if (!fallbackRentId) {
      const tenant = await require('../models/Tenant').findOne({ loginId: decoded.loginId });
      if (tenant) {
        const pendingRent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        if (pendingRent) fallbackRentId = pendingRent._id;
      }
    }
    if (!fallbackRentId) return res.status(400).json({ success: false, error: 'Unauthorized token (Rent missing)' });
    decoded.rentRecordId = fallbackRentId;

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({ success: false, error: 'Razorpay secret is not configured' });
    }

    // Verify razorpay signature natively
    const crypto = require("crypto");
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Invalid Razorpay payment signature' });
    }

    // Now execute DB updates knowing BOTH the JWT token and the Razorpay payload are verified explicitly
    const rent = await Rent.findById(decoded.rentRecordId);
    if (!rent) return res.status(404).json({ success: false, error: 'Invalid record references' });

    if (rent.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'Payment already completed' });
    }

    const updatedRent = await Rent.findOneAndUpdate(
      { _id: decoded.rentRecordId, paymentStatus: { $ne: 'paid' } },
      {
        $set: {
          paidAmount: rent.totalDue || 0,
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          paymentMethod: "razorpay",
          paymentDate: new Date(),
          paymentStatus: 'paid'
        }
      },
      { new: true }
    );

    if (!updatedRent) {
      return res.status(400).json({ success: false, message: 'Payment handled by another request.' });
    }

    // Trigger Finalization exactly like cash OTP
    const tenantController = require('./tenantController');
    await tenantController.finalizeOnboardingPayment(decoded.loginId, decoded.rentRecordId);
    console.log(`[ONBOARDING PAYMENT] Razorpay verification successful for ${decoded.loginId}`);

    return res.json({ success: true, message: 'Razorpay verification successful. Credentials generated.' });

  } catch (error) {
    console.error('verifyRazorpayOnboardingPayment error:', error);
    return res.status(500).json({ success: false, error: 'Failed to verify Razorpay onboarding payment' });
  }
};


// ==========================================
// Phase 5: Cash OTP Endpoints
// ==========================================

exports.generateCashOtp = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token is required' });

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ success: false, error: 'JWT_SECRET missing' });

    let decoded;
    try {
      decoded = require('jsonwebtoken').verify(token, jwtSecret);
    } catch (err) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    if (decoded.purpose !== 'onboarding_payment' || !decoded.loginId) {
      return res.status(400).json({ success: false, error: 'Token is not authorized for onboarding cash payment' });
    }

    let fallbackRentId = decoded.rentRecordId;
    if (!fallbackRentId) {
      const tenant = await require('../models/Tenant').findOne({ loginId: decoded.loginId });
      if (tenant) {
        const pendingRent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        if (pendingRent) fallbackRentId = pendingRent._id;
      }
    }
    decoded.rentRecordId = fallbackRentId;
    const rent = await Rent.findById(fallbackRentId).populate('tenantId');
    if (!rent) return res.status(404).json({ success: false, error: 'Rent record not found' });
    if (rent.paymentStatus === 'paid') return res.status(400).json({ success: false, error: 'Payment already completed' });

    // Rate Limit: 1 OTP per 60 seconds (MongoDB Cooldown Timer)
    if (rent.cashOtpLastSentAt && (Date.now() - new Date(rent.cashOtpLastSentAt).getTime()) < 60000) {
      const waitTime = Math.ceil((60000 - (Date.now() - new Date(rent.cashOtpLastSentAt).getTime())) / 1000);
      return res.status(429).json({ success: false, error: `Please wait ${waitTime} seconds before requesting a new OTP.` });
    }

    // Resolve owner email for dispatch
    const Owner = require('../models/Owner');
    const ownerDoc = await Owner.findOne({ loginId: String(rent.ownerLoginId || '').trim().toUpperCase() });
    const ownerEmail = (ownerDoc && (ownerDoc.email || ownerDoc.profile?.email)) || '';
    if (!ownerEmail) return res.status(400).json({ success: false, error: 'Property owner does not have a registered email to receive OTP.' });

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Invalidate old, set new
    rent.cashOtpCode = otpCode;
    rent.cashOtpExpiresAt = new Date(Date.now() + 10 * 60000); // 10 minutes
    rent.cashOtpAttempts = 0;
    rent.cashOtpLastSentAt = new Date();
    await rent.save();

    // Send Mail
    const mailer = require('../utils/mailer');
    await mailer.sendCashOtpToOwner(ownerEmail, rent.tenantName, rent.roomNumber || 'Assigned Room', otpCode, rent.propertyName || 'Property');

    console.log(`[CASH OTP] Sent to owner ${ownerEmail} for tenant ${rent.tenantLoginId || rent.tenantName}`);

    return res.json({ success: true, message: 'OTP has been dispatched securely to the property owner.' });

  } catch (error) {
    console.error('generateCashOtp error:', error);
    return res.status(500).json({ success: false, error: 'Failed to generate cash OTP' });
  }
};

exports.verifyAuthCashOtp = async (req, res) => {
  try {
    const { token, otp } = req.body;
    if (!token || !otp) return res.status(400).json({ success: false, error: 'Token and OTP are required' });

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ success: false, error: 'JWT_SECRET missing' });

    let decoded;
    try {
      decoded = require('jsonwebtoken').verify(token, jwtSecret);
    } catch (err) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    if (decoded.purpose !== 'onboarding_payment' || !decoded.loginId) {
      return res.status(400).json({ success: false, error: 'Unauthorized token' });
    }
    let fallbackRentId = decoded.rentRecordId;
    if (!fallbackRentId) {
      const tenant = await require('../models/Tenant').findOne({ loginId: decoded.loginId });
      if (tenant) {
        const pendingRent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 });
        if (pendingRent) fallbackRentId = pendingRent._id;
      }
    }
    decoded.rentRecordId = fallbackRentId;
    const rent = await Rent.findById(fallbackRentId);
    if (!rent) return res.status(404).json({ success: false, error: 'Rent record not found' });

    if (!rent.cashOtpCode) {
      return res.status(400).json({ success: false, error: 'No OTP generated. Please generate a new OTP.' });
    }

    if (new Date() > rent.cashOtpExpiresAt) {
      return res.status(400).json({ success: false, error: 'OTP has expired. Please request a new one.' });
    }

    if (String(rent.cashOtpCode) !== String(otp).trim()) {
      rent.cashOtpAttempts = (rent.cashOtpAttempts || 0) + 1;

      if (rent.cashOtpAttempts >= 5) {
        // Lockout
        rent.cashOtpCode = undefined;
        rent.cashOtpExpiresAt = undefined;
        await rent.save();
        return res.status(403).json({ success: false, error: 'Too many failed attempts. OTP locked out. Ask owner to physically verify and regenerate.' });
      }

      await rent.save();
      const remaining = 5 - rent.cashOtpAttempts;
      return res.status(400).json({ success: false, error: `Invalid OTP. ${remaining} attempt(s) remaining.` });
    }

    // Success Match
    const updatedRent = await Rent.findOneAndUpdate(
      { _id: decoded.rentRecordId, paymentStatus: { $ne: 'paid' } },
      {
        $set: {
          paymentMethod: 'cash',
          paymentDate: new Date(),
          paymentStatus: 'paid',
          paidAmount: rent.totalDue || 0
        },
        $unset: {
          cashOtpCode: 1,
          cashOtpExpiresAt: 1
        }
      },
      { new: true }
    );

    if (!updatedRent) {
      return res.status(400).json({ success: false, error: 'Payment already processed by another request.' });
    }

    // Trigger Phase 5 Finalization Hook (Shared logic from Phase 4)
    const tenantController = require('./tenantController');
    await tenantController.finalizeOnboardingPayment(decoded.loginId, decoded.rentRecordId);

    console.log(`[CASH OTP] Validation successful for ${decoded.loginId}`);
    return res.json({ success: true, message: 'Cash verification successful. Credentials generated.' });

  } catch (error) {
    console.error('verifyAuthCashOtp error:', error);
    return res.status(500).json({ success: false, error: 'Server error during OTP verification' });
  }
};
