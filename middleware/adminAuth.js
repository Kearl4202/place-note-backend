// =====================================================
// middleware/adminAuth.js
// Verifies admin JWT tokens on protected routes.
// Goes in: middleware/ folder on Railway
// =====================================================

const jwt = require('jsonwebtoken');
const { supabase } = require('../config/database');

// Use this middleware on any admin-only API route
// It does three things:
//   1. Verifies the JWT signature
//   2. Confirms the token has 'adminId' (not 'userId') - so user tokens get rejected
//   3. Looks up the admin in the database and confirms they're still active
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Admin access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async function(err, decoded) {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired admin token' });
    }

    // Reject tokens that aren't admin tokens (e.g., regular user tokens)
    if (!decoded.adminId) {
      return res.status(403).json({ error: 'Not an admin token' });
    }

    try {
      // Always look up fresh data - in case the admin was disabled mid-session
      const { data: admin, error } = await supabase
        .from('admin_users')
        .select('id, email, name, role, active')
        .eq('id', decoded.adminId)
        .single();

      if (error || !admin) {
        return res.status(403).json({ error: 'Admin account not found' });
      }

      if (!admin.active) {
        return res.status(403).json({ error: 'Admin account disabled' });
      }

      // Attach admin info to req so route handlers can use it
      req.admin = admin;
      next();
    } catch (error) {
      console.error('Admin auth error:', error);
      return res.status(500).json({ error: 'Authentication failed' });
    }
  });
}

// Optional helper: use this AFTER authenticateAdmin to require super_admin role
// Example route: router.delete('/', authenticateAdmin, requireSuperAdmin, handler)
function requireSuperAdmin(req, res, next) {
  if (!req.admin || req.admin.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = { authenticateAdmin, requireSuperAdmin };
