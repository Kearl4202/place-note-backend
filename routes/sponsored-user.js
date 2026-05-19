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
// NOTE: Frequency caps are NOT applied here. They are applied
// at notification time in /log-notification. This keeps every
// sponsored geofence registered on the phone so it always fires
// on entry; the cap then decides whether a push is actually sent.
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

    // Return ALL active ads (no frequency cap filtering here).
    // This ensures the sponsored geofence stays registered on the
    // phone so it reliably fires the moment the user arrives.
    const ads = activeRuns
      .filter(run => !!run.sponsored_note)
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

    res.json({ ads: ads, opted_in: true });
  } catch (error) {
    console.error('Error fetching active sponsored ads:', error);
    res.status(500).json({ error: 'Failed to fetch sponsored ads' });
  }
});

// -----------------------------------------------------
// POST /api/sponsored/log-notification
// Body: { sponsored_note_id, run_id }
// Called when a sponsored geofence is entered.
// Applies the per-ad frequency cap (per user):
//   - Max 1 push per day for the same ad
//   - Max 2 pushes per 7 days for the same ad
// If under the cap: logs the notification + sends the push.
// If at the cap: sends nothing, logs nothing, returns success.
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

    // ---- Per-ad frequency cap check (per user) ----
    // Count how many times THIS ad has notified THIS user
    // today and in the last 7 days.
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: adNotifs } = await supabase
      .from('sponsored_notifications')
      .select('notified_at')
      .eq('user_id', userId)
      .eq('sponsored_note_id', sponsored_note_id)
      .gte('notified_at', sevenDaysAgo);

    let todayCount = 0;
    let weekCount = 0;
    for (const notif of (adNotifs || [])) {
      weekCount += 1;
      if (notif.notified_at >= startOfToday) {
        todayCount += 1;
      }
    }

    // If the per-ad cap is reached, skip silently (no log, no push).
    if (todayCount >= 1 || weekCount >= 2) {
      console.log('🔔 Sponsored push skipped (frequency cap reached) for user:', userId, 'ad:', sponsored_note_id);
      return res.json({ success: true, capped: true });
    }

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

      // Log to DB only when a push is actually sent
      // (analytics + frequency cap tracking)
      const { error: logErr } = await supabase
        .from('sponsored_notifications')
        .insert([{
          sponsored_note_id,
          run_id,
          user_id: userId
        }]);

      if (logErr) throw logErr;

      console.log('🔔 Sponsored push sent for:', ad.name, 'to user:', userId);
      return res.json({ success: true, capped: false });
    } else {
      console.log('🔔 Sponsored push skipped (no push_token, opted out, or ad missing) for user:', userId);
      return res.json({ success: true, capped: false });
    }
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
    res.status(500).json({ error: 'Failed to log click' });
  }
});

module.exports = router;
