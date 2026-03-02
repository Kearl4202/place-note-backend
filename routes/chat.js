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

const sendPushNotification = async (pushToken, title, body, data) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title: title,
      body: body,
      sound: 'default',
      data: data || {},
    });
  } catch (error) {
    console.error('Error sending push:', error.message);
  }
};

const notifyAssignedUsersAboutChange = async (noteId, senderUserId, changeDescription) => {
  try {
    const { data: note } = await supabase
      .from('place_notes')
      .select('name, creator_id, created_at')
      .eq('id', noteId)
      .single();
    if (!note) return;

    var noteAge = Date.now() - new Date(note.created_at).getTime();
    if (noteAge < 30000) {
      console.log('Skipping tag notification - note just created', noteAge, 'ms ago');
      return;
    }

    const { data: sender } = await supabase
      .from('users')
      .select('name')
      .eq('id', senderUserId)
      .single();
    var senderName = sender ? sender.name : 'Someone';

    const { data: assignments } = await supabase
      .from('assignments')
      .select('user_id, group_id')
      .eq('place_note_id', noteId);

    var assignedUserIds = new Set();

    for (var i = 0; i < (assignments || []).length; i++) {
      var a = assignments[i];
      if (a.user_id) {
        const { data: contact } = await supabase
          .from('contacts')
          .select('contact_user_id')
          .eq('id', a.user_id)
          .eq('status', 'active')
          .single();
        if (contact && contact.contact_user_id) {
          assignedUserIds.add(contact.contact_user_id);
        }
      }
      if (a.group_id) {
        const { data: members } = await supabase
          .from('contact_groups')
          .select('contact_id, contacts!inner(contact_user_id, status)')
          .eq('group_id', a.group_id)
          .eq('contacts.status', 'active');
        for (var j = 0; j < (members || []).length; j++) {
          if (members[j].contacts && members[j].contacts.contact_user_id) {
            assignedUserIds.add(members[j].contacts.contact_user_id);
          }
        }
      }
    }

    var allUserIds = new Set(assignedUserIds);
    var creatorId = note.creator_id;
    if (String(creatorId) !== String(senderUserId)) {
      allUserIds.add(creatorId);
    }

    allUserIds.delete(senderUserId);

    console.log('Notifying', allUserIds.size, 'users about change to:', note.name);
    console.log('Creator ID:', creatorId);

    for (var notifyUserId of allUserIds) {
      const { data: user } = await supabase
        .from('users')
        .select('push_token, notification_prefs')
        .eq('id', notifyUserId)
        .single();
      if (user && user.push_token) {
        // Check notification preferences
        var prefs = user.notification_prefs || { geofence: true, tags: true, contacts: true };
        if (prefs.tags === false) {
          console.log('Skipping notification for', notifyUserId, '- tags notifications disabled');
          continue;
        }
        var isCreator = String(notifyUserId) === String(creatorId);
        var screen = isCreator ? 'home' : 'assigned-notes';
        console.log('Sending to', notifyUserId, 'screen:', screen, 'isCreator:', isCreator);
        await sendPushNotification(
          user.push_token,
          'Update: ' + note.name,
          senderName + ' ' + changeDescription,
          { screen: screen, noteId: noteId }
        );
      }
    }
  } catch (error) {
    console.error('Error notifying about change:', error);
  }
};

router.get('/:noteId', authenticateToken, async (req, res) => {
  try {
    var noteId = req.params.noteId;
    const { data, error } = await supabase
      .from('chat')
      .select('*, users!chat_user_id_fkey(name)')
      .eq('place_note_id', noteId)
      .order('timestamp', { ascending: true });
    if (error) throw error;
    var messages = (data || []).map(function(msg) {
      return {
        id: msg.id,
        place_note_id: msg.place_note_id,
        user_id: msg.user_id,
        message_type: msg.message_type,
        content: msg.content,
        file_url: msg.file_url,
        timestamp: msg.timestamp,
        user_name: msg.users ? msg.users.name : 'Unknown',
      };
    });
    res.json({ messages: messages });
  } catch (error) {
    console.error('Error fetching chat:', error);
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    var userId = req.user.userId;
    var place_note_id = req.body.place_note_id;
    var message_type = req.body.message_type;
    var content = req.body.content;
    var file_url = req.body.file_url;
    if (!place_note_id) {
      return res.status(400).json({ error: 'place_note_id is required' });
    }
    const { data, error } = await supabase
      .from('chat')
      .insert([{
        place_note_id: place_note_id,
        user_id: userId,
        message_type: message_type || 'text',
        content: content || null,
        file_url: file_url || null,
      }])
      .select()
      .single();
    if (error) throw error;

    await notifyAssignedUsersAboutChange(place_note_id, userId, 'added a text tag - tap to see it');

    res.status(201).json({ message: 'Message sent', chat: data });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    var userId = req.user.userId;
    var place_note_id = req.body.place_note_id;
    var message_type = req.body.message_type;
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    if (!place_note_id) {
      return res.status(400).json({ error: 'place_note_id is required' });
    }
    var file = req.file;
    var ext = path.extname(file.originalname) || '';
    var fileName = place_note_id + '/' + Date.now() + '_' + userId + ext;

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
    var fileUrl = urlData.publicUrl;

    const { data, error } = await supabase
      .from('chat')
      .insert([{
        place_note_id: place_note_id,
        user_id: userId,
        message_type: message_type || 'photo',
        content: file.originalname,
        file_url: fileUrl,
      }])
      .select()
      .single();
    if (error) throw error;

    var typeLabel = message_type === 'document' ? 'added a document' : 'added a photo';
    await notifyAssignedUsersAboutChange(place_note_id, userId, typeLabel + ' - tap to see it');

    res.status(201).json({ message: 'File uploaded', chat: data, file_url: fileUrl });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

module.exports = router;
