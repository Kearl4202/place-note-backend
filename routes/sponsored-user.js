// =====================================================
// routes/sponsored-user.js
// User-facing endpoints for sponsored ads.
// Mobile app calls these to fetch active ads and log events.
// =====================================================

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// All routes require user auth
router.use(authenticateToken);

// -----------------------------------------------------
// Frequency cap config.
// TESTING: 4-hour cooldown per ad per user (lets you re-test more easily).
// PRODUCTION: change back to daily/weekly caps when going live.
//   - For production, this constant goes away and the cap logic in BOTH
//     GET /active and POST /log-notification reverts to:
//       ≥1 today → skip, ≥2 this week → skip
// -----------------------------------------------------
const SPONSORED_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

// Send a push notification via Expo Push API (same pattern as routes/location.js)
const sendPushNotification = async (pushToken, title, body, data = {}) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data,
    });
  } catch (error) {
    console.error('🔔 Error sending sponsored push:', error.message);
  }
};

// -----------------------------------------------------
// GET /api/sponsored/active
// Returns active sponsored ads the user is eligible to see.
// Filters out:
//   - Users who opted out of business_deals notifications
//   - Ads where this user has been notified within the cooldown window
// Mobile app caches this and does geofence checks locally.
// -----------------------------------------------------
router.get('/active', async (req, res) => {
  try {
    const userId = req.user.userId;

    // Check if user has opted in to business_deals
    const { data: user } = await supabase
      .from('users')
      .select('notification_prefs')
      .eq('id', userId)
      .single();

    const prefs = user?.notification_prefs || {};
    if (prefs.business_deals !== true) {
      return res.json({ ads: [], opted_in: false });
    }

    // Get all currently-active runs and their ads
    const { data: activeRuns, error: runsError } = await supabase
      .from('sponsored_note_runs')
      .select(`
        id,
        sponsored_note_id,
        start_date,
        end_date,
        sponsored_note:sponsored_notes(
          id,
          name,
          description,
          photo_url,
          latitude,
          longitude,
          perimeter_feet,
          phone,
          website,
          business_hours,
          business:sponsored_businesses(id, name)
        )
      `)
      .eq('status', 'active');

    if (runsError) throw runsError;

    if (!activeRuns || activeRuns.length === 0) {
      return res.json({ ads: [], opted_in: true });
    }

    // Frequency cap: check this user's notification history
    // TESTING: 4-hour cooldown per ad. Skip ads notified within the cooldown window.
    const cooldownStart = new Date(Date.now() - SPONSORED_COOLDOWN_MS).toISOString();

    const { data: userNotifs } = await supabase
      .from('sponsored_notifications')
      .select('sponsored_note_id')
      .eq('user_id', userId)
      .gte('notified_at', cooldownStart);

    const recentlyNotified = new Set();
    for (const notif of (userNotifs || [])) {
      recentlyNotified.add(notif.sponsored_note_id);
    }

    const eligible = activeRuns
      .filter(run => {
        if (!run.sponsored_note) return false;
        if (recentlyNotified.has(run.sponsored_note.id)) return false;
        return true;
      })
      .map(run => ({
        run_id: run.id,
        sponsored_note_id: run.sponsored_note.id,
        name: run.sponsored_note.name,
        description: run.sponsored_note.description,
        photo_url: run.sponsored_note.photo_url,
        latitude: run.sponsored_note.latitude,
        longitude: run.sponsored_note.longitude,
        perimeter_feet: run.sponsored_note.perimeter_feet,
        phone: run.sponsored_note.phone,
        website: run.sponsored_note.website,
        business_hours: run.sponsored_note.business_hours,
        business_name: run.sponsored_note.business ? run.sponsored_note.business.name : null
      }));

    res.json({ ads: eligible, opted_in: true });
  } catch (error) {
    console.error('Error fetching active sponsored ads:', error);
    res.status(500).json({ error: 'Failed to fetch sponsored ads' });
  }
});

// -----------------------------------------------------
// POST /api/sponsored/log-notification
// Body: { sponsored_note_id, run_id }
// Authoritative gate for sponsored pushes.
// Enforces 4-hour per-ad cooldown (TESTING) — skip if notified recently.
// Only logs to DB and sends push if cooldown NOT active.
// Returns { success: true, pushed: true|false, reason? }.
// -----------------------------------------------------
router.post('/log-notification', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sponsored_note_id, run_id } = req.body;

    if (!sponsored_note_id || !run_id) {
      return res.status(400).json({ error: 'sponsored_note_id and run_id are required' });
    }

    // Verify the run is still active (don't log if it ended)
    const { data: run } = await supabase
      .from('sponsored_note_runs')
      .select('id, status')
      .eq('id', run_id)
      .single();

    if (!run || run.status !== 'active') {
      return res.status(400).json({ error: 'Run is not active' });
    }

    // -----------------------------------------------------
    // TESTING: 4-hour cooldown per ad per user.
    // Mirrors the filter logic in GET /active so both endpoints agree.
    // -----------------------------------------------------
    const cooldownStart = new Date(Date.now() - SPONSORED_COOLDOWN_MS).toISOString();

    const { data: priorNotifs } = await supabase
      .from('sponsored_notifications')
      .select('notified_at')
      .eq('user_id', userId)
      .eq('sponsored_note_id', sponsored_note_id)
      .gte('notified_at', cooldownStart)
      .limit(1);

    if (priorNotifs && priorNotifs.length > 0) {
      console.log('🔔 Sponsored push SKIPPED (within 4hr cooldown) for ad:', sponsored_note_id, 'user:', userId);
      return res.json({ success: true, pushed: false, reason: 'cooldown_active' });
    }

    // Cap NOT hit — log to DB (counts toward future cap checks)
    const { error: logErr } = await supabase
      .from('sponsored_notifications')
      .insert([{
        sponsored_note_id,
        run_id,
        user_id: userId
      }]);

    if (logErr) throw logErr;

    // Fetch the ad details for the push notification content
    const { data: ad } = await supabase
      .from('sponsored_notes')
      .select(`
        id,
        name,
        description,
        photo_url,
        latitude,
        longitude,
        perimeter_feet,
        phone,
        website,
        business_hours,
        business:sponsored_businesses(id, name)
      `)
      .eq('id', sponsored_note_id)
      .single();

    // Fetch user's push token and prefs
    const { data: user } = await supabase
      .from('users')
      .select('push_token, notification_prefs')
      .eq('id', userId)
      .single();

    const prefs = user?.notification_prefs || {};

    // Only push if user has opted in and has a push_token
    if (ad && user && user.push_token && prefs.business_deals === true) {
      const businessName = ad.business ? ad.business.name : null;
      const adPayload = {
        sponsored_note_id: ad.id,
        run_id: run_id,
        business_name: businessName,
        name: ad.name,
        description: ad.description,
        photo_url: ad.photo_url,
        latitude: ad.latitude,
        longitude: ad.longitude,
        perimeter_feet: ad.perimeter_feet,
        phone: ad.phone,
        website: ad.website,
        business_hours: ad.business_hours,
      };

      await sendPushNotification(
        user.push_token,
        ad.name || 'Nearby Business',
        'Sponsored Ad from Place Note',
        {
          type: 'sponsored_ad',
          ad: adPayload,
        }
      );
      console.log('🔔 Sponsored push sent for:', ad.name, 'to user:', userId);
    } else {
      console.log('🔔 Sponsored push skipped (no push_token, opted out, or ad missing) for user:', userId);
    }

    res.json({ success: true, pushed: true });
  } catch (error) {
    console.error('Error logging sponsored notification:', error);
    res.status(500).json({ error: 'Failed to log notification' });
  }
});

// -----------------------------------------------------
// POST /api/sponsored/log-click
// Body: { sponsored_note_id, run_id }
// Records that this user clicked/tapped the sponsored ad overlay.
// -----------------------------------------------------
router.post('/log-click', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { sponsored_note_id, run_id } = req.body;

    if (!sponsored_note_id || !run_id) {
      return res.status(400).json({ error: 'sponsored_note_id and run_id are required' });
    }

    const { error } = await supabase
      .from('sponsored_clicks')
      .insert([{
        sponsored_note_id,
        run_id,
        user_id: userId
      }]);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error logging click:', error);
    res.status(500).json({ error: 'Failed to log notification' });
  }
});

module.exports = router;
