const jwt = require('jsonwebtoken');
const { supabase } = require('../config/database');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;

    // Fire-and-forget: update last_seen without blocking the request.
    // If this fails (e.g., DB hiccup), we don't care — the request still succeeds.
    supabase
      .from('users')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', user.userId)
      .then(() => {})
      .catch(() => {});

    next();
  });
}

module.exports = { authenticateToken };
