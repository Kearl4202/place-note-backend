// =====================================================
// routes/admin-businesses.js
// CRUD for sponsored advertiser businesses.
// All endpoints require super_admin role.
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/adminAuth');

router.use(authenticateAdmin, requireSuperAdmin);

// Helper: derive a single "top_status" for a business from all its ads' runs.
// Priority: active > paused > scheduled > ended > none
function deriveTopStatus(adsWithRuns) {
  if (!adsWithRuns || adsWithRuns.length === 0) return 'none';

  let hasActive = false;
  let hasPaused = false;
  let hasScheduled = false;
  let hasEnded = false;

  for (const ad of adsWithRuns) {
    const runs = ad.runs || [];
    if (runs.some(r => r.status === 'active')) hasActive = true;
    else if (runs.some(r => r.status === 'paused')) hasPaused = true;
    else if (runs.some(r => r.status === 'scheduled')) hasScheduled = true;
    else if (runs.some(r => r.status === 'ended')) hasEnded = true;
  }

  if (hasActive) return 'active';
  if (hasPaused) return 'paused';
  if (hasScheduled) return 'scheduled';
  if (hasEnded) return 'ended';
  return 'none';
}

// -----------------------------------------------------
// GET /api/admin/businesses
// List all sponsored businesses with ad count + top status
// -----------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { data: businesses, error } = await supabase
      .from('sponsored_businesses')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // For each business, count their ads and derive top status
    const businessesWithDetails = await Promise.all(
      (businesses || []).map(async (biz) => {
        const { data: ads } = await supabase
          .from('sponsored_notes')
          .select('id, runs:sponsored_note_runs(status)')
          .eq('business_id', biz.id);

        const adList = ads || [];
        return {
          ...biz,
          ad_count: adList.length,
          top_status: deriveTopStatus(adList)
        };
      })
    );

    res.json({ businesses: businessesWithDetails });
  } catch (error) {
    console.error('Error fetching businesses:', error);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// -----------------------------------------------------
// GET /api/admin/businesses/:id
// Get one business with their ads
// -----------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: business, error: bizError } = await supabase
      .from('sponsored_businesses')
      .select('*')
      .eq('id', id)
      .single();

    if (bizError || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const { data: ads, error: adsError } = await supabase
      .from('sponsored_notes')
      .select('*')
      .eq('business_id', id)
      .order('created_at', { ascending: false });

    if (adsError) throw adsError;

    res.json({ business, ads: ads || [] });
  } catch (error) {
    console.error('Error fetching business:', error);
    res.status(500).json({ error: 'Failed to fetch business' });
  }
});

// -----------------------------------------------------
// POST /api/admin/businesses
// -----------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const {
      name,
      contact_name,
      contact_email,
      contact_phone,
      address,
      notes,
      total_paid_cents
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Business name is required' });
    }

    const { data: business, error } = await supabase
      .from('sponsored_businesses')
      .insert([{
        name: name.trim(),
        contact_name: contact_name?.trim() || null,
        contact_email: contact_email?.trim() || null,
        contact_phone: contact_phone?.trim() || null,
        address: address?.trim() || null,
        notes: notes?.trim() || null,
        total_paid_cents: total_paid_cents || 0,
        created_by: req.admin.id
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ business });
  } catch (error) {
    console.error('Error creating business:', error);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/businesses/:id
// -----------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      contact_name,
      contact_email,
      contact_phone,
      address,
      notes,
      total_paid_cents
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Business name is required' });
    }

    const updates = {
      name: name.trim(),
      contact_name: contact_name?.trim() || null,
      contact_email: contact_email?.trim() || null,
      contact_phone: contact_phone?.trim() || null,
      address: address?.trim() || null,
      notes: notes?.trim() || null
    };

    if (typeof total_paid_cents === 'number') {
      updates.total_paid_cents = total_paid_cents;
    }

    const { data: business, error } = await supabase
      .from('sponsored_businesses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    res.json({ business });
  } catch (error) {
    console.error('Error updating business:', error);
    res.status(500).json({ error: 'Failed to update business' });
  }
});

// -----------------------------------------------------
// DELETE /api/admin/businesses/:id
// -----------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { count: adCount } = await supabase
      .from('sponsored_notes')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', id);

    const { error } = await supabase
      .from('sponsored_businesses')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({
      success: true,
      message: 'Business deleted',
      deleted_ad_count: adCount || 0
    });
  } catch (error) {
    console.error('Error deleting business:', error);
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

module.exports = router;
