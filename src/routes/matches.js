const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');

// GET /matches - Get all matches
router.get('/', optionalAuth, (req, res) => {
  try {
    const { status, round, team_id, season = 1, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT m.*,
             t1.name as team1_name, t1.logo_url as team1_logo, t1.primary_color as team1_color,
             t2.name as team2_name, t2.logo_url as team2_logo, t2.primary_color as team2_color,
             tw.name as winner_name
      FROM matches m
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      LEFT JOIN teams tw ON m.winner_id = tw.id
      WHERE m.season = ?
    `;
    const params = [season];

    if (status) {
      query += ' AND m.status = ?';
      params.push(status);
    }

    if (round) {
      query += ' AND m.round_number = ?';
      params.push(round);
    }

    if (team_id) {
      query += ' AND (m.team1_id = ? OR m.team2_id = ?)';
      params.push(team_id, team_id);
    }

    query += ' ORDER BY m.match_date DESC, m.tee_time DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const matches = db.prepare(query).all(...params);

    res.json({ matches });
  } catch (error) {
    console.error('Get Matches Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /matches/live - Get live matches
router.get('/live', optionalAuth, (req, res) => {
  try {
    const matches = db.prepare(`
      SELECT m.*,
             t1.name as team1_name, t1.logo_url as team1_logo, t1.primary_color as team1_color,
             t2.name as team2_name, t2.logo_url as team2_logo, t2.primary_color as team2_color
      FROM matches m
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      WHERE m.status = 'live'
      ORDER BY m.round_number ASC
    `).all();

    // Get scores for each live match
    const matchesWithScores = matches.map(match => {
      const scores = db.prepare(`
        SELECT hole_number, team_id, result
        FROM match_scores
        WHERE match_id = ?
        ORDER BY hole_number ASC
      `).all(match.id);

      // Calculate standing
      let team1Score = 0;
      let team2Score = 0;
      let lastHole = 0;

      scores.forEach(score => {
        if (score.team_id === match.team1_id && score.result === 'won') team1Score++;
        if (score.team_id === match.team2_id && score.result === 'won') team2Score++;
        lastHole = Math.max(lastHole, score.hole_number);
      });

      return {
        ...match,
        scores,
        standing: team1Score - team2Score,
        holesPlayed: lastHole,
        toPlay: 18 - lastHole
      };
    });

    res.json({ matches: matchesWithScores });
  } catch (error) {
    console.error('Get Live Matches Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /matches/:id - Get match by ID with scores
router.get('/:id', optionalAuth, (req, res) => {
  try {
    const { id } = req.params;

    const match = db.prepare(`
      SELECT m.*,
             t1.name as team1_name, t1.logo_url as team1_logo, t1.primary_color as team1_color,
             t2.name as team2_name, t2.logo_url as team2_logo, t2.primary_color as team2_color,
             tw.name as winner_name
      FROM matches m
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      LEFT JOIN teams tw ON m.winner_id = tw.id
      WHERE m.id = ?
    `).get(id);

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Get hole-by-hole scores
    const scores = db.prepare(`
      SELECT ms.*, p.handicap, u.name as player_name
      FROM match_scores ms
      LEFT JOIN players p ON ms.player_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE ms.match_id = ?
      ORDER BY ms.hole_number ASC, ms.team_id ASC
    `).all(id);

    // Get team rosters for this match
    const team1Roster = db.prepare(`
      SELECT p.*, u.name
      FROM team_roster tr
      JOIN players p ON tr.player_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE tr.team_id = ? AND tr.season = ?
    `).all(match.team1_id, match.season);

    const team2Roster = db.prepare(`
      SELECT p.*, u.name
      FROM team_roster tr
      JOIN players p ON tr.player_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE tr.team_id = ? AND tr.season = ?
    `).all(match.team2_id, match.season);

    res.json({
      match,
      scores,
      team1Roster,
      team2Roster
    });
  } catch (error) {
    console.error('Get Match Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /matches - Create new match
router.post('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { round_number, team1_id, team2_id, match_date, tee_time, venue, season = 1 } = req.body;

    if (!round_number || !team1_id || !team2_id) {
      return res.status(400).json({ error: 'Round number and both team IDs are required' });
    }

    if (team1_id === team2_id) {
      return res.status(400).json({ error: 'Teams must be different' });
    }

    const result = db.prepare(`
      INSERT INTO matches (round_number, team1_id, team2_id, match_date, tee_time, venue, season)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(round_number, team1_id, team2_id, match_date || null, tee_time || null, venue || 'KGA', season);

    const match = db.prepare(`
      SELECT m.*,
             t1.name as team1_name, t2.name as team2_name
      FROM matches m
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      WHERE m.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ match });
  } catch (error) {
    console.error('Create Match Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /matches/:id - Update match
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { status, match_date, tee_time, venue, winner_id, final_result } = req.body;

    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Check permission (admin or team captain/owner)
    const isAdmin = req.user.role === 'admin';
    const isTeamMember = db.prepare(`
      SELECT 1 FROM teams
      WHERE (id = ? OR id = ?) AND (owner_id = ? OR captain_id = ?)
    `).get(match.team1_id, match.team2_id, req.user.id, req.user.id);

    if (!isAdmin && !isTeamMember) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates = [];
    const params = [];

    if (status !== undefined) {
      if (!['scheduled', 'live', 'completed', 'postponed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.push('status = ?');
      params.push(status);
    }

    if (match_date !== undefined) {
      updates.push('match_date = ?');
      params.push(match_date);
    }

    if (tee_time !== undefined) {
      updates.push('tee_time = ?');
      params.push(tee_time);
    }

    if (venue !== undefined) {
      updates.push('venue = ?');
      params.push(venue);
    }

    if (winner_id !== undefined && isAdmin) {
      updates.push('winner_id = ?');
      params.push(winner_id);
    }

    if (final_result !== undefined) {
      updates.push('final_result = ?');
      params.push(final_result);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    db.prepare(`UPDATE matches SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedMatch = db.prepare(`
      SELECT m.*,
             t1.name as team1_name, t2.name as team2_name,
             tw.name as winner_name
      FROM matches m
      JOIN teams t1 ON m.team1_id = t1.id
      JOIN teams t2 ON m.team2_id = t2.id
      LEFT JOIN teams tw ON m.winner_id = tw.id
      WHERE m.id = ?
    `).get(id);

    // Emit socket event for live updates
    const io = req.app.get('io');
    if (io) {
      io.to(`match-${id}`).emit('match:updated', updatedMatch);
      if (status === 'live' || status === 'completed') {
        io.emit('matches:updated', updatedMatch);
      }
    }

    res.json({ match: updatedMatch });
  } catch (error) {
    console.error('Update Match Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /matches/:id/score - Record hole score
router.post('/:id/score', authenticateToken, (req, res) => {
  try {
    const { id } = req.params;
    const { hole_number, team_id, result, player_id } = req.body;

    if (!hole_number || !team_id || !result) {
      return res.status(400).json({ error: 'Hole number, team ID, and result are required' });
    }

    if (hole_number < 1 || hole_number > 18) {
      return res.status(400).json({ error: 'Hole number must be between 1 and 18' });
    }

    if (!['won', 'lost', 'squared'].includes(result)) {
      return res.status(400).json({ error: 'Result must be won, lost, or squared' });
    }

    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Verify team is part of the match
    if (team_id !== match.team1_id && team_id !== match.team2_id) {
      return res.status(400).json({ error: 'Team is not part of this match' });
    }

    // Check permission
    const isAdmin = req.user.role === 'admin';
    const isTeamMember = db.prepare(`
      SELECT 1 FROM teams
      WHERE id = ? AND (owner_id = ? OR captain_id = ?)
    `).get(team_id, req.user.id, req.user.id);

    const isPlayer = db.prepare(`
      SELECT 1 FROM players p
      JOIN team_roster tr ON p.id = tr.player_id
      WHERE p.user_id = ? AND tr.team_id = ?
    `).get(req.user.id, team_id);

    if (!isAdmin && !isTeamMember && !isPlayer) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Insert or update score
    db.prepare(`
      INSERT INTO match_scores (match_id, hole_number, team_id, result, player_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(match_id, hole_number, team_id) DO UPDATE SET
        result = excluded.result,
        player_id = excluded.player_id,
        recorded_at = CURRENT_TIMESTAMP
    `).run(id, hole_number, team_id, result, player_id || null);

    // If match is not live yet, set it to live
    if (match.status === 'scheduled') {
      db.prepare('UPDATE matches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('live', id);
    }

    // Get updated scores
    const scores = db.prepare(`
      SELECT hole_number, team_id, result
      FROM match_scores
      WHERE match_id = ?
      ORDER BY hole_number ASC
    `).all(id);

    // Calculate current standing
    let team1Score = 0;
    let team2Score = 0;

    scores.forEach(score => {
      if (score.team_id === match.team1_id && score.result === 'won') team1Score++;
      if (score.team_id === match.team2_id && score.result === 'won') team2Score++;
    });

    const standing = team1Score - team2Score;
    const holesPlayed = scores.length / 2; // Assuming both teams record

    // Check if match is over (dormie + won, or all 18 played)
    const toPlay = 18 - holesPlayed;
    const isMatchOver = holesPlayed >= 18 || Math.abs(standing) > toPlay;

    if (isMatchOver && match.status === 'live') {
      const winner_id = standing > 0 ? match.team1_id : standing < 0 ? match.team2_id : null;
      const final_result = standing === 0 ? 'Draw' :
        `${Math.abs(standing)}&${toPlay === 0 ? '0' : toPlay}`;

      db.prepare(`
        UPDATE matches SET status = 'completed', winner_id = ?, final_result = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(winner_id, final_result, id);
    }

    // Emit socket event
    const io = req.app.get('io');
    if (io) {
      const scoreUpdate = {
        matchId: id,
        holeNumber: hole_number,
        teamId: team_id,
        result,
        standing,
        holesPlayed,
        toPlay
      };
      io.to(`match-${id}`).emit('score:updated', scoreUpdate);
      io.emit('matches:score', scoreUpdate);
    }

    res.json({
      message: 'Score recorded',
      standing,
      holesPlayed,
      toPlay,
      isMatchOver
    });
  } catch (error) {
    console.error('Record Score Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
