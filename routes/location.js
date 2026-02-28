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
      return res.json({ inside: [], message: 'No assigned notes' });
    }

    const { data: notes } = await supabase
      .from('place_notes')
      .select('id, name, latitude, longitude, perimeter_feet')
      .in('id', Array.from(assignedNoteIds))
      .eq('status', 'active');

    if (!notes || notes.length === 0) {
      return res.json({ inside: [], message: 'No active assigned notes' });
    }

    const insideNotes = [];
    const outsideNoteIds = [];

    for (const note of notes) {
      const dist = distanceInFeet(
        latitude, longitude,
        parseFloat(note.latitude), parseFloat(note.longitude)
      );
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
        .select('push_token')
        .eq('id', userId)
        .single();

      if (user?.push_token) {
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

    res.json({
      inside: insideNotes.map(n => n.name),
      newlyNotified: notifiedNotes.map(n => n.name),
    });
  } catch (error) {
    console.error('Error checking location:', error);
    res.status(500).json({ error: 'Failed to check location' });
  }
});

module.exports = router;
