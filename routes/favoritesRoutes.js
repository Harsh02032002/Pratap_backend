const express = require('express');
const router = express.Router();

// Placeholder routes for favorites
router.get('/', (req, res) => {
    res.json({ message: 'Get favorites' });
});

router.post('/', (req, res) => {
    res.json({ message: 'Add favorite' });
});

router.delete('/:id', (req, res) => {
    res.json({ message: 'Remove favorite' });
});

module.exports = router;
