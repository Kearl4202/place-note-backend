const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const sendPushNotification = async (pushToken, title, body, data = {}) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
      data,
    });
  } catch (error) {
    console.error('🔔 Error sending push notification:', error.message);
  }
};

const notifyAssignedUsersAboutChange = async (noteId, senderUserId, changeDescription) => {
  try {
    const { data: note } = await supabase
      .from('place_notes')
      .select('name, creator_id')
      .eq('id', noteId)
      .single();
    if (!note) return;

    const { data: sender } = await supabase
      .from('users')
      .select('name')
      .eq('id', senderUserId)
      .single();
    const senderName = sender?.name || 'Someone';

    const { data: assignments } = await supabase
      .from('assignments')
      .select('user_id, group_id')
      .eq('place_note_id', noteId);

    const userIdsToNotify = new Set();

    if (note.creator_id !== senderUserId) {
      userIdsToNotify.add(note.creator_id);
    }

    for (const a of assignments || []) {
      if (a.user_id) {
        const { data: contact } = await supabase
          .from('contacts')
          .select('contact_user_id')
          .eq('id', a.user_id)
          .eq('status', 'active')
          .single();
        if (contact?.contact_user_id) {
          userIdsToNotify.add(contact.contact_user_id);
        }
      }
      if (a.group_id) {
        const { data: members } = await supabase
          .from('contact_groups')
          .select('contact_id, contacts!inner(contact_user_id, status)')
          .eq('group_id', a.group_id)
          .eq('contacts.status', 'active');
        for (const member of members || []) {
          if (member.contacts?.contact_user_id) {
            userIdsToNotify.add(member.contacts.contact_user_id);
          }
        }
      }
    }

    userIdsToNotify.delete(senderUserId);

    console.log('📍 Notifying', userIdsToNotify.size, 'users about change to:', note.name);

    for (const userId of userIdsToNotify) {
      const { data: user } = await supabase
        .from('users')
        .select('push_token')
        .eq('id', userId)
        .single();
      if (user?.push_token) {
        await sendPushNotification(
          user.push_token,
          `Update: ${note.name}`,
          `${senderName} ${changeDescription}`,
          { screen: 'assigned-notes', noteId: noteId }
        );
      }
    }
  } catch (error) {
    console.error('Error notifying about change:', error);
  }
};

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

    await notifyAssignedUsersAboutChange(place_note_id, userId, 'added a text tag — tap to see it');

    res.status(201).json({ message: 'Message sent', chat: data });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

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

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('place-note-files')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from('place-note-files')
      .getPublicUrl(fileName);
    const fileUrl = urlData.publicUrl;

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

    const typeLabel = message_type === 'document' ? 'added a document' : 'added a photo';
    await notifyAssignedUsersAboutChange(place_note_id, userId, `${typeLabel} — tap to see it`);

    res.status(201).json({ message: 'File uploaded', chat: data, file_url: fileUrl });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

module.exports = router;
