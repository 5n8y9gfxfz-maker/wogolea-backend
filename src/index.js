require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { initializeDatabase } = require('./database');

// Initialize database
initializeDatabase();

const app = express();
const server = http.createServer(app);

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Make io accessible to routes
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());

// Request logging (development)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
  });
}

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/teams', require('./routes/teams'));
app.use('/players', require('./routes/players'));
app.use('/matches', require('./routes/matches'));
app.use('/auction', require('./routes/auction'));
app.use('/draft', require('./routes/draft'));
app.use('/sponsors', require('./routes/sponsors'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API info
app.get('/', (req, res) => {
  res.json({
    name: 'WGL API',
    version: '1.0.0',
    description: "Women's Golf League Backend API",
    endpoints: {
      auth: '/auth/send-otp, /auth/verify-otp, /auth/me',
      users: '/users',
      teams: '/teams, /teams/:id, /teams/:id/roster',
      players: '/players, /players/available, /players/:id',
      matches: '/matches, /matches/live, /matches/:id, /matches/:id/score',
      auction: '/auction/state, /auction/start, /auction/bid, /auction/sold',
      draft: '/draft/status, /draft/start, /draft/pick',
      sponsors: '/sponsors'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Track connected auction participants: { odifyerId -> { odifyerId, name, teamId, teamName, role } }
const auctionParticipants = new Map();

// Broadcast current participants to auction room
function broadcastAuctionParticipants() {
  const participants = Array.from(auctionParticipants.values());
  io.to('auction').emit('auction:participants', participants);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Join match room for live updates
  socket.on('match:join', (matchId) => {
    socket.join(`match-${matchId}`);
    console.log(`${socket.id} joined match-${matchId}`);
  });

  socket.on('match:leave', (matchId) => {
    socket.leave(`match-${matchId}`);
    console.log(`${socket.id} left match-${matchId}`);
  });

  // Join auction/draft room with user info
  socket.on('auction:join', (userData) => {
    socket.join('auction');
    console.log(`${socket.id} joined auction room`, userData);

    // Track participant if they have team info
    if (userData && userData.teamId) {
      auctionParticipants.set(socket.id, {
        odifyerId: socket.id,
        userId: userData.userId,
        name: userData.name || 'Unknown',
        teamId: userData.teamId,
        teamName: userData.teamName || 'Unknown Team',
        role: userData.role || 'member' // 'owner', 'captain', 'member'
      });
      broadcastAuctionParticipants();
    }
  });

  socket.on('auction:leave', () => {
    socket.leave('auction');
    console.log(`${socket.id} left auction room`);
    if (auctionParticipants.has(socket.id)) {
      auctionParticipants.delete(socket.id);
      broadcastAuctionParticipants();
    }
  });

  socket.on('draft:join', () => {
    socket.join('draft');
    console.log(`${socket.id} joined draft room`);
  });

  socket.on('draft:leave', () => {
    socket.leave('draft');
    console.log(`${socket.id} left draft room`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Remove from auction participants if present
    if (auctionParticipants.has(socket.id)) {
      auctionParticipants.delete(socket.id);
      broadcastAuctionParticipants();
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   WGL Backend Server                                      ║
║   Running on http://localhost:${PORT}                        ║
║                                                           ║
║   Endpoints:                                              ║
║   - REST API: http://localhost:${PORT}/                      ║
║   - WebSocket: ws://localhost:${PORT}                        ║
║   - Health: http://localhost:${PORT}/health                  ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, server, io };
