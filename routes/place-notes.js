const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');

// Create a new place note
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, latitude, longitude, perimeter_feet, trigger_on_entry, trigger_on_exit, is_active, assigned_contacts, assigned_groups, project_id } = req.body;
    const userId = req.user.userId;

    // Check subscription limits
    const limitCheck = await checkSubscriptionLimit(userId, 'notes');
    if (!limitCheck.allowed) {
      return res.status(403).json({ 
        error: `You've reached your limit of ${limitCheck.limit} place notes. Upgrade to add more!`,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }

    // Create the place note
    const { data, error } = await supabase
      .from('place_notes')
      .insert([{
        creator_id: userId,
        name,
        description,
        latitude,
        longitude,
        perimeter_feet: perimeter_feet || 500,
        project_id: project_id || null,
        status: 'active',
      }])
      .select()
      .single();

    if (error) throw error;

    // Create assignments if contacts or groups were selected
    const allContactIds = new Set([...(assigned_contacts || [])]);

    // If groups were selected, get all contacts from those groups
    if (assigned_groups && assigned_groups.length > 0) {
      for (const groupId of assigned_groups) {
        const { data: groupMembers } = await supabase
          .from('contact_groups')
          .select('contact_id')
          .eq('group_id', groupId);
        
        if (groupMembers) {
          groupMembers.forEach(member => allContactIds.add(member.contact_id));
        }
      }
    }

    // Create assignments for all unique contacts
    if (allContactIds.size > 0) {
      const assignments = Array.from(allContactIds).map(contactId => ({
        place_note_id: data.id,
        user_id: contactId,
      }));

      const { error: assignError } = await supabase
        .from('assignments')
        .insert(assignments);

      if (assignError) {
        console.error('Error creating assignments:', assignError);
      }
    }

    res.status(201).json({
      message: 'Place note created successfully',
      placeNote: data
    });
  } catch (error) {
    console.error('Error creating place note:', error);
    res.status(500).json({ error: error.message || 'Failed to create place note' });
  }
});

// Get all place notes for the authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data, error } = await supabase
      .from('place_notes')
      .select(`
        *,
        users!place_notes_creator_id_fkey (
          name
        )
      `)
      .eq('creator_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ placeNotes: data });

  } catch (error) {
    console.error('Error fetching place notes:', error);
    res.status(500).json({ error: 'Failed to fetch place notes' });
  }
});

// Get assignments for a place note
router.get('/assignments/:noteId', authenticateToken, async (req, res) => {
  try {
    const noteId = req.params.noteId;
    
    const { data, error } = await supabase
      .from('assignments')
      .select('user_id, contacts(id, name, email, phone)')
      .eq('place_note_id', noteId);
    
    if (error) throw error;
    
    res.json({ assignments: data || [] });
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Archive a place note
router.put('/:id/archive', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;

    const { data, error } = await supabase
      .from('place_notes')
      .update({ status: 'archived' })
      .eq('id', noteId)
      .eq('creator_id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      message: 'Note archived successfully',
      placeNote: data 
    });
  } catch (error) {
    console.error('Error archiving note:', error);
    res.status(500).json({ error: 'Failed to archive note' });
  }
});

// Restore a place note
router.put('/:id/restore', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;

    const { data, error } = await supabase
      .from('place_notes')
      .update({ status: 'active' })
      .eq('id', noteId)
      .eq('creator_id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      message: 'Note restored successfully',
      placeNote: data 
    });
  } catch (error) {
    console.error('Error restoring note:', error);
    res.status(500).json({ error: 'Failed to restore note' });
  }
});

// Delete a place note permanently
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;

    const { error } = await supabase
      .from('place_notes')
      .delete()
      .eq('id', noteId)
      .eq('creator_id', userId);

    if (error) throw error;

    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Update assignments for a place note
router.put('/:id/assignments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;
    const { contact_ids, group_ids } = req.body;

    // Verify the note belongs to the user
    const { data: note, error: noteError } = await supabase
      .from('place_notes')
      .select('*')
      .eq('id', noteId)
      .eq('creator_id', userId)
      .single();

    if (noteError || !note) {
      return res.status(404).json({ error: 'Note not found or unauthorized' });
    }

    // Delete existing assignments
    await supabase
      .from('assignments')
      .delete()
      .eq('place_note_id', noteId);

    // Collect all contact IDs (individuals + from groups)
    const allContactIds = new Set([...(contact_ids || [])]);

    if (group_ids && group_ids.length > 0) {
      for (const groupId of group_ids) {
        const { data: groupMembers } = await supabase
          .from('contact_groups')
          .select('contact_id')
          .eq('group_id', groupId);
        
        if (groupMembers) {
          groupMembers.forEach(member => allContactIds.add(member.contact_id));
        }
      }
    }

    if (allContactIds.size > 0) {
      const assignments = Array.from(allContactIds).map(contactId => ({
        place_note_id: noteId,
        user_id: contactId,
      }));

      await supabase
        .from('assignments')
        .insert(assignments);
    }

    res.json({ message: 'Assignments updated successfully' });
  } catch (error) {
    console.error('Error updating assignments:', error);
    res.status(500).json({ error: 'Failed to update assignments' });
  }
});

module.exports = router;
