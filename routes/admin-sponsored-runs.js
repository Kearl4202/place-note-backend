// =====================================================
// routes/admin-sponsored-runs.js
// Manage ad campaign runs (start, pause, resume, end).
// All endpoints require super_admin role.
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/adminAuth');

router.use(authenticateAdmin, requireSuperAdmin);

// -----------------------------------------------------
// GET /api/admin/sponsored-runs
// List all runs. Optional ?sponsored_note_id=xxx filter.
// -----------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { sponsored_note_id, status } = req.query;

    let query = supabase
      .from('sponsored_note_runs')
      .select(`
        *,
        sponsored_note:sponsored_notes(id, name, business_id)
      `)
      .order('start_date', { ascending: false });

    if (sponsored_note_id) {
      query = query.eq('sponsored_note_id', sponsored_note_id);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data: runs, error } = await query;

    if (error) throw error;

    res.json({ runs: runs || [] });
  } catch (error) {
    console.error('Error fetching runs:', error);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// -----------------------------------------------------
// GET /api/admin/sponsored-runs/:id
// Get one run with detailed stats
// -----------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: run, error: runError } = await supabase
      .from('sponsored_note_runs')
      .select(`
        *,
        sponsored_note:sponsored_notes(id, name, business_id, business:sponsored_businesses(id, name))
      `)
      .eq('id', id)
      .single();

    if (runError || !run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    // Stats for this specific run
    const { count: notificationCount } = await supabase
      .from('sponsored_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', id);

    const { count: clickCount } = await supabase
      .from('sponsored_clicks')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', id);

    res.json({
      run,
      stats: {
        notifications: notificationCount || 0,
        clicks: clickCount || 0,
        click_rate: notificationCount > 0 ? ((clickCount / notificationCount) * 100).toFixed(2) : 0
      }
    });
  } catch (error) {
    console.error('Error fetching run:', error);
    res.status(500).json({ error: 'Failed to fetch run' });
  }
});

// -----------------------------------------------------
// POST /api/admin/sponsored-runs
// Start a new run for an ad
// -----------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { sponsored_note_id, start_date, end_date } = req.body;

    if (!sponsored_note_id) {
      return res.status(400).json({ error: 'sponsored_note_id is required' });
    }

    // Verify ad exists
    const { data: ad, error: adError } = await supabase
      .from('sponsored_notes')
      .select('id')
      .eq('id', sponsored_note_id)
      .single();

    if (adError || !ad) {
      return res.status(400).json({ error: 'Sponsored ad not found' });
    }

    // Default start_date to now if not provided
    const runStart = start_date ? new Date(start_date) : new Date();

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .insert([{
        sponsored_note_id,
        start_date: runStart.toISOString(),
        end_date: end_date ? new Date(end_date).toISOString() : null,
        status: 'active'
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ run });
  } catch (error) {
    console.error('Error starting run:', error);
    res.status(500).json({ error: 'Failed to start run' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/sponsored-runs/:id/pause
// Pause an active run
// -----------------------------------------------------
router.put('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .update({ status: 'paused' })
      .eq('id', id)
      .eq('status', 'active') // Can only pause if currently active
      .select()
      .single();

    if (error) throw error;

    if (!run) {
      return res.status(404).json({ error: 'Run not found or not active' });
    }

    res.json({ run });
  } catch (error) {
    console.error('Error pausing run:', error);
    res.status(500).json({ error: 'Failed to pause run' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/sponsored-runs/:id/resume
// Resume a paused run
// -----------------------------------------------------
router.put('/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .update({ status: 'active' })
      .eq('id', id)
      .eq('status', 'paused') // Can only resume if currently paused
      .select()
      .single();

    if (error) throw error;

    if (!run) {
      return res.status(404).json({ error: 'Run not found or not paused' });
    }

    res.json({ run });
  } catch (error) {
    console.error('Error resuming run:', error);
    res.status(500).json({ error: 'Failed to resume run' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/sponsored-runs/:id/end
// End a run permanently. Sets end_date to now.
// -----------------------------------------------------
router.put('/:id/end', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .update({
        status: 'ended',
        end_date: new Date().toISOString()
      })
      .eq('id', id)
      .neq('status', 'ended') // Can't re-end an already-ended run
      .select()
      .single();

    if (error) throw error;

    if (!run) {
      return res.status(404).json({ error: 'Run not found or already ended' });
    }

    res.json({ run });
  } catch (error) {
    console.error('Error ending run:', error);
    res.status(500).json({ error: 'Failed to end run' });
  }
});

// -----------------------------------------------------
// DELETE /api/admin/sponsored-runs/:id
// Hard delete a run (cleanup only). Cascades to notifications + clicks.
// -----------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('sponsored_note_runs')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Run deleted' });
  } catch (error) {
    console.error('Error deleting run:', error);
    res.status(500).json({ error: 'Failed to delete run' });
  }
});

module.exports = router;
