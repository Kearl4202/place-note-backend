const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

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

// Post a text message
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

// Upload a file (photo or document)
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const userId = req.user.userId;
    const { place_note_id, message_type } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    if (!place_note_id) {
      return res.status(400).json({ error: 'place_note_id is required' });
    }

    const file = req.file;
    const ext = path.extname(file.originalname) || '';
    const fileName = `${place_note_id}/${Date.now()}_${userId}${ext}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('place-note-files')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('place-note-files')
      .getPublicUrl(fileName);

    const fileUrl = urlData.publicUrl;

    // Save message to chat table
    const { data, error } = await supabase
      .from('chat')
      .insert([{
        place_note_id,
        user_id: userId,
        message_type: message_type || 'photo',
        content: file.originalname,
        file_url: fileUrl,
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'File uploaded', chat: data, file_url: fileUrl });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

module.exports = router;
