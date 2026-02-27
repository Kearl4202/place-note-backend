const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');
const axios = require('axios');

const sendPushNotification = async (pushToken, title, body) => {
  try {
    console.log('🔔 Attempting to send push to:', pushToken);
    const response = await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
    });
    console.log('🔔 Push API response:', JSON.stringify(response.data));
  } catch (error) {
    console.error('🔔 Error sending push notification:', error.message);
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

// Get incoming contact requests (people who want to add ME)
router.get('/requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log('📥 Fetching incoming requests for user:', userId);

    const { data: requests, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('contact_user_id', userId)
      .eq('status', 'invited');

    if (error) throw error;

    const requestsWithInfo = await Promise.all(
      (requests || []).map(async (request) => {
        const { data: requester } = await supabase
          .from('users')
          .select('id, name, email, phone')
          .eq('id', request.user_id)
          .single();
        return {
          id: request.id,
          requester_id: request.user_id,
          requester_name: requester?.name || 'Unknown',
          requester_email: requester?.email || '',
          requester_phone: requester?.phone || '',
          created_at: request.created_at,
        };
      })
    );

    console.log('📥 Found', requestsWithInfo.length, 'incoming requests');
    res.json({ requests: requestsWithInfo });
  } catch (error) {
    console.error('Error fetching requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
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
    const { name, email, phone, contact_user_id } = req.body;
    console.log('📨 Creating contact:', { userId, name, contact_user_id });

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
        status: contact_user_id ? 'invited' : 'active',
      }])
      .select()
      .single();
    if (error) throw error;

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
    }

    res.status(201).json({ 
      message: 'Contact created successfully',
      contact: data 
    });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Accept a contact request — simple accept, no add-back
router.put('/:id/accept', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;
    console.log('✅ Accepting contact request:', contactId);

    const { data: contact, error: fetchError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('contact_user_id', userId)
      .eq('status', 'invited')
      .single();

    if (fetchError || !contact) {
      return res.status(404).json({ error: 'Contact request not found' });
    }

    const { error: updateError } = await supabase
      .from('contacts')
      .update({ status: 'active' })
      .eq('id', contactId);

    if (updateError) throw updateError;

    // Notify the requester
    const { data: requesterUser } = await supabase
      .from('users')
      .select('push_token')
      .eq('id', contact.user_id)
      .single();

    const { data: acceptingUser } = await supabase
      .from('users')
      .select('name')
      .eq('id', userId)
      .single();

    if (requesterUser?.push_token) {
      await sendPushNotification(
        requesterUser.push_token,
        'Contact Accepted!',
        `${acceptingUser.name} accepted your contact request`
      );
    }

    console.log('✅ Contact request accepted');
    res.json({ message: 'Contact request accepted' });
  } catch (error) {
    console.error('Error accepting contact:', error);
    res.status(500).json({ error: 'Failed to accept contact request' });
  }
});

// Decline a contact request
router.put('/:id/decline', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;
    console.log('❌ Declining contact request:', contactId);

    const { data: contact, error: fetchError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('contact_user_id', userId)
      .eq('status', 'invited')
      .single();

    if (fetchError || !contact) {
      return res.status(404).json({ error: 'Contact request not found' });
    }

    const { error: deleteError } = await supabase
      .from('contacts')
      .delete()
      .eq('id', contactId);

    if (deleteError) throw deleteError;

    console.log('❌ Contact request declined and deleted');
    res.json({ message: 'Contact request declined' });
  } catch (error) {
    console.error('Error declining contact:', error);
    res.status(500).json({ error: 'Failed to decline contact request' });
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
