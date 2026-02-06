const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../data/wgl.db');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize database schema
function initializeDatabase() {
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'player' CHECK(role IN ('player', 'captain', 'owner', 'admin', 'spectator')),
      verified INTEGER DEFAULT 0,
      photo_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Teams table
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      owner_id INTEGER REFERENCES users(id),
      captain_id INTEGER REFERENCES users(id),
      logo_url TEXT,
      budget_remaining INTEGER DEFAULT 10000000,
      primary_color TEXT DEFAULT '#2D5A27',
      secondary_color TEXT DEFAULT '#C9A227',
      bidding_authority_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Players table (extended user info for players)
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      handicap REAL,
      bio TEXT,
      photo_url TEXT,
      video_url TEXT,
      achievements TEXT,
      base_price INTEGER DEFAULT 100000,
      is_available INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Team Roster (many-to-many with acquisition details)
    CREATE TABLE IF NOT EXISTS team_roster (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      acquisition_type TEXT DEFAULT 'auction' CHECK(acquisition_type IN ('core', 'draft', 'auction')),
      price INTEGER DEFAULT 0,
      season INTEGER DEFAULT 1,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, player_id, season)
    );

    -- Matches table
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_number INTEGER NOT NULL,
      team1_id INTEGER NOT NULL REFERENCES teams(id),
      team2_id INTEGER NOT NULL REFERENCES teams(id),
      match_date DATE,
      tee_time TIME,
      venue TEXT DEFAULT 'KGA',
      status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'live', 'completed', 'postponed')),
      winner_id INTEGER REFERENCES teams(id),
      final_result TEXT,
      season INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Match Scores (hole-by-hole for match play)
    CREATE TABLE IF NOT EXISTS match_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      hole_number INTEGER NOT NULL CHECK(hole_number >= 1 AND hole_number <= 18),
      player_id INTEGER REFERENCES players(id),
      team_id INTEGER NOT NULL REFERENCES teams(id),
      result TEXT CHECK(result IN ('won', 'lost', 'squared')),
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(match_id, hole_number, team_id)
    );

    -- Auction Log
    CREATE TABLE IF NOT EXISTS auction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id),
      team_id INTEGER NOT NULL REFERENCES teams(id),
      bid_amount INTEGER NOT NULL,
      bid_increment INTEGER DEFAULT 0,
      is_auto_bid INTEGER DEFAULT 0,
      is_winning_bid INTEGER DEFAULT 0,
      season INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Draft Log
    CREATE TABLE IF NOT EXISTS draft_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_number INTEGER NOT NULL,
      pick_number INTEGER NOT NULL,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      player_id INTEGER NOT NULL REFERENCES players(id),
      season INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sponsors table
    CREATE TABLE IF NOT EXISTS sponsors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      logo_url TEXT,
      tagline TEXT,
      tier TEXT DEFAULT 'silver' CHECK(tier IN ('platinum', 'gold', 'silver', 'bronze')),
      website_url TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- OTP table for phone verification
    CREATE TABLE IF NOT EXISTS otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Auction/Draft state
    CREATE TABLE IF NOT EXISTS auction_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      mode TEXT CHECK(mode IN ('auction', 'draft', 'idle')) DEFAULT 'idle',
      current_player_id INTEGER REFERENCES players(id),
      current_bid INTEGER DEFAULT 0,
      current_bidder_team_id INTEGER REFERENCES teams(id),
      timer_end DATETIME,
      draft_round INTEGER DEFAULT 1,
      draft_pick INTEGER DEFAULT 1,
      draft_order TEXT,
      season INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Initialize auction state if not exists
    INSERT OR IGNORE INTO auction_state (id, mode) VALUES (1, 'idle');

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_team_roster_team ON team_roster(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_roster_player ON team_roster(player_id);
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_matches_round ON matches(round_number);
    CREATE INDEX IF NOT EXISTS idx_match_scores_match ON match_scores(match_id);
    CREATE INDEX IF NOT EXISTS idx_auction_log_player ON auction_log(player_id);
    CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);
  `);

  console.log('Database initialized successfully');

  // Run migrations for existing databases
  runMigrations();
}

function runMigrations() {
  // Migration: Add bidding_authority_user_id to teams table
  try {
    const columns = db.pragma('table_info(teams)');
    const hasBiddingAuthority = columns.some(col => col.name === 'bidding_authority_user_id');

    if (!hasBiddingAuthority) {
      db.exec('ALTER TABLE teams ADD COLUMN bidding_authority_user_id INTEGER REFERENCES users(id)');
      console.log('Migration: Added bidding_authority_user_id column to teams table');
    }
  } catch (error) {
    console.log('Migration check for bidding_authority_user_id:', error.message);
  }
}

module.exports = { db, initializeDatabase };
