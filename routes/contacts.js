const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');
const axios = require('axios');

const sendPushNotification = async (pushToken, title, body) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
    });
  } catch (error) {
    console.error('Error sending push notification:', error);
  }
};

// Get all contacts for a user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data: contacts, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .order('name', { ascending: true });
    if (error) throw error;
    const contactsWithGroups = await Promise.all(
      (contacts || []).map(async (contact) => {
        const { data: groupMemberships } = await supabase
          .from('contact_groups')
          .select('group_id')
          .eq('contact_id', contact.id);
        return {
          ...contact,
          groups: (groupMemberships || []).map(m => m.group_id)
        };
      })
    );
    res.json({ contacts: contactsWithGroups });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// Search users by email or phone
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { query } = req.query;
    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'Search query must be at least 3 characters' });
    }
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, phone')
      .or(`email.ilike.%${query.trim()}%,phone.ilike.%${query.trim()}%`)
      .neq('id', userId)
      .limit(10);
    if (error) throw error;
    const { data: existingContacts } = await supabase
      .from('contacts')
      .select('contact_user_id')
      .eq('user_id', userId)
      .not('contact_user_id', 'is', null);
    const existingIds = (existingContacts || []).map(c => c.contact_user_id);
    const filtered = (users || []).filter(u => !existingIds.includes(u.id));
    res.json({ users: filtered });
  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// Create a new contact
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log('📨 Creating contact:', { userId, body: req.body });
    const { name, email, phone, contact_user_id } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contact name is required' });
    }
    const limitCheck = await checkSubscriptionLimit(userId, 'contacts');
    if (!limitCheck.allowed) {
      return res.status(403).json({ 
        error: `You've reached your limit of ${limitCheck.limit} contacts. Upgrade to add more!`,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }
    const { data, error } = await supabase
      .from('contacts')
      .insert([{
        user_id: userId,
        name: name.trim(),
        email: email ? email.trim() : null,
        phone: phone ? phone.trim() : null,
        contact_user_id: contact_user_id || null,
      }])
      .select()
      .single();
    if (error) throw error;

    // Send push notification if contact_user_id provided (user found via search)
    console.log('🔔 Checking push notification for contact_user_id:', contact_user_id);
    if (contact_user_id) {
      const { data: addedUser } = await supabase
        .from('users')
        .select('push_token')
        .eq('id', contact_user_id)
        .single();
      console.log('🔔 Added user push token:', addedUser?.push_token);
      const { data: requestingUser } = await supabase
        .from('users')
        .select('name')
        .eq('id', userId)
        .single();
      console.log('🔔 Requesting user name:', requestingUser?.name);
      if (addedUser?.push_token) {
        console.log('🔔 Sending push notification...');
        await sendPushNotification(
          addedUser.push_token,
          'New Contact Request',
          `${requestingUser.name} wants to add you as a contact`
        );
        console.log('🔔 Push notification sent!');
      } else {
        console.log('🔔 No push token found, skipping notification');
      }
    }}

    res.status(201).json({ 
      message: 'Contact created successfully',
      contact: data 
    });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Update a contact
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;
    const { name, email, phone } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contact name is required' });
    }
    const { data, error } = await supabase
      .from('contacts')
      .update({
        name: name.trim(),
        email: email ? email.trim() : null,
        phone: phone ? phone.trim() : null,
      })
      .eq('id', contactId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ message: 'Contact updated successfully', contact: data });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// Delete a contact
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', contactId)
      .eq('user_id', userId);
    if (error) throw error;
    res.json({ message: 'Contact deleted successfully' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;
