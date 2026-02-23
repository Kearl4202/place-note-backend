const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');

// Get all contacts for a user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('creator_id', userId)
      .order('name', { ascending: true });

    if (error) throw error;

    res.json({ contacts: data || [] });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// Create a new contact
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, email, phone } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Contact name is required' });
    }

    // Check subscription limits
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
        creator_id: userId,
        name: name.trim(),
        email: email ? email.trim() : null,
        phone: phone ? phone.trim() : null,
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ 
      message: 'Contact created successfully',
      contact: data 
    });
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
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
      .eq('creator_id', userId);

    if (error) throw error;

    res.json({ message: 'Contact deleted successfully' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;