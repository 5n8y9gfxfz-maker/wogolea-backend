const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');

// GET /players - Get all players
router.get('/', optionalAuth, (req, res) => {
  try {
    const { available, team_id, search, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT p.*, u.name, u.phone, u.photo_url as user_photo,
             t.id as team_id, t.name as team_name
      FROM players p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN team_roster tr ON p.id = tr.player_id AND tr.season = (SELECT MAX(season) FROM team_roster)
      LEFT JOIN teams t ON tr.team_id = t.id
      WHERE 1=1
    `;
    const params = [];

    if (available === 'true') {
      query += ' AND p.is_available = 1';
    } else if (available === 'false') {
      query += ' AND p.is_available = 0';
    }

    if (team_id) {
      query += ' AND tr.team_id = ?';
      params.push(team_id);
    }

    if (search) {
      query += ' AND (u.name LIKE ? OR u.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY p.handicap ASC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const players = db.prepare(query).all(...params);

    res.json({ players });
  } catch (error) {
    console.error('Get Players Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /players/available - Get available players for auction/draft
router.get('/available', optionalAuth, (req, res) => {
  try {
    const { season = 1 } = req.query;

    const players = db.prepare(`
      SELECT p.*, u.name, u.phone, u.photo_url as user_photo
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.is_available = 1
        AND p.id NOT IN (
          SELECT player_id FROM team_roster WHERE season = ?
        )
      ORDER BY p.base_price DESC, p.handicap ASC
    `).all(season);

    res.json({ players });
  } catch (error) {
    console.error('Get Available Players Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /players/:id - Get player by ID
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const { id } = req.params;

    const player = db.prepare(`
      SELECT p.*, u.name, u.phone, u.photo_url as user_photo, u.role
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `).get(id);

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Get current team
    const teamRoster = db.prepare(`
      SELECT t.*, tr.acquisition_type, tr.price, tr.season
      FROM team_roster tr
      JOIN teams t ON tr.team_id = t.id
      WHERE tr.player_id = ?
      ORDER BY tr.season DESC
      LIMIT 1
    `).get(id);

    // Get match history
    const matchHistory = db.prepare(`
      SELECT m.*, t1.name as team1_name, t2.name as team2_name,
             ms.hole_number, ms.result
      FROM match_scores ms
      JOIN matches m ON ms.match_id = m.id
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      WHERE ms.player_id = ?
      ORDER BY m.match_date DESC
      LIMIT 20
    `).all(id);

    // Get auction history
    const auctionHistory = db.prepare(`
      SELECT al.*, t.name as team_name
      FROM auction_log al
      JOIN teams t ON al.team_id = t.id
      WHERE al.player_id = ?
      ORDER BY al.season DESC, al.created_at DESC
    `).all(id);

    res.json({
      player,
      team: teamRoster,
      matchHistory,
      auctionHistory
    });
  } catch (error) {
    console.error('Get Player Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /players - Create new player profile
router.post('/', authenticateToken, (req, res) => {
  try {
    const { user_id, handicap, bio, photo_url, video_url, achievements, base_price } = req.body;

    // Admin can create for any user, others can only create for themselves
    const targetUserId = req.user.role === 'admin' && user_id ? user_id : req.user.id;

    // Check if player profile already exists
    const existing = db.prepare('SELECT * FROM players WHERE user_id = ?').get(targetUserId);
    if (existing) {
      return res.status(400).json({ error: 'Player profile already exists for this user' });
    }

    // Check if user exists
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = db.prepare(`
      INSERT INTO players (user_id, handicap, bio, photo_url, video_url, achievements, base_price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      targetUserId,
      handicap || null,
      bio || null,
      photo_url || null,
      video_url || null,
      achievements || null,
      base_price || 100000
    );

    const player = db.prepare(`
      SELECT p.*, u.name, u.phone
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ player });
  } catch (error) {
    console.error('Create Player Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /players/:id - Update player profile
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { handicap, bio, photo_url, video_url, achievements, base_price, is_available } = req.body;

    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Check permission
    if (req.user.role !== 'admin' && player.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates = [];
    const params = [];

    if (handicap !== undefined) {
      updates.push('handicap = ?');
      params.push(handicap);
    }

    if (bio !== undefined) {
      updates.push('bio = ?');
      params.push(bio);
    }

    if (photo_url !== undefined) {
      updates.push('photo_url = ?');
      params.push(photo_url);
    }

    if (video_url !== undefined) {
      updates.push('video_url = ?');
      params.push(video_url);
    }

    if (achievements !== undefined) {
      updates.push('achievements = ?');
      params.push(achievements);
    }

    // Only admin can change base price and availability
    if (req.user.role === 'admin') {
      if (base_price !== undefined) {
        updates.push('base_price = ?');
        params.push(base_price);
      }

      if (is_available !== undefined) {
        updates.push('is_available = ?');
        params.push(is_available ? 1 : 0);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(`UPDATE players SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedPlayer = db.prepare(`
      SELECT p.*, u.name, u.phone
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `).get(id);

    res.json({ player: updatedPlayer });
  } catch (error) {
    console.error('Update Player Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
