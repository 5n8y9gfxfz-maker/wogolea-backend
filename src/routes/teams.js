const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');

// GET /teams - Get all teams
router.get('/', optionalAuth, (req, res) => {
  try {
    const { season } = req.query;
    const currentSeason = season || 1;

    const teams = db.prepare(`
      SELECT t.*,
             u_owner.name as owner_name,
             u_captain.name as captain_name,
             (SELECT COUNT(*) FROM team_roster tr WHERE tr.team_id = t.id AND tr.season = ?) as player_count
      FROM teams t
      LEFT JOIN users u_owner ON t.owner_id = u_owner.id
      LEFT JOIN users u_captain ON t.captain_id = u_captain.id
      ORDER BY t.name
    `).all(currentSeason);

    res.json({ teams });
  } catch (error) {
    console.error('Get Teams Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /teams/:id - Get team by ID with roster
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { season } = req.query;
    const currentSeason = season || 1;

    const team = db.prepare(`
      SELECT t.*,
             u_owner.name as owner_name, u_owner.phone as owner_phone,
             u_captain.name as captain_name, u_captain.phone as captain_phone
      FROM teams t
      LEFT JOIN users u_owner ON t.owner_id = u_owner.id
      LEFT JOIN users u_captain ON t.captain_id = u_captain.id
      WHERE t.id = ?
    `).get(id);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Get roster with player details
    const roster = db.prepare(`
      SELECT p.*, u.name, u.phone, tr.acquisition_type, tr.price, tr.season, tr.joined_at
      FROM team_roster tr
      JOIN players p ON tr.player_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE tr.team_id = ? AND tr.season = ?
      ORDER BY tr.price DESC
    `).all(id, currentSeason);

    // Get team stats
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN winner_id = ? THEN 1 END) as wins,
        COUNT(CASE WHEN winner_id IS NOT NULL AND winner_id != ? THEN 1 END) as losses,
        COUNT(CASE WHEN winner_id IS NULL AND status = 'completed' THEN 1 END) as draws,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as matches_played
      FROM matches
      WHERE (team1_id = ? OR team2_id = ?) AND season = ?
    `).get(id, id, id, id, currentSeason);

    res.json({ team, roster, stats });
  } catch (error) {
    console.error('Get Team Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /teams/:id/roster - Get team roster only
router.get('/:id/roster', optionalAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { season } = req.query;
    const currentSeason = season || 1;

    const roster = db.prepare(`
      SELECT p.*, u.name, u.phone, u.photo_url as user_photo,
             tr.acquisition_type, tr.price, tr.season, tr.joined_at
      FROM team_roster tr
      JOIN players p ON tr.player_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE tr.team_id = ? AND tr.season = ?
      ORDER BY tr.price DESC
    `).all(id, currentSeason);

    res.json({ roster });
  } catch (error) {
    console.error('Get Roster Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /teams - Create new team (admin only)
router.post('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { name, owner_id, captain_id, logo_url, budget_remaining, primary_color, secondary_color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Team name is required' });
    }

    // Check for duplicate name
    const existing = db.prepare('SELECT id FROM teams WHERE name = ?').get(name);
    if (existing) {
      return res.status(400).json({ error: 'Team name already exists' });
    }

    const result = db.prepare(`
      INSERT INTO teams (name, owner_id, captain_id, logo_url, budget_remaining, primary_color, secondary_color)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      owner_id || null,
      captain_id || null,
      logo_url || null,
      budget_remaining || 10000000,
      primary_color || '#2D5A27',
      secondary_color || '#C9A227'
    );

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ team });
  } catch (error) {
    console.error('Create Team Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /teams/:id - Update team
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { name, owner_id, captain_id, logo_url, budget_remaining, primary_color, secondary_color } = req.body;

    // Check permission (admin or team owner)
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (req.user.role !== 'admin' && team.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      // Check for duplicate name
      const existing = db.prepare('SELECT id FROM teams WHERE name = ? AND id != ?').get(name, id);
      if (existing) {
        return res.status(400).json({ error: 'Team name already exists' });
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (owner_id !== undefined && req.user.role === 'admin') {
      updates.push('owner_id = ?');
      params.push(owner_id);
    }

    if (captain_id !== undefined) {
      updates.push('captain_id = ?');
      params.push(captain_id);
    }

    if (logo_url !== undefined) {
      updates.push('logo_url = ?');
      params.push(logo_url);
    }

    if (budget_remaining !== undefined && req.user.role === 'admin') {
      updates.push('budget_remaining = ?');
      params.push(budget_remaining);
    }

    if (primary_color !== undefined) {
      updates.push('primary_color = ?');
      params.push(primary_color);
    }

    if (secondary_color !== undefined) {
      updates.push('secondary_color = ?');
      params.push(secondary_color);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);

    res.json({ team: updatedTeam });
  } catch (error) {
    console.error('Update Team Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /teams/:id/roster - Add player to team roster
router.post('/:id/roster', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { player_id, acquisition_type = 'auction', price = 0, season = 1 } = req.body;

    // Check permission
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (req.user.role !== 'admin' && team.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if player exists
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(player_id);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Check if player is already in a team this season
    const existingRoster = db.prepare(
      'SELECT * FROM team_roster WHERE player_id = ? AND season = ?'
    ).get(player_id, season);
    if (existingRoster) {
      return res.status(400).json({ error: 'Player is already on a team this season' });
    }

    // Add to roster
    db.prepare(`
      INSERT INTO team_roster (team_id, player_id, acquisition_type, price, season)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, player_id, acquisition_type, price, season);

    // Update team budget
    if (price > 0) {
      db.prepare('UPDATE teams SET budget_remaining = budget_remaining - ? WHERE id = ?').run(price, id);
    }

    // Mark player as unavailable
    db.prepare('UPDATE players SET is_available = 0 WHERE id = ?').run(player_id);

    res.status(201).json({ message: 'Player added to roster' });
  } catch (error) {
    console.error('Add Roster Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /teams/:id/roster/:playerId - Remove player from roster
router.delete('/:id/roster/:playerId', authenticateToken, (req, res) => {
  try {
    const { id, playerId } = req.params;
    const { season = 1 } = req.query;

    // Check permission
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (req.user.role !== 'admin' && team.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get roster entry for budget refund
    const rosterEntry = db.prepare(
      'SELECT * FROM team_roster WHERE team_id = ? AND player_id = ? AND season = ?'
    ).get(id, playerId, season);

    if (!rosterEntry) {
      return res.status(404).json({ error: 'Player not in roster' });
    }

    // Remove from roster
    db.prepare(
      'DELETE FROM team_roster WHERE team_id = ? AND player_id = ? AND season = ?'
    ).run(id, playerId, season);

    // Refund budget
    if (rosterEntry.price > 0) {
      db.prepare('UPDATE teams SET budget_remaining = budget_remaining + ? WHERE id = ?')
        .run(rosterEntry.price, id);
    }

    // Mark player as available
    db.prepare('UPDATE players SET is_available = 1 WHERE id = ?').run(playerId);

    res.json({ message: 'Player removed from roster' });
  } catch (error) {
    console.error('Remove Roster Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
