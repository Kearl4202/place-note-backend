const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

var sendEmail = async function(to, subject, body) {
  try {
    var response = await axios.post('https://api.resend.com/emails', {
      from: 'Place Note <' + (process.env.RESEND_FROM || 'onboarding@resend.dev') + '>',
      to: [to],
      subject: subject,
      html: '<div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">'
        + '<div style="text-align: center; margin-bottom: 20px;">'
        + '<h1 style="color: #4F46E5; margin: 0;">Place Note</h1>'
        + '<p style="color: #6B7280; margin: 5px 0 0;">Location-Based Task Manager</p>'
        + '</div>'
        + '<div style="background-color: #f9fafb; border-radius: 10px; padding: 20px; border: 1px solid #e5e7eb;">'
        + '<p style="color: #111827; font-size: 16px; line-height: 1.5;">' + body.replace(/\n/g, '<br>') + '</p>'
        + '</div>'
        + '<p style="color: #9CA3AF; font-size: 12px; text-align: center; margin-top: 20px;">This is an automated message from Place Note.</p>'
        + '</div>',
    }, {
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    console.log('Email sent to ' + to + ': ' + subject);
    return true;
  } catch (error) {
    var errMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Failed to send email to ' + to + ':', errMsg);
    return false;
  }
};

router.post('/register', async function(req, res) {
  try {
    var email = req.body.email;
    var password = req.body.password;
    var name = req.body.name;
    var phone = req.body.phone;
    var normalizedEmail = email.toLowerCase().trim();

    var { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists. Please sign in.' });
    }

    var hashedPassword = await bcrypt.hash(password, 10);
    var verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    var verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    var { data: newUser, error: userError } = await supabase
      .from('users')
      .insert([{
        email: normalizedEmail,
        password: hashedPassword,
        name: name,
        phone: phone,
        email_verified: false,
        verification_token: verificationCode,
        verification_expires: verificationExpires.toISOString()
      }])
      .select()
      .single();

    if (userError) {
      return res.status(400).json({ error: userError.message });
    }

    await sendEmail(normalizedEmail, 'Verify your Place Note account',
      'Welcome to Place Note!\n\nYour verification code is: ' + verificationCode + '\n\nThis code expires in 24 hours.');

    var token = jwt.sign(
      { userId: newUser.id, email: newUser.email, emailVerified: false },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      token: token,
      user: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name,
        phone: newUser.phone,
        email_verified: false
      },
      requiresVerification: true
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/verify-email', async function(req, res) {
  try {
    var email = req.body.email;
    var code = req.body.code;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }

    var { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email_verified) {
      return res.json({ message: 'Email already verified', verified: true });
    }

    if (user.verification_token !== code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    if (new Date(user.verification_expires) < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    await supabase
      .from('users')
      .update({ email_verified: true, verification_token: null, verification_expires: null })
      .eq('id', user.id);

    var token = jwt.sign(
      { userId: user.id, email: user.email, emailVerified: true },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      message: 'Email verified successfully!',
      verified: true,
      token: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        email_verified: true
      }
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

router.post('/resend-verification', async function(req, res) {
  try {
    var email = req.body.email;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    var { data: user, error } = await supabase
      .from('users')
      .select('id, email, email_verified')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email_verified) {
      return res.json({ message: 'Email is already verified' });
    }

    var newCode = Math.floor(100000 + Math.random() * 900000).toString();
    var newExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await supabase
      .from('users')
      .update({ verification_token: newCode, verification_expires: newExpires.toISOString() })
      .eq('id', user.id);

    await sendEmail(email, 'Your new Place Note verification code',
      'Your new verification code is: ' + newCode + '\n\nThis code expires in 24 hours.');

    res.json({ message: 'New verification code sent!' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification code' });
  }
});

router.post('/forgot-password', async function(req, res) {
  try {
    var email = req.body.email;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    var { data: user, error } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.json({ message: 'If an account exists with that email, a reset code has been sent.' });
    }

    var resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    var resetExpires = new Date(Date.now() + 60 * 60 * 1000);

    await supabase
      .from('users')
      .update({ reset_token: resetCode, reset_token_expires: resetExpires.toISOString() })
      .eq('id', user.id);

    await sendEmail(email, 'Place Note Password Reset',
      'Your password reset code is: ' + resetCode + '\n\nThis code expires in 1 hour.\n\nIf you did not request this, please ignore this email.');

    res.json({ message: 'If an account exists with that email, a reset code has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

router.post('/reset-password', async function(req, res) {
  try {
    var email = req.body.email;
    var code = req.body.code;
    var newPassword = req.body.new_password;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    var { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(400).json({ error: 'Invalid reset request' });
    }

    if (!user.reset_token || user.reset_token !== code) {
      return res.status(400).json({ error: 'Invalid reset code' });
    }

    if (new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }

    var hashedPassword = await bcrypt.hash(newPassword, 10);

    await supabase
      .from('users')
      .update({ password: hashedPassword, reset_token: null, reset_token_expires: null })
      .eq('id', user.id);

    res.json({ message: 'Password reset successfully! You can now sign in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

router.post('/login', async function(req, res) {
  try {
    var email = req.body.email;
    var password = req.body.password;

    var { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    var validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    var token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        email_verified: user.email_verified || false
      },
      requiresVerification: user.email_verified === false
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/push-token', authenticateToken, async function(req, res) {
  try {
    var userId = req.user.userId;
    var push_token = req.body.push_token;

    if (!push_token) {
      return res.status(400).json({ error: 'Push token is required' });
    }

    var { error } = await supabase
      .from('users')
      .update({ push_token: push_token })
      .eq('id', userId);

    if (error) throw error;

    console.log('Push token saved for user ' + userId);
    res.json({ message: 'Push token saved successfully' });
  } catch (error) {
    console.error('Error saving push token:', error);
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

module.exports = router;
