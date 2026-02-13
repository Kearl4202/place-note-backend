const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { getUserSubscriptionInfo } = require('../config/subscriptions');

// Get subscription info for the authenticated user
router.get('/info', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const subscriptionInfo = await getUserSubscriptionInfo(userId);
    res.json(subscriptionInfo);
  } catch (error) {
    console.error('Error fetching subscription info:', error);
    res.status(500).json({ error: 'Failed to fetch subscription information' });
  }
});

module.exports = router;