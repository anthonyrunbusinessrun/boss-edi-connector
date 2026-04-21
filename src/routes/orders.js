const express = require('express');
const router = express.Router();
const db = require('../db');

// GET all orders
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT o.*, 
        COUNT(ol.id) as line_count
      FROM orders o
      LEFT JOIN order_lines ol ON o.do_number = ol.do_number
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single order with line items
router.get('/:doNumber', async (req, res) => {
  try {
    const order = await db.query(`SELECT * FROM orders WHERE do_number = $1`, [req.params.doNumber]);
    if (!order.rows.length) return res.status(404).json({ success: false, error: 'Order not found' });

    const lines = await db.query(`SELECT * FROM order_lines WHERE do_number = $1 ORDER BY line_number`, [req.params.doNumber]);
    const shipments = await db.query(`SELECT * FROM shipments WHERE do_number = $1`, [req.params.doNumber]);

    res.json({
      success: true,
      order: order.rows[0],
      lines: lines.rows,
      shipments: shipments.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET EDI log
router.get('/log/all', async (req, res) => {
  try {
    const result = await db.query(`SELECT id, direction, message_type, do_number, status, created_at FROM edi_log ORDER BY created_at DESC LIMIT 100`);
    res.json({ success: true, log: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
