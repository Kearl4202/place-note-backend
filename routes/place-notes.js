const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');

// Create a new place note
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, latitude, longitude, perimeter_feet, trigger_on_entry, trigger_on_exit, is_active } = req.body;
    const userId = req.user.userId;

    // // Check subscription limits
    // const limitCheck = await checkSubscriptionLimit(userId, 'notes');
    // if (!limitCheck.allowed) {
    //   return res.status(403).json({ 
    //     error: `You've reached your limit of ${limitCheck.limit} place notes. Upgrade to add more!`,
    //     limit: limitCheck.limit,
    //     current: limitCheck.current
    //   });
    // }

    // Create the place note
    const { data, error } = await supabase
      .from('place_notes')
      .insert([{
        creator_id: userId,
        name,
        description,
        latitude,
        longitude,
        perimeter_feet: perimeter_feet || 500,
        status: 'active',
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      message: 'Place note created successfully',
      placeNote: data
    });

  } catch (error) {
    console.error('Error creating place note:', error);
    res.status(500).json({ error: error.message || 'Failed to create place note' });
  }
});

// Get all place notes for the authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const { data, error } = await supabase
      .from('place_notes')
      .select('*')
      .eq('creator_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ placeNotes: data });

  } catch (error) {
    console.error('Error fetching place notes:', error);
    res.status(500).json({ error: 'Failed to fetch place notes' });
  }
});

module.exports = router;
