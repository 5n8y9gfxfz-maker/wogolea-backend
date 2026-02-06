require('dotenv').config();

const { db, initializeDatabase } = require('./database');

// Initialize database first
initializeDatabase();

console.log('Seeding database with sample data...');

// Clear existing data
db.exec(`
  DELETE FROM match_scores;
  DELETE FROM matches;
  DELETE FROM draft_log;
  DELETE FROM auction_log;
  DELETE FROM team_roster;
  DELETE FROM players;
  DELETE FROM teams;
  DELETE FROM sponsors;
  DELETE FROM otp_codes;
  DELETE FROM users;
  UPDATE auction_state SET mode = 'idle', current_player_id = NULL, current_bid = 0, current_bidder_team_id = NULL WHERE id = 1;
`);

// Create admin user
const adminResult = db.prepare(`
  INSERT INTO users (phone, name, role, verified) VALUES (?, ?, ?, 1)
`).run('+919876543210', 'Admin User', 'admin');

console.log('Created admin user (phone: +919876543210)');

// Create team owners
const owners = [
  { phone: '+919876543211', name: 'Priya Sharma' },
  { phone: '+919876543212', name: 'Anita Patel' },
  { phone: '+919876543213', name: 'Meera Reddy' },
  { phone: '+919876543214', name: 'Kavita Singh' },
  { phone: '+919876543215', name: 'Deepa Gupta' },
  { phone: '+919876543216', name: 'Sunita Joshi' },
];

const ownerIds = owners.map(owner => {
  const result = db.prepare(`
    INSERT INTO users (phone, name, role, verified) VALUES (?, ?, 'owner', 1)
  `).run(owner.phone, owner.name);
  return result.lastInsertRowid;
});

console.log(`Created ${owners.length} team owners`);

// Create teams
const teams = [
  { name: 'SNC Eagles', primary: '#2D5A27', secondary: '#C9A227' },
  { name: 'Phoenix Rising', primary: '#E53935', secondary: '#FFD700' },
  { name: 'Royal Strikers', primary: '#1565C0', secondary: '#FFFFFF' },
  { name: 'Green Valley', primary: '#388E3C', secondary: '#81C784' },
  { name: 'Fairway Queens', primary: '#7B1FA2', secondary: '#E1BEE7' },
  { name: 'Birdie Bunch', primary: '#F57C00', secondary: '#FFE0B2' },
];

const teamIds = teams.map((team, index) => {
  const result = db.prepare(`
    INSERT INTO teams (name, owner_id, primary_color, secondary_color, budget_remaining)
    VALUES (?, ?, ?, ?, ?)
  `).run(team.name, ownerIds[index], team.primary, team.secondary, 10000000);
  return result.lastInsertRowid;
});

console.log(`Created ${teams.length} teams`);

// Create players (30 players total - 5 per team after draft/auction)
const playerNames = [
  'Sarah Johnson', 'Emily Chen', 'Jessica Williams', 'Amanda Brown', 'Rachel Davis',
  'Michelle Lee', 'Ashley Wilson', 'Stephanie Moore', 'Nicole Taylor', 'Jennifer Anderson',
  'Lauren Thomas', 'Christina Jackson', 'Kimberly White', 'Rebecca Harris', 'Elizabeth Martin',
  'Megan Thompson', 'Heather Garcia', 'Samantha Martinez', 'Tiffany Robinson', 'Brittany Clark',
  'Hannah Lewis', 'Victoria Walker', 'Grace Hall', 'Olivia Allen', 'Emma Young',
  'Sophia King', 'Isabella Wright', 'Ava Scott', 'Madison Green', 'Chloe Adams'
];

const playerIds = playerNames.map((name, index) => {
  const phone = `+91987654${3220 + index}`;
  const handicap = 5 + Math.floor(Math.random() * 20); // Handicaps from 5 to 24
  const basePrice = 100000 + Math.floor(Math.random() * 500000); // 1-6 lakhs

  // Create user
  const userResult = db.prepare(`
    INSERT INTO users (phone, name, role, verified) VALUES (?, ?, 'player', 1)
  `).run(phone, name);

  // Create player profile
  const playerResult = db.prepare(`
    INSERT INTO players (user_id, handicap, bio, base_price, is_available)
    VALUES (?, ?, ?, ?, 1)
  `).run(
    userResult.lastInsertRowid,
    handicap,
    `Passionate golfer with ${Math.floor(Math.random() * 10) + 2} years of experience.`,
    basePrice
  );

  return playerResult.lastInsertRowid;
});

console.log(`Created ${playerNames.length} players`);

// Assign only 2 "core" players to each team (12 total), leaving 18 for auction/draft
let playerIndex = 0;
teamIds.forEach((teamId, teamIndex) => {
  for (let i = 0; i < 2; i++) {
    const playerId = playerIds[playerIndex];
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);

    db.prepare(`
      INSERT INTO team_roster (team_id, player_id, acquisition_type, price, season)
      VALUES (?, ?, ?, ?, 1)
    `).run(teamId, playerId, 'core', player.base_price);

    // Mark player as unavailable
    db.prepare('UPDATE players SET is_available = 0 WHERE id = ?').run(playerId);

    // Deduct from team budget
    db.prepare('UPDATE teams SET budget_remaining = budget_remaining - ? WHERE id = ?')
      .run(player.base_price, teamId);

    playerIndex++;
  }
});

console.log('Assigned 2 core players to each team (18 available for auction/draft)');

// Create matches for Season 1 (Round Robin - each team plays each other once)
let matchCount = 0;
const matchDate = new Date();

for (let i = 0; i < teamIds.length; i++) {
  for (let j = i + 1; j < teamIds.length; j++) {
    const roundNumber = Math.floor(matchCount / 3) + 1;
    matchDate.setDate(matchDate.getDate() + (matchCount % 3 === 0 ? 7 : 0));

    db.prepare(`
      INSERT INTO matches (round_number, team1_id, team2_id, match_date, tee_time, venue, status, season)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      roundNumber,
      teamIds[i],
      teamIds[j],
      matchDate.toISOString().split('T')[0],
      '07:00',
      'KGA',
      matchCount < 3 ? 'completed' : matchCount < 6 ? 'live' : 'scheduled'
    );

    matchCount++;
  }
}

console.log(`Created ${matchCount} matches`);

// Add some scores for live/completed matches
const liveMatches = db.prepare("SELECT * FROM matches WHERE status IN ('live', 'completed')").all();

liveMatches.forEach(match => {
  const holesPlayed = match.status === 'completed' ? 18 : Math.floor(Math.random() * 12) + 6;

  for (let hole = 1; hole <= holesPlayed; hole++) {
    // Random result for team1
    const results = ['won', 'lost', 'squared'];
    const team1Result = results[Math.floor(Math.random() * results.length)];
    const team2Result = team1Result === 'won' ? 'lost' : team1Result === 'lost' ? 'won' : 'squared';

    db.prepare(`
      INSERT INTO match_scores (match_id, hole_number, team_id, result)
      VALUES (?, ?, ?, ?)
    `).run(match.id, hole, match.team1_id, team1Result);

    db.prepare(`
      INSERT INTO match_scores (match_id, hole_number, team_id, result)
      VALUES (?, ?, ?, ?)
    `).run(match.id, hole, match.team2_id, team2Result);
  }

  // If completed, determine winner
  if (match.status === 'completed') {
    const scores = db.prepare(`
      SELECT team_id, SUM(CASE WHEN result = 'won' THEN 1 ELSE 0 END) as wins
      FROM match_scores WHERE match_id = ? GROUP BY team_id
    `).all(match.id);

    const team1Wins = scores.find(s => s.team_id === match.team1_id)?.wins || 0;
    const team2Wins = scores.find(s => s.team_id === match.team2_id)?.wins || 0;

    const winnerId = team1Wins > team2Wins ? match.team1_id :
      team2Wins > team1Wins ? match.team2_id : null;

    db.prepare(`
      UPDATE matches SET winner_id = ?, final_result = ? WHERE id = ?
    `).run(winnerId, winnerId ? `${Math.abs(team1Wins - team2Wins)}&0` : 'Draw', match.id);
  }
});

console.log('Added scores for live/completed matches');

// Create sponsors with placeholder logos
const sponsors = [
  { name: 'Goyal & Co.', tier: 'platinum', tagline: 'Creating landmarks since 1971', color: '6366F1' },
  { name: 'Hariyana Motors', tier: 'gold', tagline: 'Drive your dreams', color: 'EF4444' },
  { name: 'KGA Properties', tier: 'gold', tagline: 'Building the future', color: '22C55E' },
  { name: 'Sunrise Hotels', tier: 'silver', tagline: 'Hospitality redefined', color: 'F59E0B' },
  { name: 'Elite Sports', tier: 'silver', tagline: 'Champions choice', color: '8B5CF6' },
  { name: 'Green Earth Foods', tier: 'bronze', tagline: 'Naturally healthy', color: '14B8A6' },
];

sponsors.forEach(sponsor => {
  // Use ui-avatars.com for placeholder logos with initials
  const initials = sponsor.name.split(' ').map(w => w[0]).join('').substring(0, 2);
  const logoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=${sponsor.color}&color=fff&size=128&bold=true`;

  db.prepare(`
    INSERT INTO sponsors (name, tier, tagline, logo_url, active) VALUES (?, ?, ?, ?, 1)
  `).run(sponsor.name, sponsor.tier, sponsor.tagline, logoUrl);
});

console.log(`Created ${sponsors.length} sponsors`);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   Database seeded successfully!                           ║
║                                                           ║
║   Test Login:                                             ║
║   - Admin: +919876543210                                  ║
║   - Owner: +919876543211 (SNC Eagles)                     ║
║   - Player: +919876543220 (Sarah Johnson)                 ║
║                                                           ║
║   In dev mode, OTP will be logged to console              ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);
