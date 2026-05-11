// =====================================================
// routes/admin-sponsored-runs.js
// Manage ad campaign runs (schedule, pause, resume, end).
// All endpoints require super_admin role.
// =====================================================

const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateAdmin, requireSuperAdmin } = require('../middleware/adminAuth');

router.use(authenticateAdmin, requireSuperAdmin);

// Helper: parse a date string (e.g., "2026-07-15") into UTC midnight
function parseDateStart(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) return null;
  return d;
}
// Helper: parse a date string into END of that day in UTC (23:59:59)
function parseDateEnd(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T23:59:59.999Z');
  if (isNaN(d.getTime())) return null;
  return d;
}

// -----------------------------------------------------
// GET /api/admin/sponsored-runs
// List all runs. Optional ?sponsored_note_id=xxx filter and ?status=xxx
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
// Schedule a new run. start_date AND end_date REQUIRED.
// Status is 'scheduled' if start is future, 'active' if today/past.
// -----------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { sponsored_note_id, start_date, end_date } = req.body;

    if (!sponsored_note_id) {
      return res.status(400).json({ error: 'sponsored_note_id is required' });
    }
    if (!start_date) {
      return res.status(400).json({ error: 'start_date is required (YYYY-MM-DD)' });
    }
    if (!end_date) {
      return res.status(400).json({ error: 'end_date is required (YYYY-MM-DD)' });
    }

    const start = parseDateStart(start_date);
    const end = parseDateEnd(end_date);

    if (!start || !end) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    if (end < start) {
      return res.status(400).json({ error: 'end_date must be after start_date' });
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

    // Decide status: 'scheduled' if start is in future, 'active' if today/past
    const now = new Date();
    const status = start > now ? 'scheduled' : 'active';

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .insert([{
        sponsored_note_id,
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        status
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ run });
  } catch (error) {
    console.error('Error scheduling run:', error);
    res.status(500).json({ error: 'Failed to schedule run' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/sponsored-runs/:id/edit-dates
// Update start/end dates on an existing run (only if scheduled or active).
// -----------------------------------------------------
router.put('/:id/edit-dates', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.body;

    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required' });
    }

    const start = parseDateStart(start_date);
    const end = parseDateEnd(end_date);

    if (!start || !end) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    if (end < start) {
      return res.status(400).json({ error: 'end_date must be after start_date' });
    }

    // Fetch current to check it's not ended
    const { data: existing, error: fetchErr } = await supabase
      .from('sponsored_note_runs')
      .select('id, status')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (existing.status === 'ended') {
      return res.status(400).json({ error: 'Cannot edit dates on an ended run' });
    }

    // Recompute status based on new dates
    const now = new Date();
    let newStatus = existing.status;
    if (existing.status === 'scheduled' && start <= now) {
      newStatus = 'active';
    } else if (existing.status === 'active' && start > now) {
      newStatus = 'scheduled';
    }

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .update({
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        status: newStatus
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.json({ run });
  } catch (error) {
    console.error('Error editing dates:', error);
    res.status(500).json({ error: 'Failed to edit dates' });
  }
});

// -----------------------------------------------------
// PUT /api/admin/sponsored-runs/:id/pause
// -----------------------------------------------------
router.put('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .update({ status: 'paused' })
      .eq('id', id)
      .eq('status', 'active')
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
// Resume a paused run. If end_date has already passed, set to 'ended' instead.
// -----------------------------------------------------
router.put('/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchErr } = await supabase
      .from('sponsored_note_runs')
      .select('id, status, end_date')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Run not found' });
    }
    if (existing.status !== 'paused') {
      return res.status(400).json({ error: 'Only paused runs can be resumed' });
    }

    const now = new Date();
    const endDate = existing.end_date ? new Date(existing.end_date) : null;
    const newStatus = (endDate && endDate < now) ? 'ended' : 'active';

    const { data: run, error } = await supabase
      .from('sponsored_note_runs')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

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
      .neq('status', 'ended')
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
