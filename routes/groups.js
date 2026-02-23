const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get all groups for a user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data, error } = await supabase
      .from('groups')
      .select('*')
      .eq('created_by', userId)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ groups: data || [] });
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Create a new group
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    const { data, error } = await supabase
      .from('groups')
      .insert([{ created_by: userId, name: name.trim() }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ message: 'Group created successfully', group: data });
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Delete a group
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const groupId = req.params.id;
    const { error } = await supabase
      .from('groups')
      .delete()
      .eq('id', groupId)
      .eq('created_by', userId);
    if (error) throw error;
    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// Add a member to a group
router.post('/:id/members', authenticateToken, async (req, res) => {
  try {
    const groupId = req.params.id;
    const { contact_id } = req.body;
    const { error } = await supabase
      .from('contact_groups')
      .insert([{ group_id: groupId, contact_id }]);
    if (error) throw error;
    res.status(201).json({ message: 'Member added to group' });
  } catch (error) {
    console.error('Error adding member:', error);
    res.status(500).json({ error: 'Failed to add member to group' });
  }
});

// Remove a member from a group
router.delete('/:id/members/:contactId', authenticateToken, async (req, res) => {
  try {
    const groupId = req.params.id;
    const contactId = req.params.contactId;
    const { error } = await supabase
      .from('contact_groups')
      .delete()
      .eq('group_id', groupId)
      .eq('contact_id', contactId);
    if (error) throw error;
    res.json({ message: 'Member removed from group' });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member from group' });
  }
});

module.exports = router;