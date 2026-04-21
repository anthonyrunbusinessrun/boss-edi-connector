const express = require('express');
const router = express.Router();
const db = require('../db');
const { generate856 } = require('../parsers/generate856');

// GET all shipments
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM shipments ORDER BY created_at DESC`);
    res.json({ success: true, shipments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST dispatch a shipment — generates and sends 856
router.post('/dispatch', async (req, res) => {
  try {
    const {
      asnId, doNumber, trailerNumber, tractorNumber,
      plateNumber, plateState, shipDate, eta,
      originFacility, destinationFacility, items
    } = req.body;

    // Validate required fields
    const required = ['asnId', 'doNumber', 'trailerNumber', 'plateNumber', 'plateState', 'shipDate', 'eta', 'destinationFacility', 'items'];
    const missing = required.filter(f => !req.body[f]);
    if (missing.length) {
      return res.status(400).json({ success: false, error: `Missing fields: ${missing.join(', ')}` });
    }

    // Generate and queue 856
    const outFile = await generate856(req.body);

    res.json({
      success: true,
      message: `856 ASN generated for DO ${doNumber}`,
      asnId,
      file: outFile
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
