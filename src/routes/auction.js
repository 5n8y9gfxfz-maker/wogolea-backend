const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { authenticateToken, optionalAuth, requireAdmin } = require('../middleware/auth');

// In-memory bid queue and processing state
let bidQueue = [];
let isProcessingBids = false;
let lastBidTime = 0;
const BID_INTERVAL_MS = 3000; // 3 seconds between bids

// Configurable setup phase duration (admin can change this)
let setupPhaseDuration = 30000; // Default 30 seconds for teams to set auto-bid

// Auto-bid settings per team { teamId: { maxBid: number, increment: number, active: boolean } }
let autoBidSettings = {};

// Current phase: 'setup' (15s to set auto-bid) or 'bidding' (active bidding)
let currentPhase = 'idle';
let phaseTimer = null;

// Process the bid queue
async function processBidQueue(io) {
  if (isProcessingBids || bidQueue.length === 0) return;

  isProcessingBids = true;

  while (bidQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastBid = now - lastBidTime;

    if (timeSinceLastBid < BID_INTERVAL_MS) {
      // Wait for remaining time
      await new Promise(resolve => setTimeout(resolve, BID_INTERVAL_MS - timeSinceLastBid));
    }

    const bid = bidQueue.shift();
    if (bid) {
      await executeBid(bid, io);
      lastBidTime = Date.now();

      // Check for auto-bids from other teams
      await checkAutoBids(bid.teamId, io);
    }
  }

  isProcessingBids = false;
}

// Execute a single bid
async function executeBid(bid, io) {
  const { teamId, amount, increment, isAutoBid } = bid;

  const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

  if (state.mode !== 'auction' || !state.current_player_id) {
    return { success: false, error: 'Auction not active' };
  }

  // Check if bid is still valid (higher than current)
  if (amount <= state.current_bid) {
    return { success: false, error: 'Bid too low' };
  }

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team || amount > team.budget_remaining) {
    return { success: false, error: 'Invalid team or insufficient budget' };
  }

  // Extend timer by 10 seconds on new bid
  const newTimerEnd = new Date(Date.now() + 10 * 1000).toISOString();

  // Update auction state
  db.prepare(`
    UPDATE auction_state SET
      current_bid = ?,
      current_bidder_team_id = ?,
      timer_end = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(amount, teamId, newTimerEnd);

  // Log bid with increment
  db.prepare(`
    INSERT INTO auction_log (player_id, team_id, bid_amount, bid_increment, is_auto_bid, season)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(state.current_player_id, teamId, amount, increment || 0, isAutoBid ? 1 : 0, state.season);

  if (io) {
    io.emit('auction:bid', {
      playerId: state.current_player_id,
      teamId: teamId,
      teamName: team.name,
      teamColor: team.primary_color,
      amount,
      increment: increment || 0,
      isAutoBid: isAutoBid || false,
      timerEnd: newTimerEnd,
      queueLength: bidQueue.length
    });
  }

  return { success: true };
}

// Check and trigger auto-bids from other teams
async function checkAutoBids(excludeTeamId, io) {
  const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();
  if (state.mode !== 'auction' || !state.current_player_id) return;

  for (const [teamIdStr, settings] of Object.entries(autoBidSettings)) {
    const teamId = parseInt(teamIdStr);
    if (teamId === excludeTeamId || !settings.active) continue;

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!team) continue;

    const nextBid = state.current_bid + settings.increment;

    // Check if auto-bid should trigger
    if (nextBid <= settings.maxBid && nextBid <= team.budget_remaining) {
      // Add to queue
      bidQueue.push({
        teamId,
        amount: nextBid,
        increment: settings.increment,
        isAutoBid: true
      });
    }
  }

  // Continue processing if new bids were added
  if (bidQueue.length > 0 && !isProcessingBids) {
    processBidQueue(io);
  }
}

// GET /auction/state - Get current auction/draft state
router.get('/state', optionalAuth, (req, res) => {
  try {
    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    let currentPlayer = null;
    let currentBidder = null;

    if (state.current_player_id) {
      currentPlayer = db.prepare(`
        SELECT p.*, u.name, u.photo_url as user_photo
        FROM players p
        JOIN users u ON p.user_id = u.id
        WHERE p.id = ?
      `).get(state.current_player_id);
    }

    if (state.current_bidder_team_id) {
      currentBidder = db.prepare('SELECT * FROM teams WHERE id = ?').get(state.current_bidder_team_id);
    }

    // Get all teams with their budgets
    const teams = db.prepare(`
      SELECT t.*,
             (SELECT COUNT(*) FROM team_roster tr WHERE tr.team_id = t.id AND tr.season = ?) as player_count
      FROM teams t
      ORDER BY t.name
    `).all(state.season);

    res.json({
      state: {
        ...state,
        draft_order: state.draft_order ? JSON.parse(state.draft_order) : null
      },
      currentPlayer,
      currentBidder,
      teams,
      bidQueue: bidQueue.map(b => ({ teamId: b.teamId, amount: b.amount })),
      autoBidSettings,
      phase: currentPhase,
      config: {
        setupPhaseDuration: setupPhaseDuration / 1000,
        bidIntervalMs: BID_INTERVAL_MS
      }
    });
  } catch (error) {
    console.error('Get Auction State Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/start - Start auction mode (admin only)
router.post('/start', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { season = 1 } = req.body;

    // Reset bid queue and auto-bid settings
    bidQueue = [];
    autoBidSettings = {};
    lastBidTime = 0;

    db.prepare(`
      UPDATE auction_state SET
        mode = 'auction',
        current_player_id = NULL,
        current_bid = 0,
        current_bidder_team_id = NULL,
        timer_end = NULL,
        season = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(season);

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:started', { mode: 'auction', season });
    }

    res.json({ message: 'Auction started', mode: 'auction' });
  } catch (error) {
    console.error('Start Auction Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Function to start bidding phase after setup
function startBiddingPhase(io) {
  currentPhase = 'bidding';

  // Set bidding timer (30 seconds)
  const timerEnd = new Date(Date.now() + 30 * 1000).toISOString();

  db.prepare(`
    UPDATE auction_state SET
      timer_end = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(timerEnd);

  if (io) {
    io.emit('auction:bidding-started', {
      phase: 'bidding',
      timerEnd
    });
  }

  // Check if any auto-bids should trigger immediately
  const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();
  if (state.current_player_id) {
    triggerInitialAutoBids(state, io);
  }
}

// Trigger auto-bids at start of bidding phase
function triggerInitialAutoBids(state, io) {
  const sortedAutoBids = Object.entries(autoBidSettings)
    .filter(([_, settings]) => settings.active && settings.maxBid >= state.current_bid)
    .sort((a, b) => b[1].maxBid - a[1].maxBid); // Highest max bid first

  if (sortedAutoBids.length > 0) {
    // First auto-bidder places opening bid at base price
    const [teamIdStr, settings] = sortedAutoBids[0];
    const teamId = parseInt(teamIdStr);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);

    if (team && state.current_bid <= team.budget_remaining) {
      bidQueue.push({
        teamId,
        amount: state.current_bid,
        increment: 0,
        isAutoBid: true
      });
      processBidQueue(io);
    }
  }
}

// POST /auction/next-player - Set next player for auction (admin only)
router.post('/next-player', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { player_id } = req.body;

    if (!player_id) {
      return res.status(400).json({ error: 'Player ID is required' });
    }

    const player = db.prepare(`
      SELECT p.*, u.name, u.photo_url as user_photo
      FROM players p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND p.is_available = 1
    `).get(player_id);

    if (!player) {
      return res.status(404).json({ error: 'Player not found or not available' });
    }

    // Clear bid queue and reset auto-bid settings for new player
    bidQueue = [];
    autoBidSettings = {};
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }

    // Start setup phase (configurable duration for teams to set auto-bid)
    currentPhase = 'setup';
    const setupEndTime = new Date(Date.now() + setupPhaseDuration).toISOString();

    db.prepare(`
      UPDATE auction_state SET
        current_player_id = ?,
        current_bid = ?,
        current_bidder_team_id = NULL,
        timer_end = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(player_id, player.base_price, setupEndTime);

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:player', {
        player,
        baseBid: player.base_price,
        phase: 'setup',
        setupEndTime,
        setupDuration: setupPhaseDuration / 1000
      });
    }

    // Schedule transition to bidding phase
    phaseTimer = setTimeout(() => {
      startBiddingPhase(io);
    }, setupPhaseDuration);

    res.json({
      message: 'Player set for auction - setup phase started',
      player,
      baseBid: player.base_price,
      phase: 'setup',
      setupEndTime
    });
  } catch (error) {
    console.error('Next Player Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to check if user has bidding authority for a team
function hasBiddingAuthority(team, userId, userRole) {
  // Admins can always bid
  if (userRole === 'admin') return true;

  // If bidding_authority_user_id is set, only that user can bid
  if (team.bidding_authority_user_id) {
    return team.bidding_authority_user_id === userId;
  }

  // Otherwise, only the owner can bid
  return team.owner_id === userId;
}

// POST /auction/bid - Place a bid (queued with 3-second intervals)
router.post('/bid', authenticateToken, (req, res) => {
  try {
    const { team_id, amount, increment } = req.body;

    if (!team_id || !amount) {
      return res.status(400).json({ error: 'Team ID and amount are required' });
    }

    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (state.mode !== 'auction') {
      return res.status(400).json({ error: 'Auction is not active' });
    }

    if (!state.current_player_id) {
      return res.status(400).json({ error: 'No player currently being auctioned' });
    }

    if (currentPhase === 'setup') {
      return res.status(400).json({ error: 'Still in setup phase - set your auto-bid target instead' });
    }

    // Check permission
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (!hasBiddingAuthority(team, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'You do not have bidding authority for this team' });
    }

    // Check if bid is higher than current
    if (amount <= state.current_bid) {
      return res.status(400).json({ error: 'Bid must be higher than current bid' });
    }

    // Check team budget
    if (amount > team.budget_remaining) {
      return res.status(400).json({ error: 'Insufficient budget' });
    }

    // Add to bid queue
    bidQueue.push({
      teamId: team_id,
      amount,
      increment: increment || (amount - state.current_bid),
      isAutoBid: false
    });

    // Emit queue update
    const io = req.app.get('io');
    if (io) {
      io.emit('auction:bid-queued', {
        teamId: team_id,
        teamName: team.name,
        amount,
        queuePosition: bidQueue.length,
        queueLength: bidQueue.length
      });
    }

    // Start processing queue
    processBidQueue(io);

    res.json({
      message: 'Bid queued',
      queuePosition: bidQueue.length,
      amount
    });
  } catch (error) {
    console.error('Bid Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/auto-bid - Set auto-bid settings for a team
router.post('/auto-bid', authenticateToken, (req, res) => {
  try {
    const { team_id, max_bid, increment, active } = req.body;

    if (!team_id) {
      return res.status(400).json({ error: 'Team ID is required' });
    }

    // Check permission
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (!hasBiddingAuthority(team, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'You do not have bidding authority for this team' });
    }

    if (active === false) {
      // Disable auto-bid
      delete autoBidSettings[team_id];
    } else {
      // Set or update auto-bid
      if (!max_bid || !increment) {
        return res.status(400).json({ error: 'Max bid and increment are required' });
      }

      if (max_bid > team.budget_remaining) {
        return res.status(400).json({ error: 'Max bid exceeds budget' });
      }

      autoBidSettings[team_id] = {
        maxBid: max_bid,
        increment: increment,
        active: true
      };
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:auto-bid-updated', {
        teamId: team_id,
        teamName: team.name,
        settings: autoBidSettings[team_id] || null
      });
    }

    res.json({
      message: active === false ? 'Auto-bid disabled' : 'Auto-bid settings updated',
      settings: autoBidSettings[team_id] || null
    });
  } catch (error) {
    console.error('Auto-bid Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auction/auto-bid/:team_id - Get auto-bid settings for a team
router.get('/auto-bid/:team_id', authenticateToken, (req, res) => {
  try {
    const { team_id } = req.params;
    res.json({ settings: autoBidSettings[team_id] || null });
  } catch (error) {
    console.error('Get Auto-bid Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auction/queue - Get current bid queue
router.get('/queue', optionalAuth, (req, res) => {
  try {
    const queueInfo = bidQueue.map(bid => {
      const team = db.prepare('SELECT id, name, primary_color FROM teams WHERE id = ?').get(bid.teamId);
      return {
        teamId: bid.teamId,
        teamName: team?.name || 'Unknown',
        teamColor: team?.primary_color || '#666',
        amount: bid.amount,
        isAutoBid: bid.isAutoBid
      };
    });

    res.json({
      queue: queueInfo,
      queueLength: bidQueue.length,
      isProcessing: isProcessingBids
    });
  } catch (error) {
    console.error('Get Queue Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/sold - Mark player as sold (admin only)
router.post('/sold', authenticateToken, requireAdmin, (req, res) => {
  try {
    // Clear bid queue and phase
    bidQueue = [];
    currentPhase = 'idle';
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }

    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (!state.current_player_id || !state.current_bidder_team_id) {
      return res.status(400).json({ error: 'No active bid to complete' });
    }

    const player = db.prepare(`
      SELECT p.*, u.name FROM players p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(state.current_player_id);

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(state.current_bidder_team_id);

    // Add player to team roster
    db.prepare(`
      INSERT INTO team_roster (team_id, player_id, acquisition_type, price, season)
      VALUES (?, ?, 'auction', ?, ?)
    `).run(state.current_bidder_team_id, state.current_player_id, state.current_bid, state.season);

    // Update team budget
    db.prepare('UPDATE teams SET budget_remaining = budget_remaining - ? WHERE id = ?')
      .run(state.current_bid, state.current_bidder_team_id);

    // Mark player as unavailable
    db.prepare('UPDATE players SET is_available = 0 WHERE id = ?').run(state.current_player_id);

    // Mark winning bid in auction log
    db.prepare(`
      UPDATE auction_log SET is_winning_bid = 1
      WHERE player_id = ? AND team_id = ? AND bid_amount = ? AND season = ?
    `).run(state.current_player_id, state.current_bidder_team_id, state.current_bid, state.season);

    // Clear current auction
    db.prepare(`
      UPDATE auction_state SET
        current_player_id = NULL,
        current_bid = 0,
        current_bidder_team_id = NULL,
        timer_end = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();

    // Reset auto-bid settings for next player
    autoBidSettings = {};

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:sold', {
        player,
        team,
        price: state.current_bid
      });
    }

    res.json({
      message: 'Player sold',
      player,
      team,
      price: state.current_bid
    });
  } catch (error) {
    console.error('Sold Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/unsold - Mark player as unsold (admin only)
router.post('/unsold', authenticateToken, requireAdmin, (req, res) => {
  try {
    // Clear bid queue and phase
    bidQueue = [];
    currentPhase = 'idle';
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }

    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (!state.current_player_id) {
      return res.status(400).json({ error: 'No player being auctioned' });
    }

    const player = db.prepare(`
      SELECT p.*, u.name FROM players p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(state.current_player_id);

    // Clear current auction
    db.prepare(`
      UPDATE auction_state SET
        current_player_id = NULL,
        current_bid = 0,
        current_bidder_team_id = NULL,
        timer_end = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();

    // Reset auto-bid settings
    autoBidSettings = {};

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:unsold', { player });
    }

    res.json({ message: 'Player marked as unsold', player });
  } catch (error) {
    console.error('Unsold Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/end - End auction (admin only)
router.post('/end', authenticateToken, requireAdmin, (req, res) => {
  try {
    // Clear everything
    bidQueue = [];
    autoBidSettings = {};

    db.prepare(`
      UPDATE auction_state SET
        mode = 'idle',
        current_player_id = NULL,
        current_bid = 0,
        current_bidder_team_id = NULL,
        timer_end = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:ended');
    }

    res.json({ message: 'Auction ended' });
  } catch (error) {
    console.error('End Auction Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auction/authority/:team_id - Get bidding authority for a team
router.get('/authority/:team_id', authenticateToken, (req, res) => {
  try {
    const { team_id } = req.params;

    const team = db.prepare(`
      SELECT t.*,
        owner.name as owner_name,
        owner.phone as owner_phone,
        captain.name as captain_name,
        captain.phone as captain_phone,
        authority.name as authority_name,
        authority.phone as authority_phone
      FROM teams t
      LEFT JOIN users owner ON t.owner_id = owner.id
      LEFT JOIN users captain ON t.captain_id = captain.id
      LEFT JOIN users authority ON t.bidding_authority_user_id = authority.id
      WHERE t.id = ?
    `).get(team_id);

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Check if current user can view this
    const isAdmin = req.user.role === 'admin';
    const isTeamMember = team.owner_id === req.user.id || team.captain_id === req.user.id;

    if (!isAdmin && !isTeamMember) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Determine who currently has authority
    let authorizedUser = null;
    if (team.bidding_authority_user_id) {
      authorizedUser = {
        id: team.bidding_authority_user_id,
        name: team.authority_name,
        phone: team.authority_phone,
        role: 'delegated'
      };
    } else if (team.owner_id) {
      authorizedUser = {
        id: team.owner_id,
        name: team.owner_name,
        phone: team.owner_phone,
        role: 'owner'
      };
    }

    // Check if current user has authority
    const currentUserHasAuthority = hasBiddingAuthority(team, req.user.id, req.user.role);

    res.json({
      teamId: team.id,
      teamName: team.name,
      authorizedUser,
      currentUserHasAuthority,
      canDelegate: team.owner_id === req.user.id || req.user.role === 'admin',
      owner: team.owner_id ? { id: team.owner_id, name: team.owner_name } : null,
      captain: team.captain_id ? { id: team.captain_id, name: team.captain_name } : null
    });
  } catch (error) {
    console.error('Get Authority Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/authority - Delegate bidding authority (owner only)
router.post('/authority', authenticateToken, (req, res) => {
  try {
    const { team_id, delegate_to_user_id } = req.body;

    if (!team_id) {
      return res.status(400).json({ error: 'Team ID is required' });
    }

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Only owner or admin can delegate
    const isAdmin = req.user.role === 'admin';
    const isOwner = team.owner_id === req.user.id;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Only the team owner can delegate bidding authority' });
    }

    if (delegate_to_user_id) {
      // Verify the delegate is a valid team member (captain or core player)
      const delegateUser = db.prepare('SELECT * FROM users WHERE id = ?').get(delegate_to_user_id);
      if (!delegateUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if user is captain or a core player of this team
      const isCaptain = team.captain_id === delegate_to_user_id;
      const isCorePlayer = db.prepare(`
        SELECT 1 FROM team_roster tr
        JOIN players p ON tr.player_id = p.id
        WHERE tr.team_id = ? AND p.user_id = ? AND tr.acquisition_type = 'core'
      `).get(team_id, delegate_to_user_id);

      if (!isCaptain && !isCorePlayer) {
        return res.status(400).json({
          error: 'Can only delegate to team captain or core players'
        });
      }

      // Set bidding authority
      db.prepare('UPDATE teams SET bidding_authority_user_id = ? WHERE id = ?')
        .run(delegate_to_user_id, team_id);

      res.json({
        message: `Bidding authority delegated to ${delegateUser.name}`,
        delegatedTo: {
          id: delegateUser.id,
          name: delegateUser.name
        }
      });
    } else {
      // Revoke delegation - authority returns to owner
      db.prepare('UPDATE teams SET bidding_authority_user_id = NULL WHERE id = ?')
        .run(team_id);

      res.json({
        message: 'Bidding authority returned to owner',
        delegatedTo: null
      });
    }

    // Notify via socket
    const io = req.app.get('io');
    if (io) {
      io.emit('auction:authority-changed', {
        teamId: team_id,
        delegatedToUserId: delegate_to_user_id || null
      });
    }
  } catch (error) {
    console.error('Delegate Authority Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /auction/authority/:team_id - Revoke bidding authority (owner only)
router.delete('/authority/:team_id', authenticateToken, (req, res) => {
  try {
    const { team_id } = req.params;

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Only owner or admin can revoke
    const isAdmin = req.user.role === 'admin';
    const isOwner = team.owner_id === req.user.id;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'Only the team owner can revoke bidding authority' });
    }

    db.prepare('UPDATE teams SET bidding_authority_user_id = NULL WHERE id = ?')
      .run(team_id);

    // Notify via socket
    const io = req.app.get('io');
    if (io) {
      io.emit('auction:authority-changed', {
        teamId: parseInt(team_id),
        delegatedToUserId: null
      });
    }

    res.json({ message: 'Bidding authority revoked - returned to owner' });
  } catch (error) {
    console.error('Revoke Authority Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/manual-bid - Admin manual bid (backup for mobile failures)
router.post('/manual-bid', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { team_id, amount } = req.body;

    if (!team_id || !amount) {
      return res.status(400).json({ error: 'Team ID and amount are required' });
    }

    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (!state.current_player_id) {
      return res.status(400).json({ error: 'No player currently being auctioned' });
    }

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (amount <= state.current_bid) {
      return res.status(400).json({ error: 'Bid must be higher than current bid' });
    }

    if (amount > team.budget_remaining) {
      return res.status(400).json({ error: 'Insufficient budget' });
    }

    // Skip the queue for manual bids - execute immediately
    const increment = amount - state.current_bid;
    const newTimerEnd = new Date(Date.now() + 10 * 1000).toISOString();

    // Update auction state directly
    db.prepare(`
      UPDATE auction_state SET
        current_bid = ?,
        current_bidder_team_id = ?,
        timer_end = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(amount, team_id, newTimerEnd);

    // Log the bid
    db.prepare(`
      INSERT INTO auction_log (player_id, team_id, bid_amount, bid_increment, is_auto_bid, season)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(state.current_player_id, team_id, amount, increment, state.season);

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:bid', {
        playerId: state.current_player_id,
        teamId: team_id,
        teamName: team.name,
        teamColor: team.primary_color,
        amount,
        increment,
        isAutoBid: false,
        isManualBid: true,
        timerEnd: newTimerEnd,
        queueLength: 0
      });
    }

    res.json({
      success: true,
      message: 'Manual bid placed',
      amount,
      team: { id: team.id, name: team.name }
    });
  } catch (error) {
    console.error('Manual Bid Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/skip-to-bidding - Skip setup phase and go to bidding (admin only)
router.post('/skip-to-bidding', authenticateToken, requireAdmin, (req, res) => {
  try {
    if (currentPhase !== 'setup') {
      return res.status(400).json({ error: 'Not in setup phase' });
    }

    // Cancel the setup timer
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }

    // Start bidding immediately
    const io = req.app.get('io');
    startBiddingPhase(io);

    res.json({ message: 'Skipped to bidding phase' });
  } catch (error) {
    console.error('Skip to Bidding Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/extend-timer - Extend the bidding timer (admin only)
router.post('/extend-timer', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { seconds = 30 } = req.body;

    const state = db.prepare('SELECT * FROM auction_state WHERE id = 1').get();

    if (!state.current_player_id) {
      return res.status(400).json({ error: 'No active auction' });
    }

    const newTimerEnd = new Date(Date.now() + seconds * 1000).toISOString();

    db.prepare(`
      UPDATE auction_state SET
        timer_end = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(newTimerEnd);

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:timer-extended', {
        timerEnd: newTimerEnd,
        seconds
      });
    }

    res.json({ message: `Timer extended by ${seconds} seconds`, timerEnd: newTimerEnd });
  } catch (error) {
    console.error('Extend Timer Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/pause - Pause the auction (admin only)
router.post('/pause', authenticateToken, requireAdmin, (req, res) => {
  try {
    // Clear timers
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }

    const previousPhase = currentPhase;
    currentPhase = 'paused';

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:paused', { previousPhase });
    }

    res.json({ message: 'Auction paused', previousPhase });
  } catch (error) {
    console.error('Pause Auction Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/set-setup-duration - Set setup phase duration (admin only)
router.post('/set-setup-duration', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { seconds = 30 } = req.body;

    if (seconds < 5 || seconds > 120) {
      return res.status(400).json({ error: 'Duration must be between 5 and 120 seconds' });
    }

    setupPhaseDuration = seconds * 1000;

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:config-updated', {
        setupPhaseDuration: seconds
      });
    }

    res.json({ message: `Setup phase duration set to ${seconds} seconds`, seconds });
  } catch (error) {
    console.error('Set Setup Duration Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auction/config - Get auction configuration
router.get('/config', optionalAuth, (req, res) => {
  try {
    res.json({
      setupPhaseDuration: setupPhaseDuration / 1000,
      bidIntervalMs: BID_INTERVAL_MS
    });
  } catch (error) {
    console.error('Get Config Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auction/resume - Resume the auction (admin only)
router.post('/resume', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { phase = 'bidding' } = req.body;

    currentPhase = phase;

    // Set a new timer
    const timerEnd = new Date(Date.now() + 30 * 1000).toISOString();
    db.prepare(`
      UPDATE auction_state SET
        timer_end = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(timerEnd);

    const io = req.app.get('io');
    if (io) {
      io.emit('auction:resumed', { phase, timerEnd });
    }

    res.json({ message: 'Auction resumed', phase, timerEnd });
  } catch (error) {
    console.error('Resume Auction Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auction/log - Get auction history
router.get('/log', optionalAuth, (req, res) => {
  try {
    const { season = 1, player_id, team_id } = req.query;

    let query = `
      SELECT al.*, p.handicap, u.name as player_name, t.name as team_name
      FROM auction_log al
      JOIN players p ON al.player_id = p.id
      JOIN users u ON p.user_id = u.id
      JOIN teams t ON al.team_id = t.id
      WHERE al.season = ?
    `;
    const params = [season];

    if (player_id) {
      query += ' AND al.player_id = ?';
      params.push(player_id);
    }

    if (team_id) {
      query += ' AND al.team_id = ?';
      params.push(team_id);
    }

    query += ' ORDER BY al.created_at DESC';

    const log = db.prepare(query).all(...params);

    res.json({ log });
  } catch (error) {
    console.error('Get Auction Log Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
