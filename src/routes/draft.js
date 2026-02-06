const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');

// POST /draft/start - Start draft mode (admin only)
router.post('/start', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { season = 1, team_order } = req.body;

    if (!team_order || !Array.isArray(team_order) || team_order.length === 0) {
      // Get all teams in default order if not specified
      const teams = db.prepare('SELECT id FROM teams ORDER BY name').all();
      var orderToUse = teams.map(t => t.id);
    } else {
      var orderToUse = team_order;
    }

    db.prepare(`
      UPDATE auction_state SET
        mode = 'draft',
        current_player_id = NULL,
        current_bid = 0,
        current_bidder_team_id = NULL,
        timer_end = NULL,
        draft_round = 1,
        draft_pick = 1,
        draft_order = ?,
        season = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(JSON.stringify(orderToUse), season);

    const io = req.app.get('io');
    if (io) {
      io.emit('draft:started', {
        mode: 'draft',
        season,
        draftOrder: orderToUse,
        currentRound: 1,
        currentPick: 1
      });
    }

    res.json({
      message: 'Draft started',
      mode: 'draft',
      draftOrder: orderToUse
    });
  } catch (error) {
    console.error('Start Draft Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /draft/status - Get current draft status
router.get('/status', optionalAuth, (req, res) => {
  try {
    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (state.mode !== 'draft') {
      return res.json({ active: false, mode: state.mode });
    }

    const draftOrder = state.draft_order ? JSON.parse(state.draft_order) : [];

    // Get current team on the clock
    const totalTeams = draftOrder.length;
    const pickIndex = (state.draft_pick - 1) % totalTeams;

    // Snake draft: odd rounds go forward, even rounds go backward
    const isReverseRound = state.draft_round % 2 === 0;
    const teamIndex = isReverseRound ? (totalTeams - 1 - pickIndex) : pickIndex;
    const currentTeamId = draftOrder[teamIndex];

    const currentTeam = currentTeamId ?
      db.prepare('SELECT * FROM teams WHERE id = ?').get(currentTeamId) : null;

    // Get available players
    const availablePlayers = db.prepare(`
      SELECT p.*, u.name, u.photo_url as user_photo
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.is_available = 1
        AND p.id NOT IN (SELECT player_id FROM team_roster WHERE season = ?)
      ORDER BY p.handicap ASC
    `).all(state.season);

    // Get draft history for this season
    const draftHistory = db.prepare(`
      SELECT dl.*, p.handicap, u.name as player_name, t.name as team_name
      FROM draft_log dl
      JOIN players p ON dl.player_id = p.id
      JOIN users u ON p.user_id = u.id
      JOIN teams t ON dl.team_id = t.id
      WHERE dl.season = ?
      ORDER BY dl.round_number ASC, dl.pick_number ASC
    `).all(state.season);

    // Get all teams with their draft picks
    const teams = db.prepare(`
      SELECT t.*,
             (SELECT COUNT(*) FROM team_roster tr WHERE tr.team_id = t.id AND tr.season = ?) as player_count
      FROM teams t
      WHERE t.id IN (${draftOrder.map(() => '?').join(',')})
      ORDER BY t.name
    `).all(state.season, ...draftOrder);

    res.json({
      active: true,
      mode: 'draft',
      currentRound: state.draft_round,
      currentPick: state.draft_pick,
      currentTeam,
      draftOrder,
      availablePlayers,
      draftHistory,
      teams,
      timerEnd: state.timer_end
    });
  } catch (error) {
    console.error('Get Draft Status Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /draft/pick - Make a draft pick
router.post('/pick', authenticateToken, (req, res) => {
  try {
    const { player_id } = req.body;

    if (!player_id) {
      return res.status(400).json({ error: 'Player ID is required' });
    }

    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (state.mode !== 'draft') {
      return res.status(400).json({ error: 'Draft is not active' });
    }

    const draftOrder = state.draft_order ? JSON.parse(state.draft_order) : [];
    const totalTeams = draftOrder.length;
    const pickIndex = (state.draft_pick - 1) % totalTeams;
    const isReverseRound = state.draft_round % 2 === 0;
    const teamIndex = isReverseRound ? (totalTeams - 1 - pickIndex) : pickIndex;
    const currentTeamId = draftOrder[teamIndex];

    // Check permission
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(currentTeamId);
    const isAdmin = req.user.role === 'admin';
    const isTeamOwnerOrCaptain = team.owner_id === req.user.id || team.captain_id === req.user.id;

    if (!isAdmin && !isTeamOwnerOrCaptain) {
      return res.status(403).json({ error: 'It is not your turn to pick' });
    }

    // Check if player is available
    const player = db.prepare(`
      SELECT p.*, u.name, u.photo_url as user_photo
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_available = 1
    `).get(player_id);

    if (!player) {
      return res.status(404).json({ error: 'Player not found or not available' });
    }

    // Check if player is already drafted this season
    const alreadyDrafted = db.prepare(
      'SELECT * FROM team_roster WHERE player_id = ? AND season = ?'
    ).get(player_id, state.season);

    if (alreadyDrafted) {
      return res.status(400).json({ error: 'Player has already been drafted' });
    }

    // Add player to team roster
    db.prepare(`
      INSERT INTO team_roster (team_id, player_id, acquisition_type, price, season)
      VALUES (?, ?, 'draft', 0, ?)
    `).run(currentTeamId, player_id, state.season);

    // Mark player as unavailable
    db.prepare('UPDATE players SET is_available = 0 WHERE id = ?').run(player_id);

    // Log draft pick
    db.prepare(`
      INSERT INTO draft_log (round_number, pick_number, team_id, player_id, season)
      VALUES (?, ?, ?, ?, ?)
    `).run(state.draft_round, state.draft_pick, currentTeamId, player_id, state.season);

    // Move to next pick
    let nextPick = state.draft_pick + 1;
    let nextRound = state.draft_round;

    if ((nextPick - 1) % totalTeams === 0 && nextPick > state.draft_pick) {
      nextRound++;
      // Pick number continues incrementing
    }

    // Update draft state
    db.prepare(`
      UPDATE auction_state SET
        draft_round = ?,
        draft_pick = ?,
        timer_end = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(nextRound, nextPick);

    // Calculate next team
    const nextPickIndex = (nextPick - 1) % totalTeams;
    const isNextReverseRound = nextRound % 2 === 0;
    const nextTeamIndex = isNextReverseRound ? (totalTeams - 1 - nextPickIndex) : nextPickIndex;
    const nextTeamId = draftOrder[nextTeamIndex];
    const nextTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(nextTeamId);

    const io = req.app.get('io');
    if (io) {
      io.emit('draft:pick', {
        round: state.draft_round,
        pick: state.draft_pick,
        team,
        player,
        nextRound,
        nextPick,
        nextTeam
      });
    }

    res.json({
      message: 'Draft pick made',
      pick: {
        round: state.draft_round,
        pick: state.draft_pick,
        team,
        player
      },
      nextRound,
      nextPick,
      nextTeam
    });
  } catch (error) {
    console.error('Draft Pick Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /draft/set-timer - Set timer for current pick (admin only)
router.post('/set-timer', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { seconds = 120 } = req.body;

    const timerEnd = new Date(Date.now() + seconds * 1000).toISOString();

    db.prepare(`
      UPDATE auction_state SET timer_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(timerEnd);

    const io = req.app.get('io');
    if (io) {
      io.emit('draft:timer', { timerEnd, seconds });
    }

    res.json({ message: 'Timer set', timerEnd, seconds });
  } catch (error) {
    console.error('Set Timer Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /draft/end - End draft (admin only)
router.post('/end', authenticateToken, requireAdmin, (req, res) => {
  try {
    db.prepare(`
      UPDATE auction_state SET
        mode = 'idle',
        current_player_id = NULL,
        draft_round = 1,
        draft_pick = 1,
        timer_end = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();

    const io = req.app.get('io');
    if (io) {
      io.emit('draft:ended');
    }

    res.json({ message: 'Draft ended' });
  } catch (error) {
    console.error('End Draft Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /draft/log - Get draft history
router.get('/log', optionalAuth, (req, res) => {
  try {
    const { season = 1 } = req.query;

    const log = db.prepare(`
      SELECT dl.*, p.handicap, u.name as player_name, t.name as team_name
      FROM draft_log dl
      JOIN players p ON dl.player_id = p.id
      JOIN users u ON p.user_id = u.id
      JOIN teams t ON dl.team_id = t.id
      WHERE dl.season = ?
      ORDER BY dl.round_number ASC, dl.pick_number ASC
    `).all(season);

    res.json({ log });
  } catch (error) {
    console.error('Get Draft Log Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
