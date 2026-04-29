// =====================================================
// routes/admin-auth.js
// Admin login endpoint - completely separate from user auth.
// Goes in: routes/ folder on Railway
// =====================================================

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/database');

// POST /api/admin/auth/login
// Logs in an admin user, returns JWT token
router.post('/login', async function(req, res) {
  try {
    const email = req.body.email;
    const password = req.body.password;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Look up admin in admin_users table (NOT the regular users table)
    const { data: admin, error } = await supabase
      .from('admin_users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !admin) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!admin.active) {
      return res.status(403).json({ error: 'This admin account has been disabled' });
    }

    // Check the password against the bcrypt hash
    const validPassword = await bcrypt.compare(password, admin.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last_login timestamp
    await supabase
      .from('admin_users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', admin.id);

    // Create admin JWT token
    // NOTE: We use 'adminId' (not 'userId') so this token can never be
    // confused with a regular user token even though they share JWT_SECRET.
    // We also use a shorter 8-hour expiry for admin sessions.
    const token = jwt.sign(
      { adminId: admin.id, email: admin.email, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token: token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/admin/auth/verify
// Used by the dashboard to check if a token is still valid on page load
router.get('/verify', async function(req, res) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ valid: false });
    }

    jwt.verify(token, process.env.JWT_SECRET, async function(err, decoded) {
      if (err || !decoded.adminId) {
        return res.status(401).json({ valid: false });
      }

      // Confirm admin still exists and is active in the database
      const { data: admin } = await supabase
        .from('admin_users')
        .select('id, email, name, role, active')
        .eq('id', decoded.adminId)
        .single();

      if (!admin || !admin.active) {
        return res.status(401).json({ valid: false });
      }

      res.json({
        valid: true,
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role }
      });
    });
  } catch (error) {
    console.error('Admin verify error:', error);
    res.status(500).json({ valid: false });
  }
});

module.exports = router;
