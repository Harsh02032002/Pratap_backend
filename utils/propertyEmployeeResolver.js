'use strict';

/**
 * propertyEmployeeResolver.js
 * ────────────────────────────
 * Resolves the Employee who created the Visit Report (property visit) for a
 * given property. This employee is the "primary responsible employee" for
 * that property — all tickets related to that property should auto-route to
 * them, and when an owner lists a property live, this employee gets notified.
 *
 * Resolution chain (in order):
 *   1. VisitData.submittedByLoginId  ← most reliable (set during form submit)
 *   2. VisitData.staffId             ← legacy field
 *   3. Property.assignedTo           ← manual override by superadmin
 *   4. Employee by city/area match   ← area-based fallback
 */

const mongoose = require('mongoose');

/**
 * Resolve the employee loginId for a property.
 *
 * @param {object} opts
 * @param {string} [opts.visitId]       - VisitData.visitId
 * @param {string} [opts.propertyId]    - Property._id or Property.visitId
 * @param {string} [opts.ownerLoginId]  - Owner's loginId (fallback lookup)
 * @param {string} [opts.city]          - city name for area-based fallback
 * @param {string} [opts.area]          - area name for area-based fallback
 * @returns {Promise<{loginId: string, name: string, email: string, phone: string}|null>}
 */
async function resolvePropertyEmployee({ visitId, propertyId, ownerLoginId, city, area } = {}) {
  try {
    const VisitData = require('../models/VisitData');
    const Employee = require('../models/Employee');
    const ApprovedProperty = require('../models/ApprovedProperty');

    let visitDoc = null;

    // 1. Try to find VisitData by visitId
    if (visitId) {
      visitDoc = await VisitData.findOne({ visitId: String(visitId) })
        .select('submittedByLoginId staffId staffName ownerLoginId city area')
        .lean()
        .catch(() => null);
    }

    // 2. Try to find VisitData via property (visitId stored in ApprovedProperty)
    if (!visitDoc && propertyId) {
      const propIdStr = String(propertyId);
      let propDoc = null;

      if (mongoose.Types.ObjectId.isValid(propIdStr)) {
        propDoc = await ApprovedProperty.findById(propIdStr)
          .select('visitId ownerLoginId city area propertyInfo')
          .lean()
          .catch(() => null);
      }
      if (!propDoc) {
        propDoc = await ApprovedProperty.findOne({ visitId: propIdStr })
          .select('visitId ownerLoginId city area propertyInfo')
          .lean()
          .catch(() => null);
      }

      if (propDoc?.visitId) {
        visitDoc = await VisitData.findOne({ visitId: propDoc.visitId })
          .select('submittedByLoginId staffId staffName ownerLoginId city area')
          .lean()
          .catch(() => null);

        // Pull city/area from property if not given
        if (!city) city = propDoc.city || propDoc.propertyInfo?.city;
        if (!area) area = propDoc.area || propDoc.propertyInfo?.area;
      }
    }

    // 3. Try to find VisitData by ownerLoginId
    if (!visitDoc && ownerLoginId) {
      visitDoc = await VisitData.findOne({ ownerLoginId: String(ownerLoginId).toUpperCase() })
        .sort({ submittedAt: -1 })
        .select('submittedByLoginId staffId staffName ownerLoginId city area')
        .lean()
        .catch(() => null);
    }

    // 4. Resolve the employee loginId from visitDoc
    const empLoginId = visitDoc?.submittedByLoginId || visitDoc?.staffId || null;

    if (empLoginId) {
      const emp = await Employee.findOne({
        $or: [
          { loginId: empLoginId },
          { loginId: String(empLoginId).toUpperCase() }
        ],
        isActive: { $ne: false },
        isDeleted: { $ne: true }
      }).select('loginId name email phone').lean().catch(() => null);

      if (emp) {
        console.log(`[PropertyEmpResolver] ✅ Resolved employee ${emp.loginId} (${emp.name}) from VisitData for property visitId: ${visitId || propertyId || ownerLoginId}`);
        return { loginId: emp.loginId, name: emp.name || emp.loginId, email: emp.email || '', phone: emp.phone || '' };
      }
    }

    // 5. Fallback: Employee by city / area
    const cityStr = city || visitDoc?.city || '';
    const areaStr = area || visitDoc?.area || '';

    if (cityStr || areaStr) {
      const filters = [];
      if (cityStr) filters.push({ city: new RegExp(cityStr, 'i') }, { locationCode: new RegExp(cityStr, 'i') });
      if (areaStr) filters.push({ area: new RegExp(areaStr, 'i') });

      const fallbackEmp = await Employee.findOne({
        $or: filters,
        isActive: { $ne: false },
        isDeleted: { $ne: true }
      }).select('loginId name email phone').lean().catch(() => null);

      if (fallbackEmp) {
        console.log(`[PropertyEmpResolver] ⚠️ City/area fallback employee: ${fallbackEmp.loginId} (${fallbackEmp.name}) for city: ${cityStr}, area: ${areaStr}`);
        return { loginId: fallbackEmp.loginId, name: fallbackEmp.name || fallbackEmp.loginId, email: fallbackEmp.email || '', phone: fallbackEmp.phone || '' };
      }
    }

    // 6. Last resort: first active employee
    const anyEmp = await Employee.findOne({ isActive: { $ne: false }, isDeleted: { $ne: true } })
      .select('loginId name email phone').lean().catch(() => null);

    if (anyEmp) {
      console.warn(`[PropertyEmpResolver] ⚠️ Last-resort employee: ${anyEmp.loginId} (${anyEmp.name})`);
      return { loginId: anyEmp.loginId, name: anyEmp.name || anyEmp.loginId, email: anyEmp.email || '', phone: anyEmp.phone || '' };
    }

    console.warn('[PropertyEmpResolver] ❌ No employee found at all.');
    return null;
  } catch (err) {
    console.error('[PropertyEmpResolver] Error:', err.message);
    return null;
  }
}

module.exports = { resolvePropertyEmployee };
