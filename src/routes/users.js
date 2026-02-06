const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// GET /users - Get all users (admin only)
router.get('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { role, search, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT id, phone, name, role, verified, photo_url, created_at FROM users WHERE 1=1';
    const params = [];

    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }

    if (search) {
      query += ' AND (name LIKE ? OR phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const users = db.prepare(query).all(...params);

    res.json({ users });
  } catch (error) {
    console.error('Get Users Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /users/:id - Get user by ID
router.get('/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;

    // Users can only view their own profile unless admin
    if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = db.prepare(
      'SELECT id, phone, name, role, verified, photo_url, created_at FROM users WHERE id = ?'
    ).get(id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get player info if exists
    const player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(id);

    // Get team info
    let team = null;
    if (player) {
      team = db.prepare(
        `SELECT t.* FROM teams t
         JOIN team_roster tr ON t.id = tr.team_id
         WHERE tr.player_id = ?
         ORDER BY tr.season DESC LIMIT 1`
      ).get(player.id);
    }

    res.json({ user, player, team });
  } catch (error) {
    console.error('Get User Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /users/:id - Update user
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { name, photo_url, role } = req.body;

    // Users can only update their own profile unless admin
    if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build update query
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }

    if (photo_url !== undefined) {
      updates.push('photo_url = ?');
      params.push(photo_url);
    }

    // Only admin can change roles
    if (role !== undefined && req.user.role === 'admin') {
      if (!['player', 'captain', 'owner', 'admin', 'spectator'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.push('role = ?');
      params.push(role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedUser = db.prepare(
      'SELECT id, phone, name, role, verified, photo_url, created_at, updated_at FROM users WHERE id = ?'
    ).get(id);

    res.json({ user: updatedUser });
  } catch (error) {
    console.error('Update User Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /users - Create user (admin only)
router.post('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { phone, name, role = 'player' } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const cleanPhone = phone.replace(/[^\d+]/g, '');

    // Check if user already exists
    const existingUser = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this phone already exists' });
    }

    const result = db.prepare(
      'INSERT INTO users (phone, name, role, verified) VALUES (?, ?, ?, 1)'
    ).run(cleanPhone, name, role);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ user });
  } catch (error) {
    console.error('Create User Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
