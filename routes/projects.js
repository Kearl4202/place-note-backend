const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { checkSubscriptionLimit } = require('../config/subscriptions');

// Get all projects for a user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    let projectsList = data || [];

    // Safety net: if no Personal project exists, create one automatically
    const hasPersonal = projectsList.some(p => p.name.toLowerCase() === 'personal');
    if (!hasPersonal) {
      const { data: personalProject, error: createError } = await supabase
        .from('projects')
        .insert([{ owner_id: userId, name: 'Personal' }])
        .select()
        .single();
      if (!createError && personalProject) {
        projectsList = [...projectsList, personalProject];
      }
    }

    // Always sort Personal to the end so it appears last in the list
    projectsList.sort((a, b) => {
      if (a.name.toLowerCase() === 'personal') return 1;
      if (b.name.toLowerCase() === 'personal') return -1;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    res.json({ projects: projectsList });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Create a new project
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const limitCheck = await checkSubscriptionLimit(userId, 'projects');
    if (!limitCheck.allowed) {
      return res.status(403).json({
        error: `You've reached your limit of ${limitCheck.limit} projects. Upgrade to add more!`,
        limit: limitCheck.limit,
        current: limitCheck.current
      });
    }
    const { data, error } = await supabase
      .from('projects')
      .insert([{ owner_id: userId, name: name.trim() }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ message: 'Project created successfully', project: data });
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Delete a project
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const projectId = req.params.id;
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('owner_id', userId);
    if (error) throw error;
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

module.exports = router;
