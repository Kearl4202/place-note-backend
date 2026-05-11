// =====================================================
// routes/sponsored-user.js
// User-facing endpoints for sponsored ads.
// Mobile app calls these to fetch active ads and log events.
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// All routes require user auth
router.use(authenticateToken);

// -----------------------------------------------------
// GET /api/sponsored/active
// Returns active sponsored ads the user is eligible to see.
// Filters out:
//   - Users who opted out of business_deals notifications
//   - Ads where this user has already seen 1+ notifications today
//   - Ads where this user has already seen 2+ notifications in last 7 days
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
      // User has not opted in to business deals — return empty list
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
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Get notification counts per ad for this user
    const { data: userNotifs } = await supabase
      .from('sponsored_notifications')
      .select('sponsored_note_id, notified_at')
      .eq('user_id', userId)
      .gte('notified_at', sevenDaysAgo);

    // Build per-ad counters
    const todayCounts = {};
    const weekCounts = {};
    for (const notif of (userNotifs || [])) {
      const adId = notif.sponsored_note_id;
      weekCounts[adId] = (weekCounts[adId] || 0) + 1;
      if (notif.notified_at >= startOfToday) {
        todayCounts[adId] = (todayCounts[adId] || 0) + 1;
      }
    }

    // Filter ads by frequency cap and shape response
    const eligible = activeRuns
      .filter(run => {
        if (!run.sponsored_note) return false;
        const adId = run.sponsored_note.id;
        if ((todayCounts[adId] || 0) >= 1) return false;
        if ((weekCounts[adId] || 0) >= 2) return false;
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
// Records that this user was notified about this ad.
// Used for frequency caps and analytics.
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

    const { error } = await supabase
      .from('sponsored_notifications')
      .insert([{
        sponsored_note_id,
        run_id,
        user_id: userId
      }]);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    console.error('Error logging notification:', error);
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
