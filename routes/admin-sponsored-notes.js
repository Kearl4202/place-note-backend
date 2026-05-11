// =====================================================
// routes/admin-sponsored-notes.js
// CRUD for sponsored ads (individual ad campaigns).
// All endpoints require super_admin role.
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/adminAuth');

router.use(authenticateAdmin, requireSuperAdmin);

// -----------------------------------------------------
// GET /api/admin/sponsored-notes
// List all sponsored ads. Optional ?business_id=xxx filter.
// -----------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;

    let query = supabase
      .from('sponsored_notes')
      .select(`
        *,
        business:sponsored_businesses(id, name)
      `)
      .order('created_at', { ascending: false });

    if (business_id) {
      query = query.eq('business_id', business_id);
    }

    const { data: ads, error } = await query;

    if (error) throw error;

    res.json({ ads: ads || [] });
  } catch (error) {
    console.error('Error fetching sponsored ads:', error);
    res.status(500).json({ error: 'Failed to fetch ads' });
  }
});

// -----------------------------------------------------
// GET /api/admin/sponsored-notes/:id
// Get one ad with its run history and basic stats
// -----------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: ad, error: adError } = await supabase
      .from('sponsored_notes')
      .select(`
        *,
        business:sponsored_businesses(id, name, contact_email)
      `)
      .eq('id', id)
      .single();

    if (adError || !ad) {
      return res.status(404).json({ error: 'Sponsored ad not found' });
    }

    // Get all runs for this ad
    const { data: runs, error: runsError } = await supabase
      .from('sponsored_note_runs')
      .select('*')
      .eq('sponsored_note_id', id)
      .order('start_date', { ascending: false });

    if (runsError) throw runsError;

    // Total notification + click counts for the lifetime of this ad
    const { count: totalNotifications } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('sponsored_note_id', id);

    const { count: totalClicks } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .eq('sponsored_note_id', id);

    res.json({
      ad,
      runs: runs || [],
      stats: {
        total_notifications: totalNotifications || 0,
        total_clicks: totalClicks || 0
      }
    });
  } catch (error) {
    console.error('Error fetching sponsored ad:', error);
    res.status(500).json({ error: 'Failed to fetch ad' });
  }
});

// -----------------------------------------------------
// POST /api/admin/sponsored-notes
// Create a new sponsored ad
// -----------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const {
      business_id,
      name,
      description,
      photo_url,
      latitude,
      longitude,
      perimeter_feet,
      phone,
      website,
      business_hours
    } = req.body;

    // Required field validation
    if (!business_id) {
      return res.status(400).json({ error: 'business_id is required' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Ad name is required' });
    }
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    // Verify the business exists
    const { data: business, error: bizError } = await supabase
      .from('sponsored_businesses')
      .select('id')
      .eq('id', business_id)
      .single();

    if (bizError || !business) {
      return res.status(400).json({ error: 'Business not found' });
    }

    const { data: ad, error } = await supabase
      .from('sponsored_notes')
      .insert([{
        business_id,
        name: name.trim(),
        description: description?.trim() || null,
        photo_url: photo_url?.trim() || null,
        latitude,
        longitude,
        perimeter_feet: perimeter_feet || 500,
        phone: phone?.trim() || null,
        website: website?.trim() || null,
        business_hours: business_hours?.trim() || null,
        created_by: req.admin.id
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ ad });
  } catch (error) {
    console.error('Error creating sponsored ad:', error);
    res.status(500).json({ error: 'Failed to create ad' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/sponsored-notes/:id
// Update a sponsored ad
// -----------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      photo_url,
      latitude,
      longitude,
      perimeter_feet,
      phone,
      website,
      business_hours
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Ad name is required' });
    }

    const updates = {
      name: name.trim(),
      description: description?.trim() || null,
      photo_url: photo_url?.trim() || null,
      phone: phone?.trim() || null,
      website: website?.trim() || null,
      business_hours: business_hours?.trim() || null
    };

    if (typeof latitude === 'number') updates.latitude = latitude;
    if (typeof longitude === 'number') updates.longitude = longitude;
    if (typeof perimeter_feet === 'number') updates.perimeter_feet = perimeter_feet;

    const { data: ad, error } = await supabase
      .from('sponsored_notes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (!ad) {
      return res.status(404).json({ error: 'Sponsored ad not found' });
    }

    res.json({ ad });
  } catch (error) {
    console.error('Error updating sponsored ad:', error);
    res.status(500).json({ error: 'Failed to update ad' });
  }
});

// -----------------------------------------------------
// DELETE /api/admin/sponsored-notes/:id
// Delete an ad (cascades to runs, notifications, clicks)
// Business record is preserved.
// -----------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('sponsored_notes')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Sponsored ad deleted' });
  } catch (error) {
    console.error('Error deleting sponsored ad:', error);
    res.status(500).json({ error: 'Failed to delete ad' });
  }
});

module.exports = router;
