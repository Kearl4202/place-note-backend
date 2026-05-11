// =====================================================
// routes/admin-businesses.js
// CRUD for sponsored advertiser businesses.
// All endpoints require super_admin role.
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/adminAuth');

// All routes in this file require super_admin
router.use(authenticateAdmin, requireSuperAdmin);

// -----------------------------------------------------
// GET /api/admin/businesses
// List all sponsored businesses with summary counts
// -----------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { data: businesses, error } = await supabase
      .from('sponsored_businesses')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // For each business, count their ads (sponsored_notes)
    const businessesWithCounts = await Promise.all(
      (businesses || []).map(async (biz) => {
        const { count: adCount } = await supabase
          .from('sponsored_notes')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id);

        return { ...biz, ad_count: adCount || 0 };
      })
    );

    res.json({ businesses: businessesWithCounts });
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

    // Get all ads for this business
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
// Create a new sponsored business
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
// Update a sponsored business
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

    // Only update total_paid_cents if provided (avoid wiping it on regular edits)
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
// Delete a business AND cascade delete all their ads, runs, etc.
// This is a destructive action. UI must require confirmation.
// -----------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get counts of what will be deleted (for response/audit)
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
