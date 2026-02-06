const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { generateToken } = require('../middleware/auth');
const { generateOTP, sendOTP } = require('../services/smsService');

// POST /auth/send-otp - Send OTP to phone number
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Clean phone number (keep only digits, allow + prefix)
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Delete any existing OTPs for this phone
    db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(cleanPhone);

    // Store OTP
    db.prepare(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, ?)'
    ).run(cleanPhone, otp, expiresAt.toISOString());

    // Send OTP
    const result = await sendOTP(cleanPhone, otp);

    if (result.success) {
      res.json({
        success: true,
        message: 'OTP sent successfully',
        // Include OTP in response (no real SMS provider configured)
        otp: result.otp
      });
    } else {
      res.status(500).json({ error: result.message || 'Failed to send OTP' });
    }
  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /auth/verify-otp - Verify OTP and login/register
router.post('/verify-otp', (req, res) => {
  try {
    const { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    const cleanPhone = phone.replace(/[^\d+]/g, '');

    // Find valid OTP
    const otpRecord = db.prepare(
      `SELECT * FROM otp_codes
       WHERE phone = ? AND code = ? AND verified = 0 AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    ).get(cleanPhone, otp);

    if (!otpRecord) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    // Mark OTP as verified
    db.prepare('UPDATE otp_codes SET verified = 1 WHERE id = ?').run(otpRecord.id);

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);

    if (!user) {
      // Create new user
      const result = db.prepare(
        'INSERT INTO users (phone, name, verified) VALUES (?, ?, 1)'
      ).run(cleanPhone, name || null);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    } else {
      // Update existing user
      db.prepare(
        'UPDATE users SET verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    // Generate JWT token
    const token = generateToken(user);

    // Get player info if exists
    const player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(user.id);

    // Get team info - check if user is owner, captain, or player in roster
    let team = null;

    // First check if user is a team owner or captain
    team = db.prepare(
      `SELECT * FROM teams WHERE owner_id = ? OR captain_id = ?`
    ).get(user.id, user.id);

    // If not owner/captain, check if they're a player in a roster
    if (!team && player) {
      team = db.prepare(
        `SELECT t.* FROM teams t
         JOIN team_roster tr ON t.id = tr.team_id
         WHERE tr.player_id = ?
         ORDER BY tr.season DESC LIMIT 1`
      ).get(player.id);
    }

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        photo_url: user.photo_url,
        verified: user.verified
      },
      player,
      team
    });
  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /auth/me - Get current user info
router.get('/me', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/auth');

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const player = db.prepare('SELECT * FROM players WHERE user_id = ?').get(user.id);

    // Get team info - check if user is owner, captain, or player in roster
    let team = null;

    // First check if user is a team owner or captain
    team = db.prepare(
      `SELECT * FROM teams WHERE owner_id = ? OR captain_id = ?`
    ).get(user.id, user.id);

    // If not owner/captain, check if they're a player in a roster
    if (!team && player) {
      team = db.prepare(
        `SELECT t.* FROM teams t
         JOIN team_roster tr ON t.id = tr.team_id
         WHERE tr.player_id = ?
         ORDER BY tr.season DESC LIMIT 1`
      ).get(player.id);
    }

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        photo_url: user.photo_url,
        verified: user.verified
      },
      player,
      team
    });
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
});

module.exports = router;
