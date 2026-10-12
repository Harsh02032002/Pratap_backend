const express = require('express');
const router = express.Router();
const gateController = require('../controllers/gateController');
const { protect, authorize } = require('../middleware/authMiddleware');

// These four routes carried NO middleware at all, so anyone on the internet
// could list an owner's gates and flip a physical lock between Locked and
// Unlocked with a single unauthenticated PUT. The only caller anywhere in the
// frontend is the owner panel's gate-management page, which already sends a
// token, so requiring one breaks nothing.
//
// Per-gate ownership (owner A must not toggle owner B's gate) is NOT enforced
// yet — that needs the object-scope guard. This reduces the exposure from
// "the whole internet" to "any authenticated owner or admin".
router.use(protect, authorize('owner', 'superadmin'));

// Get all gates for an owner
router.get('/owner/:ownerLoginId', gateController.getGatesByOwner);

// Create a new gate
router.post('/', gateController.createGate);

// Toggle gate status
router.put('/:id/toggle', gateController.toggleGateStatus);

// Delete a gate
router.delete('/:id', gateController.deleteGate);

module.exports = router;
