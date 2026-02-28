const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');
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

const notifyAssignedUsers = async (noteId, noteName, creatorId) => {
  try {
    const { data: creator } = await supabase
      .from('users')
      .select('name')
      .eq('id', creatorId)
      .single();
    const creatorName = creator?.name || 'Someone';

    const { data: assignments } = await supabase
      .from('assignments')
      .select('user_id, group_id')
      .eq('place_note_id', noteId);

    const userIdsToNotify = new Set();

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

    userIdsToNotify.delete(creatorId);

    for (const userId of userIdsToNotify) {
      const { data: user } = await supabase
        .from('users')
        .select('push_token')
        .eq('id', userId)
        .single();
      if (user?.push_token) {
        await sendPushNotification(
          user.push_token,
          'New Place Note Assignment',
          `${creatorName} assigned you to "${noteName}"`,
          { screen: 'assigned-notes', noteId: noteId }
        );
      }
    }
  } catch (error) {
    console.error('Error notifying assigned users:', error);
  }
};

router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, latitude, longitude, perimeter_feet, assigned_contacts, assigned_groups, project_id } = req.body;
    const userId = req.user.userId;

    const limitCheck = await checkSubscriptionLimit(userId, 'notes');
    if (!limitCheck.allowed) {
      return res.status(403).json({
        error: `You've reached your limit of ${limitCheck.limit} place notes. Upgrade to add more!`,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }

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

    if (assigned_contacts && assigned_contacts.length > 0) {
      const contactAssignments = assigned_contacts.map(contactId => ({
        place_note_id: data.id,
        user_id: contactId,
        group_id: null,
      }));
      await supabase.from('assignments').insert(contactAssignments);
    }

    if (assigned_groups && assigned_groups.length > 0) {
      const groupAssignments = assigned_groups.map(groupId => ({
        place_note_id: data.id,
        user_id: null,
        group_id: groupId,
      }));
      await supabase.from('assignments').insert(groupAssignments);
    }

    if ((assigned_contacts && assigned_contacts.length > 0) || (assigned_groups && assigned_groups.length > 0)) {
      await notifyAssignedUsers(data.id, data.name, userId);
    }

    res.status(201).json({ message: 'Place note created successfully', placeNote: data });
  } catch (error) {
    console.error('Error creating place note:', error);
    res.status(500).json({ error: error.message || 'Failed to create place note' });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data, error } = await supabase
      .from('place_notes')
      .select(`*, users!place_notes_creator_id_fkey (name)`)
      .eq('creator_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ placeNotes: data });
  } catch (error) {
    console.error('Error fetching place notes:', error);
    res.status(500).json({ error: 'Failed to fetch place notes' });
  }
});

router.get('/assigned-to-me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

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
      return res.json({ placeNotes: [] });
    }

    const { data: notes, error } = await supabase
      .from('place_notes')
      .select(`*, users!place_notes_creator_id_fkey (name)`)
      .in('id', Array.from(assignedNoteIds))
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ placeNotes: notes || [] });
  } catch (error) {
    console.error('Error fetching assigned notes:', error);
    res.status(500).json({ error: 'Failed to fetch assigned notes' });
  }
});

router.get('/assignments/:noteId', authenticateToken, async (req, res) => {
  try {
    const noteId = req.params.noteId;
    const { data, error } = await supabase
      .from('assignments')
      .select('id, user_id, group_id')
      .eq('place_note_id', noteId);
    if (error) throw error;

    const assignments = data || [];
    const contactIds = assignments.filter(a => a.user_id).map(a => a.user_id);
    const groupIds = assignments.filter(a => a.group_id).map(a => a.group_id);

    let contacts = [];
    let groups = [];

    if (contactIds.length > 0) {
      const { data: contactData } = await supabase
        .from('contacts')
        .select('id, name, email, status')
        .in('id', contactIds);
      contacts = contactData || [];
    }

    if (groupIds.length > 0) {
      const { data: groupData } = await supabase
        .from('groups')
        .select('id, name')
        .in('id', groupIds);
      groups = groupData || [];

      for (const group of groups) {
        const { data: members } = await supabase
          .from('contact_groups')
          .select('contact_id, contacts!inner(status)')
          .eq('group_id', group.id)
          .eq('contacts.status', 'active');
        group.memberCount = members ? members.length : 0;
        group.memberIds = members ? members.map(m => m.contact_id) : [];
      }
    }

    const enriched = assignments.map(a => ({
      ...a,
      contacts: a.user_id ? contacts.find(c => c.id === a.user_id) || null : null,
      groups: a.group_id ? groups.find(g => g.id === a.group_id) || null : null,
    }));

    res.json({ assignments: enriched });
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

router.get('/:id/snapshot', authenticateToken, async (req, res) => {
  try {
    const noteId = req.params.id;
    const { data, error } = await supabase
      .from('assignment_snapshots')
      .select('*')
      .eq('place_note_id', noteId)
      .order('archived_at', { ascending: false });
    if (error) throw error;
    res.json({ snapshot: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch snapshot' });
  }
});

router.put('/:id/archive', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;

    const { data: assignments } = await supabase
      .from('assignments')
      .select('user_id, group_id')
      .eq('place_note_id', noteId);

    const snapshot = [];
    for (const a of assignments || []) {
      if (a.user_id) {
        const { data: contact } = await supabase
          .from('contacts')
          .select('name, email, status')
          .eq('id', a.user_id)
          .single();
        if (contact && contact.status === 'active') {
          snapshot.push({ name: contact.name, email: contact.email, via_group: null });
        }
      }
      if (a.group_id) {
        const { data: group } = await supabase
          .from('groups')
          .select('name')
          .eq('id', a.group_id)
          .single();
        const { data: members } = await supabase
          .from('contact_groups')
          .select('contact_id, contacts!inner(name, email, status)')
          .eq('group_id', a.group_id)
          .eq('contacts.status', 'active');
        for (const member of members || []) {
          snapshot.push({ name: member.contacts.name, email: member.contacts.email, via_group: group?.name || null });
        }
      }
    }

    const seen = new Map();
    for (const person of snapshot) {
      if (!seen.has(person.email) || person.via_group) {
        seen.set(person.email, person);
      }
    }
    const deduped = Array.from(seen.values());

    await supabase.from('assignment_snapshots').insert({
      place_note_id: noteId,
      contacts: deduped,
    });

    const { data, error } = await supabase
      .from('place_notes')
      .update({ status: 'archived' })
      .eq('id', noteId)
      .eq('creator_id', userId)
      .select()
      .single();

    if (error) throw error;
    res.json({ message: 'Note archived successfully', placeNote: data });
  } catch (error) {
    console.error('Error archiving note:', error);
    res.status(500).json({ error: 'Failed to archive note' });
  }
});

router.put('/:id/restore', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;

    const limitCheck = await checkSubscriptionLimit(userId, 'notes');
    if (!limitCheck.allowed) {
      return res.status(403).json({
        error: `You have reached your limit of ${limitCheck.limit} active place notes. Archive or delete a note before restoring.`
      });
    }

    const { data, error } = await supabase
      .from('place_notes')
      .update({ status: 'active' })
      .eq('id', noteId)
      .eq('creator_id', userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ message: 'Note restored successfully', placeNote: data });
  } catch (error) {
    console.error('Error restoring note:', error);
    res.status(500).json({ error: 'Failed to restore note' });
  }
});

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

router.put('/:id/assignments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const noteId = req.params.id;
    const { contact_ids, group_ids } = req.body;

    const { data: note, error: noteError } = await supabase
      .from('place_notes')
      .select('*')
      .eq('id', noteId)
      .eq('creator_id', userId)
      .single();

    if (noteError || !note) {
      return res.status(404).json({ error: 'Note not found or unauthorized' });
    }

    await supabase.from('assignments').delete().eq('place_note_id', noteId);

    if (contact_ids && contact_ids.length > 0) {
      const contactAssignments = contact_ids.map(contactId => ({
        place_note_id: noteId,
        user_id: contactId,
        group_id: null,
      }));
      await supabase.from('assignments').insert(contactAssignments);
    }

    if (group_ids && group_ids.length > 0) {
      const groupAssignments = group_ids.map(groupId => ({
        place_note_id: noteId,
        user_id: null,
        group_id: groupId,
      }));
      await supabase.from('assignments').insert(groupAssignments);
    }

    if ((contact_ids && contact_ids.length > 0) || (group_ids && group_ids.length > 0)) {
      await notifyAssignedUsers(noteId, note.name, userId);
    }

    res.json({ message: 'Assignments updated successfully' });
  } catch (error) {
    console.error('Error updating assignments:', error);
    res.status(500).json({ error: 'Failed to update assignments' });
  }
});

module.exports = router;
