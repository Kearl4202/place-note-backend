const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get chat messages for a place note
router.get('/:noteId', authenticateToken, async (req, res) => {
  try {
    const noteId = req.params.noteId;
    const { data, error } = await supabase
      .from('chat')
      .select(`*, users!chat_user_id_fkey(name)`)
      .eq('place_note_id', noteId)
      .order('timestamp', { ascending: true });
    if (error) throw error;
    const messages = (data || []).map(msg => ({
      ...msg,
      user_name: msg.users?.name || 'Unknown',
    }));
    res.json({ messages });
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
});

// Post a new chat message
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { place_note_id, message_type, content, file_url } = req.body;
    if (!place_note_id) {
      return res.status(400).json({ error: 'place_note_id is required' });
    }
    const { data, error } = await supabase
      .from('chat')
      .insert([{
        place_note_id,
        user_id: userId,
        message_type: message_type || 'text',
        content: content || null,
        file_url: file_url || null,
      }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ message: 'Message sent', chat: data });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;