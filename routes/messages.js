// =====================================================
// routes/messages.js
// Admin-only endpoint to send push notifications to users.
// Goes in: routes/ folder on Railway
// =====================================================

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../config/database');
const { authenticateAdmin } = require('../middleware/adminAuth');

// ============================================================
// Helper: Send a single push notification via Expo
// ============================================================
async function sendPushNotification(pushToken, body, url) {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title: 'Message from Place Note', // Hardcoded per spec
      body: body,
      sound: 'default',
      data: {
        type: 'admin_message',
        body: body,
        url: url || null
      }
    });
    return true;
  } catch (error) {
    console.error('Push send error:', error.message);
    return false;
  }
}

// ============================================================
// Helper: Get list of recipient users based on audience filter
// ============================================================
async function getRecipients(audience) {
  let query = supabase.from('users').select('id, push_token, notification_prefs, subscription_tier, created_at, last_seen');

  // Parse audience filter
  // Format examples: "all", "tier:Chief", "signup_days:30", "active_days:7"
  if (audience.startsWith('tier:')) {
    const tierName = audience.split(':')[1];
    query = query.eq('subscription_tier', tierName);
  } else if (audience.startsWith('signup_days:')) {
    const days = parseInt(audience.split(':')[1]);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', cutoff);
  } else if (audience.startsWith('active_days:')) {
    const days = parseInt(audience.split(':')[1]);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('last_seen', cutoff);
  }
  // "all" is the default - no extra filter

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching recipients:', error);
    return [];
  }
  return data || [];
}

// ============================================================
// POST /api/admin/messages/send
// Send a push notification to a group of users
// ============================================================
router.post('/send', authenticateAdmin, async function(req, res) {
  try {
    const body = (req.body.body || '').trim();
    const url = (req.body.url || '').trim();
    const audience = (req.body.audience || 'all').trim();

    // Validate
    if (!body) {
      return res.status(400).json({ error: 'Message body is required' });
    }
    if (body.length > 500) {
      return res.status(400).json({ error: 'Message body must be 500 characters or less' });
    }
    if (url && url.length > 0) {
      // Light URL validation - must start with http:// or https://
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'URL must start with http:// or https://' });
      }
    }

    // Look up recipients based on audience
    const recipients = await getRecipients(audience);
    const recipientCount = recipients.length;

    if (recipientCount === 0) {
      // Save the record anyway so admin sees it was attempted
      await supabase.from('admin_messages').insert({
        sent_by: req.admin.id,
        body: body,
        url: url || null,
        audience: audience,
        recipient_count: 0,
        sent_count: 0,
        skipped_count: 0
      });
      return res.json({
        message: 'No recipients matched the selected audience',
        recipient_count: 0,
        sent_count: 0,
        skipped_count: 0
      });
    }

    // Send to each recipient (filtering out those who opted out or have no push token)
    let sentCount = 0;
    let skippedCount = 0;

    for (const user of recipients) {
      // Skip if no push token (user never opened the app on a phone)
      if (!user.push_token) {
        skippedCount++;
        continue;
      }

      // Skip if user has opted out of tips and updates
      // notification_prefs.tips defaults to true if not set
      const tipsEnabled = user.notification_prefs?.tips !== false;
      if (!tipsEnabled) {
        skippedCount++;
        continue;
      }

      // Send it
      const success = await sendPushNotification(user.push_token, body, url);
      if (success) {
        sentCount++;
      } else {
        skippedCount++;
      }
    }

    // Save record of this send
    await supabase.from('admin_messages').insert({
      sent_by: req.admin.id,
      body: body,
      url: url || null,
      audience: audience,
      recipient_count: recipientCount,
      sent_count: sentCount,
      skipped_count: skippedCount
    });

    console.log(`Admin message sent by ${req.admin.email}: ${sentCount}/${recipientCount} delivered`);

    res.json({
      message: 'Message sent',
      recipient_count: recipientCount,
      sent_count: sentCount,
      skipped_count: skippedCount
    });
  } catch (error) {
    console.error('Send admin message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============================================================
// GET /api/admin/messages/audience-counts
// Returns how many users match each audience filter (for the compose UI)
// ============================================================
router.get('/audience-counts', authenticateAdmin, async function(req, res) {
  try {
    // Total users with push token AND tips opted in
    const { data: allUsers } = await supabase
      .from('users')
      .select('id, push_token, notification_prefs');

    const eligible = (allUsers || []).filter(u =>
      u.push_token && u.notification_prefs?.tips !== false
    );

    // Group by tier
    const { data: tierCounts } = await supabase
      .from('users')
      .select('subscription_tier');

    const tiers = {};
    (tierCounts || []).forEach(u => {
      const tier = u.subscription_tier || 'The Viewer';
      tiers[tier] = (tiers[tier] || 0) + 1;
    });

    res.json({
      total_users: (allUsers || []).length,
      eligible_users: eligible.length,
      tiers: tiers
    });
  } catch (error) {
    console.error('Audience counts error:', error);
    res.status(500).json({ error: 'Failed to fetch audience counts' });
  }
});

// ============================================================
// GET /api/admin/messages/history
// Returns the last 50 messages sent (for the dashboard log)
// ============================================================
router.get('/history', authenticateAdmin, async function(req, res) {
  try {
    const { data, error } = await supabase
      .from('admin_messages')
      .select('*, admin_users!admin_messages_sent_by_fkey(name, email)')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ messages: data || [] });
  } catch (error) {
    console.error('Message history error:', error);
    res.status(500).json({ error: 'Failed to fetch message history' });
  }
});

module.exports = router;
