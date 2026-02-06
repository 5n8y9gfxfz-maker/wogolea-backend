const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');

// GET /sponsors - Get all active sponsors
router.get('/', optionalAuth, (req, res) => {
  try {
    const { tier, active = 'true' } = req.query;

    let query = 'SELECT * FROM sponsors WHERE 1=1';
    const params = [];

    if (active === 'true') {
      query += ' AND active = 1';
    } else if (active === 'false') {
      query += ' AND active = 0';
    }

    if (tier) {
      query += ' AND tier = ?';
      params.push(tier);
    }

    query += " ORDER BY CASE tier WHEN 'platinum' THEN 1 WHEN 'gold' THEN 2 WHEN 'silver' THEN 3 WHEN 'bronze' THEN 4 END, name";

    const sponsors = db.prepare(query).all(...params);

    res.json({ sponsors });
  } catch (error) {
    console.error('Get Sponsors Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sponsors/:id - Get sponsor by ID
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const { id } = req.params;

    const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id);

    if (!sponsor) {
      return res.status(404).json({ error: 'Sponsor not found' });
    }

    res.json({ sponsor });
  } catch (error) {
    console.error('Get Sponsor Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /sponsors - Create new sponsor (admin only)
router.post('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { name, logo_url, tagline, tier = 'silver', website_url } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Sponsor name is required' });
    }

    if (!['platinum', 'gold', 'silver', 'bronze'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier' });
    }

    const result = db.prepare(`
      INSERT INTO sponsors (name, logo_url, tagline, tier, website_url)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, logo_url || null, tagline || null, tier, website_url || null);

    const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ sponsor });
  } catch (error) {
    console.error('Create Sponsor Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /sponsors/:id - Update sponsor (admin only)
router.put('/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { name, logo_url, tagline, tier, website_url, active } = req.body;

    const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id);
    if (!sponsor) {
      return res.status(404).json({ error: 'Sponsor not found' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }

    if (logo_url !== undefined) {
      updates.push('logo_url = ?');
      params.push(logo_url);
    }

    if (tagline !== undefined) {
      updates.push('tagline = ?');
      params.push(tagline);
    }

    if (tier !== undefined) {
      if (!['platinum', 'gold', 'silver', 'bronze'].includes(tier)) {
        return res.status(400).json({ error: 'Invalid tier' });
      }
      updates.push('tier = ?');
      params.push(tier);
    }

    if (website_url !== undefined) {
      updates.push('website_url = ?');
      params.push(website_url);
    }

    if (active !== undefined) {
      updates.push('active = ?');
      params.push(active ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    params.push(id);

    db.prepare(`UPDATE sponsors SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedSponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id);

    res.json({ sponsor: updatedSponsor });
  } catch (error) {
    console.error('Update Sponsor Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /sponsors/:id - Delete sponsor (admin only)
router.delete('/:id', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { id } = req.params;

    const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id);
    if (!sponsor) {
      return res.status(404).json({ error: 'Sponsor not found' });
    }

    db.prepare('DELETE FROM sponsors WHERE id = ?').run(id);

    res.json({ message: 'Sponsor deleted' });
  } catch (error) {
    console.error('Delete Sponsor Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
