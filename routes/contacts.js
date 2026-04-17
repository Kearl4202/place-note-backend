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

// Helper to get active contact count for a user
const getActiveContactCount = async (userId) => {
  const { count } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');
  return count || 0;
};

// Helper to get tier contact limits
const getTierLimits = (tierName) => {
  const limits = {
    'The Viewer': { active: 5, roster: 10 },
    'The Notifier': { active: 20, roster: 40 },
    'The Inspector': { active: 50, roster: null },
    'The Chief': { active: null, roster: null },
  };
  return limits[tierName] || { active: 5, roster: 10 };
};

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
        var latestInfo = {};
        if (contact.contact_user_id) {
          const { data: linkedUser } = await supabase
            .from('users')
            .select('name, email, phone, profile_pic')
            .eq('id', contact.contact_user_id)
            .single();
          if (linkedUser) {
            latestInfo = {
              name: linkedUser.name || contact.name,
              email: linkedUser.email || contact.email,
              phone: linkedUser.phone || contact.phone,
              profile_pic: linkedUser.profile_pic || null
            };
          }
        }
        return {
          ...contact,
          ...latestInfo,
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

router.get('/requests', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
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
          .select('id, name, email, phone, profile_pic')
          .eq('id', request.user_id)
          .single();
        return {
          id: request.id,
          requester_id: request.user_id,
          requester_name: requester?.name || 'Unknown',
          requester_email: requester?.email || '',
          requester_phone: requester?.phone || '',
          pre_accepted: request.pre_accepted || false,
          created_at: request.created_at,
        };
      })
    );
    res.json({ requests: requestsWithInfo });
  } catch (error) {
    console.error('Error fetching requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

router.get('/search', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { query } = req.query;
    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'Search query must be at least 3 characters' });
    }
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, phone, profile_pic')
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

router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, email, phone, contact_user_id, pre_accepted } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contact name is required' });
    }

    // Check roster limit (total contacts including inactive)
    const limitCheck = await checkSubscriptionLimit(userId, 'contacts');
    if (!limitCheck.allowed) {
      return res.status(403).json({
        error: `Contact list is full. Upgrade to add more!`,
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
        pre_accepted: pre_accepted || false,
      }])
      .select()
      .single();
    if (error) throw error;

    if (contact_user_id) {
      const { data: addedUser } = await supabase
        .from('users')
        .select('push_token, notification_prefs')
        .eq('id', contact_user_id)
        .single();

      const { data: requestingUser } = await supabase
        .from('users')
        .select('name')
        .eq('id', userId)
        .single();

      if (addedUser?.push_token) {
        var prefs = addedUser.notification_prefs || { geofence: true, tags: true, contacts: true };
        if (prefs.contacts !== false) {
          const notifBody = pre_accepted
            ? `${requestingUser.name} wants to add you as a contact and has already accepted your request!`
            : `${requestingUser.name} wants to add you as a contact`;
          await sendPushNotification(
            addedUser.push_token,
            'New Contact Request',
            notifBody,
            { screen: 'contacts' }
          );
        }
      }
    }

    res.status(201).json({ message: 'Contact created successfully', contact: data });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// Toggle contact active/inactive status
router.put('/:id/toggle-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;

    // Fetch the contact
    const { data: contact, error: fetchError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Only active contacts can be toggled (not pending/invited)
    if (contact.status === 'invited') {
      return res.status(400).json({ error: 'Cannot toggle status of a pending contact' });
    }

    const newStatus = contact.status === 'active' ? 'inactive' : 'active';

    // If activating, check active contact limit
    if (newStatus === 'active') {
      const { data: userInfo } = await supabase
        .from('users')
        .select('subscription_tier')
        .eq('id', userId)
        .single();

      const tierName = userInfo?.subscription_tier || 'The Viewer';
      const limits = getTierLimits(tierName);

      if (limits.active !== null) {
        const activeCount = await getActiveContactCount(userId);
        if (activeCount >= limits.active) {
          return res.status(403).json({
            error: `You can only have ${limits.active} active contacts on your current plan. Deactivate another contact or upgrade.`,
          });
        }
      }
    }

    const { error: updateError } = await supabase
      .from('contacts')
      .update({ status: newStatus })
      .eq('id', contactId)
      .eq('user_id', userId);

    if (updateError) throw updateError;

    res.json({ message: `Contact ${newStatus}`, status: newStatus });
  } catch (error) {
    console.error('Error toggling contact status:', error);
    res.status(500).json({ error: 'Failed to update contact status' });
  }
});

router.put('/:id/accept', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;

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

    // Update the original request to active
    const { error: updateError } = await supabase
      .from('contacts')
      .update({ status: 'active' })
      .eq('id', contactId);

    if (updateError) throw updateError;

    // If pre_accepted, auto-create the reverse contact so both sides are connected
    if (contact.pre_accepted) {
      const { data: requesterInfo } = await supabase
        .from('users')
        .select('name, email, phone')
        .eq('id', contact.user_id)
        .single();

      // Check if reverse contact already exists
      const { data: existingReverse } = await supabase
        .from('contacts')
        .select('id')
        .eq('user_id', userId)
        .eq('contact_user_id', contact.user_id)
        .single();

      if (!existingReverse && requesterInfo) {
        await supabase.from('contacts').insert([{
          user_id: userId,
          name: requesterInfo.name,
          email: requesterInfo.email,
          phone: requesterInfo.phone,
          contact_user_id: contact.user_id,
          status: 'active',
          pre_accepted: false,
        }]);
      }
    }

    // Notify the requester their request was accepted
    const { data: requesterUser } = await supabase
      .from('users')
      .select('push_token, notification_prefs')
      .eq('id', contact.user_id)
      .single();

    const { data: acceptingUser } = await supabase
      .from('users')
      .select('name')
      .eq('id', userId)
      .single();

    if (requesterUser?.push_token) {
      var prefs = requesterUser.notification_prefs || { geofence: true, tags: true, contacts: true };
      if (prefs.contacts !== false) {
        await sendPushNotification(
          requesterUser.push_token,
          'Contact Accepted!',
          `${acceptingUser.name} accepted your contact request`,
          { screen: 'contacts' }
        );
      }
    }

    res.json({ message: 'Contact request accepted' });
  } catch (error) {
    console.error('Error accepting contact:', error);
    res.status(500).json({ error: 'Failed to accept contact request' });
  }
});

router.put('/:id/decline', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const contactId = req.params.id;

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

    res.json({ message: 'Contact request declined' });
  } catch (error) {
    console.error('Error declining contact:', error);
    res.status(500).json({ error: 'Failed to decline contact request' });
  }
});

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
