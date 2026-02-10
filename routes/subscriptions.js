const express = require('express');
const router = express.Router();
const supabase = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { SUBSCRIPTION_TIERS, getUserLimits } = require('../config/subscriptions');

router.get('/info', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('subscription_tier, subscription_status, subscription_period, subscription_renews, chief_contact_limit')
      .eq('id', req.userId)
      .single();

    const tier = SUBSCRIPTION_TIERS[user.subscription_tier];
    const limits = getUserLimits(user.subscription_tier, user.chief_contact_limit);

    const { count: notesCount } = await supabase
      .from('place_notes')
      .select('*', { count: 'exact', head: true })
      .eq('creator_id', req.userId)
      .eq('status', 'active');

    const { count: contactsCount } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    const { count: groupsCount } = await supabase
      .from('groups')
      .select('*', { count: 'exact', head: true });

    const { count: projectsCount } = await supabase
      .from('projects')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', req.userId);

    res.json({
      tier: {
        name: tier.name,
        level: user.subscription_tier,
        description: tier.description,
        features: tier.features,
      },
      status: user.subscription_status,
      period: user.subscription_period,
      renews: user.subscription_renews,
      limits: limits,
      usage: {
        place_notes: notesCount || 0,
        contacts: contactsCount || 0,
        groups: groupsCount || 0,
        projects: projectsCount || 0,
      },
      percentage: {
        place_notes: limits.place_notes === -1 ? 0 : Math.round((notesCount / limits.place_notes) * 100),
        contacts: limits.contacts === -1 ? 0 : Math.round((contactsCount / limits.contacts) * 100),
        groups: limits.groups === -1 ? 0 : Math.round((groupsCount / limits.groups) * 100),
        projects: limits.projects === -1 ? 0 : Math.round((projectsCount / limits.projects) * 100),
      },
      upgrade_available: user.subscription_tier !== 'chief'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;