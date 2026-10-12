const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const { protect } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');

// ─── TICKET ROUTES ─────────────────────────────────────────────────────────

// Every route in this file was reachable with no token: anyone could read any
// owner's or tenant's support tickets, resolve them, or bulk-delete them.
// '/all' had optionalProtect, which authenticates only IF a header is present
// — so an anonymous caller fell through to applyEmployeeScope with no
// req.user, where isEmployee is false and therefore no scope filter is
// applied, returning every ticket on the platform.
//
// All four frontend callers (owner panel, tenant support page, superadmin
// tickets page) go through fetchJson and already send a token.
router.use(protect);

// Create new support ticket (Owner or Tenant)
router.post('/create', ticketController.createTicket);

// Get tickets raised by logged in user / owner
router.get('/my-tickets', ticketController.getMyTickets);

// Search single ticket by Ref ID (e.g. TKT-849201)
router.get('/search', ticketController.getTicketByRefId);
router.get('/search/:ticketId', ticketController.getTicketByRefId);

// Get all tickets for SuperAdmin / Employee (supports area, status, search filtering, scoped for employee)
router.get('/all', applyEmployeeScope, ticketController.getAllTickets);

// Resolve or complete ticket (Employee / Admin)
router.post('/resolve', ticketController.resolveTicket);
router.post('/bulk-resolve', ticketController.bulkResolveTickets);
router.post('/bulk-delete', ticketController.bulkDeleteTickets);

// Auto-assign unassigned tickets to employees (city match)
router.post('/auto-assign', ticketController.autoAssignTickets);

// Bulk delete only closed/resolved tickets
router.post('/bulk-delete-closed', ticketController.bulkDeleteClosedTickets);

module.exports = router;


