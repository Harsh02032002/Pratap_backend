const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');

// ─── TICKET ROUTES ─────────────────────────────────────────────────────────

// Create new support ticket (Owner or Tenant)
router.post('/create', ticketController.createTicket);

// Get tickets raised by logged in user / owner
router.get('/my-tickets', ticketController.getMyTickets);

// Search single ticket by Ref ID (e.g. TKT-849201)
router.get('/search', ticketController.getTicketByRefId);
router.get('/search/:ticketId', ticketController.getTicketByRefId);

// Get all tickets for SuperAdmin / Employee (supports area, status, search filtering)
router.get('/all', ticketController.getAllTickets);

// Resolve or complete ticket (Employee / Admin)
router.post('/resolve', ticketController.resolveTicket);

module.exports = router;
