const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    const normalizedEmail = email.toLowerCase();
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    // Generate verification token
    const verificationToken = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // Create user
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert([
        { 
          email: normalizedEmail, 
          password: hashedPassword, 
          name, 
          phone,
          email_verified: false,
          verification_token: verificationToken,
          verification_expires: verificationExpires.toISOString()
        }
      ])
      .select()
      .single();
    if (userError) {
      return res.status(400).json({ error: userError.message });
    }
    // Log verification code
    console.log(`📧 SEND VERIFICATION EMAIL:`);
    console.log(`   To: ${normalizedEmail}`);
    console.log(`   Verification code: ${verificationToken}`);
    // Generate JWT
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email, emailVerified: false },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.status(201).json({
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        phone: newUser.phone,
        email_verified: false
      },
      requiresVerification: true,
      verificationSent: true
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save push notification token
router.post('/push-token', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { push_token } = req.body;

    if (!push_token) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    const { error } = await supabase
      .from('users')
      .update({ push_token: push_token })
      .eq('id', userId);

    if (error) throw error;

    console.log(`📱 Push token saved for user ${userId}`);
    res.json({ message: 'Push token saved successfully' });
  } catch (error) {
    console.error('Error saving push token:', error);
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

module.exports = router;
