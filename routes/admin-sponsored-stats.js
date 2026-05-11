// =====================================================
// routes/admin-sponsored-stats.js
// Analytics endpoints for sponsored ads dashboard.
// All endpoints require admin auth (any admin can VIEW stats).
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateAdmin } = require('../middleware/adminAuth');

// Stats are read-only — any admin can view (not just super_admin)
router.use(authenticateAdmin);

// -----------------------------------------------------
// GET /api/admin/sponsored-stats/overview
// Top-level dashboard numbers
// -----------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Total businesses
    const { count: totalBusinesses } = await supabase
      .from('sponsored_businesses')
      .select('id', { count: 'exact', head: true });

    // Total ads
    const { count: totalAds } = await supabase
      .from('sponsored_notes')
      .select('id', { count: 'exact', head: true });

    // Active runs right now
    const { count: activeRuns } = await supabase
      .from('sponsored_note_runs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    // Notifications today
    const { count: notificationsToday } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .gte('notified_at', startOfToday);

    // Notifications last 7 days
    const { count: notifications7d } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .gte('notified_at', sevenDaysAgo);

    // Notifications last 30 days
    const { count: notifications30d } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .gte('notified_at', thirtyDaysAgo);

    // Clicks today
    const { count: clicksToday } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .gte('clicked_at', startOfToday);

    // Clicks last 7 days
    const { count: clicks7d } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .gte('clicked_at', sevenDaysAgo);

    // Clicks last 30 days
    const { count: clicks30d } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .gte('clicked_at', thirtyDaysAgo);

    // Total revenue (sum of total_paid_cents across all businesses)
    const { data: revData } = await supabase
      .from('sponsored_businesses')
      .select('total_paid_cents');

    const totalRevenueCents = (revData || []).reduce(
      (sum, b) => sum + (b.total_paid_cents || 0),
      0
    );

    res.json({
      businesses: totalBusinesses || 0,
      ads: totalAds || 0,
      active_runs: activeRuns || 0,
      notifications: {
        today: notificationsToday || 0,
        last_7_days: notifications7d || 0,
        last_30_days: notifications30d || 0
      },
      clicks: {
        today: clicksToday || 0,
        last_7_days: clicks7d || 0,
        last_30_days: clicks30d || 0
      },
      total_revenue_cents: totalRevenueCents
    });
  } catch (error) {
    console.error('Error fetching overview stats:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// -----------------------------------------------------
// GET /api/admin/sponsored-stats/business/:business_id
// Stats for one business across all their ads
// -----------------------------------------------------
router.get('/business/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    // Verify business exists
    const { data: business, error: bizError } = await supabase
      .from('sponsored_businesses')
      .select('id, name, total_paid_cents')
      .eq('id', business_id)
      .single();

    if (bizError || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Get all ad IDs for this business
    const { data: ads } = await supabase
      .from('sponsored_notes')
      .select('id')
      .eq('business_id', business_id);

    const adIds = (ads || []).map(a => a.id);

    if (adIds.length === 0) {
      return res.json({
        business,
        ad_count: 0,
        notifications: { total: 0 },
        clicks: { total: 0 }
      });
    }

    // Total notifications across all their ads
    const { count: totalNotifs } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .in('sponsored_note_id', adIds);

    // Total clicks across all their ads
    const { count: totalClicks } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .in('sponsored_note_id', adIds);

    res.json({
      business,
      ad_count: adIds.length,
      notifications: { total: totalNotifs || 0 },
      clicks: { total: totalClicks || 0 },
      click_rate: totalNotifs > 0 ? ((totalClicks / totalNotifs) * 100).toFixed(2) : 0
    });
  } catch (error) {
    console.error('Error fetching business stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// -----------------------------------------------------
// GET /api/admin/sponsored-stats/ad/:ad_id
// Stats for one specific ad with breakdown by run
// -----------------------------------------------------
router.get('/ad/:ad_id', async (req, res) => {
  try {
    const { ad_id } = req.params;

    const { data: ad, error: adError } = await supabase
      .from('sponsored_notes')
      .select('id, name')
      .eq('id', ad_id)
      .single();

    if (adError || !ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const { count: totalNotifs } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('sponsored_note_id', ad_id);

    const { count: totalClicks } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .eq('sponsored_note_id', ad_id);

    // Unique users notified
    const { data: uniqueUsersData } = await supabase
      .from('sponsored_notifications')
      .select('user_id')
      .eq('sponsored_note_id', ad_id);

    const uniqueUsers = new Set((uniqueUsersData || []).map(n => n.user_id)).size;

    res.json({
      ad,
      notifications: { total: totalNotifs || 0 },
      clicks: { total: totalClicks || 0 },
      unique_users_notified: uniqueUsers,
      click_rate: totalNotifs > 0 ? ((totalClicks / totalNotifs) * 100).toFixed(2) : 0
    });
  } catch (error) {
    console.error('Error fetching ad stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// -----------------------------------------------------
// GET /api/admin/sponsored-stats/recent-activity
// Last 100 notifications + clicks (for live feed)
// -----------------------------------------------------
router.get('/recent-activity', async (req, res) => {
  try {
    const { data: recentNotifs } = await supabase
      .from('sponsored_notifications')
      .select(`
        id,
        notified_at,
        user_id,
        sponsored_note:sponsored_notes(id, name)
      `)
      .order('notified_at', { ascending: false })
      .limit(50);

    const { data: recentClicks } = await supabase
      .from('sponsored_clicks')
      .select(`
        id,
        clicked_at,
        user_id,
        sponsored_note:sponsored_notes(id, name)
      `)
      .order('clicked_at', { ascending: false })
      .limit(50);

    res.json({
      recent_notifications: recentNotifs || [],
      recent_clicks: recentClicks || []
    });
  } catch (error) {
    console.error('Error fetching recent activity:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
});

module.exports = router;
