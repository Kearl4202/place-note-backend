const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const axios = require('axios');

const sendPushNotification = async (pushToken, title, body, data = {}) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data,
    });
  } catch (error) {
    console.error('🔔 Error sending push notification:', error.message);
  }
};

function distanceInFeet(lat1, lon1, lat2, lon2) {
  const R = 20902231;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

router.post('/check', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { latitude, longitude } = req.body;

    console.log('📍 Location check from user:', userId, 'at', latitude, longitude);

    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const { data: myContactRecords } = await supabase
      .from('contacts')
      .select('id')
      .eq('contact_user_id', userId)
      .eq('status', 'active');

    const myContactIds = (myContactRecords || []).map(c => c.id);

    const { data: myGroupMemberships } = await supabase
      .from('contact_groups')
      .select('group_id')
      .in('contact_id', myContactIds.length > 0 ? myContactIds : ['none']);

    const myGroupIds = (myGroupMemberships || []).map(m => m.group_id);

    let assignedNoteIds = new Set();

    if (myContactIds.length > 0) {
      const { data: directAssignments } = await supabase
        .from('assignments')
        .select('place_note_id')
        .in('user_id', myContactIds);
      for (const a of directAssignments || []) {
        assignedNoteIds.add(a.place_note_id);
      }
    }

    if (myGroupIds.length > 0) {
      const { data: groupAssignments } = await supabase
        .from('assignments')
        .select('place_note_id')
        .in('group_id', myGroupIds);
      for (const a of groupAssignments || []) {
        assignedNoteIds.add(a.place_note_id);
      }
    }

    if (assignedNoteIds.size === 0) {
      console.log('📍 No assigned notes for user:', userId);
      return res.json({ inside: [], message: 'No assigned notes' });
    }

    const { data: notes } = await supabase
      .from('place_notes')
      .select('id, name, latitude, longitude, perimeter_feet')
      .in('id', Array.from(assignedNoteIds))
      .eq('status', 'active');

    if (!notes || notes.length === 0) {
      console.log('📍 No active assigned notes for user:', userId);
      return res.json({ inside: [], message: 'No active assigned notes' });
    }

    console.log('📍 Checking', notes.length, 'notes for user:', userId);

    const insideNotes = [];
    const outsideNoteIds = [];

    for (const note of notes) {
      const dist = distanceInFeet(
        latitude, longitude,
        parseFloat(note.latitude), parseFloat(note.longitude)
      );
      console.log('📍 Distance to', note.name, ':', Math.round(dist), 'ft, perimeter:', note.perimeter_feet, 'ft');
      if (dist <= note.perimeter_feet) {
        insideNotes.push(note);
      } else {
        outsideNoteIds.push(note.id);
      }
    }

    if (outsideNoteIds.length > 0) {
      await supabase
        .from('geofence_notifications')
        .delete()
        .eq('user_id', userId)
        .in('place_note_id', outsideNoteIds);
    }

    const notifiedNotes = [];
    for (const note of insideNotes) {
      const { data: existing } = await supabase
        .from('geofence_notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('place_note_id', note.id)
        .single();

      if (!existing) {
        notifiedNotes.push(note);
        await supabase
          .from('geofence_notifications')
          .insert({ user_id: userId, place_note_id: note.id });
      }
    }

    if (notifiedNotes.length > 0) {
      const { data: user } = await supabase
        .from('users')
        .select('push_token, notification_prefs')
        .eq('id', userId)
        .single();

      if (user?.push_token) {
        var prefs = user.notification_prefs || { geofence: true, tags: true, contacts: true };
        if (prefs.geofence === false) {
          console.log('Skipping geofence notification for', userId, '- geofence notifications disabled');
        } else {
          for (const note of notifiedNotes) {
            console.log('📍 User entered perimeter of:', note.name);
            await sendPushNotification(
              user.push_token,
              '📍 You arrived at a Place Note!',
              `You're near "${note.name}" — tap to check it out`,
              { screen: 'assigned-notes', noteId: note.id }
            );
          }
        }
      }
    }

    res.json({
      inside: insideNotes.map(n => n.name),
      newlyNotified: notifiedNotes.map(n => n.name),
    });
  } catch (error) {
    console.error('Error checking location:', error);
    res.status(500).json({ error: 'Failed to check location' });
  }
});

router.post('/geofence-register', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log('📍 Geofence register request from user:', userId);

    const { data: myContacts } = await supabase
      .from('contacts')
      .select('id')
      .eq('contact_user_id', userId)
      .eq('status', 'active');
    const myContactIds = (myContacts || []).map(c => c.id);

    let assignedNoteIds = new Set();
    if (myContactIds.length > 0) {
      const { data: directAssignments } = await supabase
        .from('assignments')
        .select('place_note_id')
        .in('user_id', myContactIds);
      for (const a of directAssignments || []) {
        assignedNoteIds.add(a.place_note_id);
      }

      const { data: myGroupMemberships } = await supabase
        .from('contact_groups')
        .select('group_id')
        .in('contact_id', myContactIds);
      const myGroupIds = (myGroupMemberships || []).map(m => m.group_id);

      if (myGroupIds.length > 0) {
        const { data: groupAssignments } = await supabase
          .from('assignments')
          .select('place_note_id')
          .in('group_id', myGroupIds);
        for (const a of groupAssignments || []) {
          assignedNoteIds.add(a.place_note_id);
        }
      }
    }

    const { data: selfAssignments } = await supabase
      .from('assignments')
      .select('place_note_id')
      .eq('self_assigned', true)
      .eq('self_user_id', userId);
    const selfAssignedNoteIds = new Set((selfAssignments || []).map(a => a.place_note_id));

    let myNotes = [];
    if (selfAssignedNoteIds.size > 0) {
      const { data: sNotes } = await supabase
        .from('place_notes')
        .select('id, name, latitude, longitude, perimeter_feet, status')
        .in('id', Array.from(selfAssignedNoteIds))
        .eq('creator_id', userId)
        .eq('status', 'active');
      myNotes = sNotes || [];
    }

    let assignedNotes = [];
    if (assignedNoteIds.size > 0) {
      const { data: aNotes } = await supabase
        .from('place_notes')
        .select('id, name, latitude, longitude, perimeter_feet, status')
        .in('id', Array.from(assignedNoteIds))
        .eq('status', 'active');
      assignedNotes = aNotes || [];
    }

    const allNotes = [...assignedNotes, ...(myNotes || [])];
    const uniqueNotes = allNotes.filter((note, index, self) =>
      note.latitude && note.longitude && note.perimeter_feet &&
      index === self.findIndex(n => n.id === note.id)
    );

    console.log('📍 Found', uniqueNotes.length, 'notes to geofence for user:', userId);
    for (const n of uniqueNotes) {
      console.log('📍  -', n.name, '(', n.latitude, ',', n.longitude, ') perimeter:', n.perimeter_feet, 'ft');
    }

    res.json({ regions: uniqueNotes });
  } catch (error) {
    console.error('📍 Error in geofence-register:', error);
    res.status(500).json({ error: 'Failed to fetch geofence regions' });
  }
});

router.post('/geofence-enter', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { noteId } = req.body;

    console.log('📍 Native geofence ENTER for note:', noteId, 'by user:', userId);

    if (!noteId) {
      return res.status(400).json({ error: 'noteId is required' });
    }

    const { data: note } = await supabase
      .from('place_notes')
      .select('id, name, creator_id, latitude, longitude')
      .eq('id', noteId)
      .eq('status', 'active')
      .single();

    if (!note) {
      return res.json({ notified: false, message: 'Note not found or inactive' });
    }

    // Clean up old notifications older than 4 hours
    try {
      await supabase
        .from('geofence_notifications')
        .delete()
        .eq('user_id', userId)
        .eq('place_note_id', noteId)
        .lt('notified_at', new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());
    } catch (cleanErr) {}

    // Check if already notified
    const { data: existing } = await supabase
      .from('geofence_notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('place_note_id', noteId);

    if (existing && existing.length > 0) {
      console.log('📍 Already notified for', note.name, ', skipping');
      return res.json({ notified: false, message: 'Already notified recently' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('push_token, notification_prefs')
      .eq('id', userId)
      .single();

    if (!user || !user.push_token) {
      return res.json({ notified: false, message: 'No push token' });
    }

    const prefs = user.notification_prefs || {};
    if (prefs.geofence === false) {
      console.log('📍 User has geofence notifications disabled, skipping');
      return res.json({ notified: false, message: 'Geofence notifications disabled' });
    }

    const isCreator = note.creator_id === userId;
    const screen = isCreator ? 'home' : 'assigned-notes';

    await sendPushNotification(
      user.push_token,
      '📍 You arrived at a Place Note!',
      `You are near "${note.name}"`,
      { screen: screen, noteId: note.id }
    );

    await supabase
      .from('geofence_notifications')
      .insert({
        user_id: userId,
        place_note_id: noteId,
      });

    console.log('📍 Geofence notification sent for:', note.name, '(screen:', screen, ')');
    return res.json({ notified: true, noteName: note.name });

  } catch (error) {
    console.error('Error in geofence-enter:', error);
    res.status(500).json({ error: 'Failed to process geofence enter' });
  }
});

module.exports = router;
