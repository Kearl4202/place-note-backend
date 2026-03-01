const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Mark a note as seen (upsert last_seen_at)
router.post('/seen/:noteId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.noteId;

    const { error } = await supabase
      .from('note_last_seen')
      .upsert(
        { user_id: userId, place_note_id: noteId, last_seen_at: new Date().toISOString() },
        { onConflict: 'user_id,place_note_id' }
      );

    if (error) throw error;
    res.json({ message: 'Marked as seen' });
  } catch (error) {
    console.error('Error marking note as seen:', error);
    res.status(500).json({ error: 'Failed to mark as seen' });
  }
});

// Get unread counts for multiple notes
router.post('/unread', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { note_ids } = req.body;

    if (!note_ids || note_ids.length === 0) {
      return res.json({ unread: {} });
    }

    // Get last seen times for all requested notes
    const { data: lastSeenRecords } = await supabase
      .from('note_last_seen')
      .select('place_note_id, last_seen_at')
      .eq('user_id', userId)
      .in('place_note_id', note_ids);

    const lastSeenMap = {};
    for (const record of lastSeenRecords || []) {
      lastSeenMap[record.place_note_id] = record.last_seen_at;
    }

    // For each note, count chat messages after last_seen_at
    const unread = {};
    for (const noteId of note_ids) {
      const lastSeen = lastSeenMap[noteId];
      let query = supabase
        .from('chat')
        .select('*', { count: 'exact', head: true })
        .eq('place_note_id', noteId)
        .neq('user_id', userId);

      if (lastSeen) {
        query = query.gt('timestamp', lastSeen);
      }

      const { count } = await query;
      unread[noteId] = count || 0;
    }

    res.json({ unread });
  } catch (error) {
    console.error('Error getting unread counts:', error);
    res.status(500).json({ error: 'Failed to get unread counts' });
  }
});

module.exports = router;
