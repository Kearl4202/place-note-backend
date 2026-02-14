const { supabase } = require('./database');

const SUBSCRIPTION_TIERS = {
  'The Viewer': {
    name: 'The Viewer',
    level: 0,
    description: 'Free tier with basic features',
    features: ['View place notes', 'Basic notifications', 'Limited contacts'],
    limits: {
      notes: 5,
      contacts: 3,
      groups: 0,
      projects: 0
    }
  },
  'The Notifier': {
    name: 'The Notifier',
    level: 1,
    description: 'Enhanced notifications and contacts',
    features: ['Unlimited place notes', 'Advanced notifications', 'More contacts'],
    limits: {
      notes: 999999,
      contacts: 10,
      groups: 0,
      projects: 0
    }
  },
  'The Inspector': {
    name: 'The Inspector',
    level: 2,
    description: 'Group features unlocked',
    features: ['Everything in Notifier', 'Create groups', 'Share notes'],
    limits: {
      notes: 999999,
      contacts: 50,
      groups: 5,
      projects: 0
    }
  },
  'The Chief': {
    name: 'The Chief',
    level: 3,
    description: 'Full access to all features',
    features: ['Everything in Inspector', 'Unlimited projects', 'Priority support'],
    limits: {
      notes: 999999,
      contacts: 999999,
      groups: 999999,
      projects: 999999
    }
  }
};

// Get user's subscription info with usage stats
async function getUserSubscriptionInfo(userId) {
  try {
    // Get user's subscription tier
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('subscription_tier, email, name')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    const tier = SUBSCRIPTION_TIERS[user.subscription_tier] || SUBSCRIPTION_TIERS['The Viewer'];

    // Get usage counts
    const { count: notesCount } = await supabase
      .from('place_notes')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: contactsCount } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: groupsCount } = await supabase
      .from('groups')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', userId);

    const { count: projectsCount } = await supabase
      .from('projects')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', userId);

    return {
      user: {
        email: user.email,
        name: user.name
      },
      tier: tier,
      limits: tier.limits,
      usage: {
        notes: notesCount || 0,
        contacts: contactsCount || 0,
        groups: groupsCount || 0,
        projects: projectsCount || 0
      }
    };

  } catch (error) {
    console.error('Error getting subscription info:', error);
    throw error;
  }
}

// Check if user can create more of a resource type
async function checkSubscriptionLimit(userId, resourceType) {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (error) throw error;

    const tier = SUBSCRIPTION_TIERS[user.subscription_tier] || SUBSCRIPTION_TIERS['The Viewer'];
    const limit = tier.limits[resourceType];

    // Count current usage
    let tableName;
    switch(resourceType) {
      case 'notes':
        tableName = 'place_notes';
        break;
      case 'contacts':
        tableName = 'contacts';
        break;
      case 'groups':
        tableName = 'groups';
        break;
      case 'projects':
        tableName = 'projects';
        break;
      default:
        return { allowed: false, limit: 0, current: 0 };
    }

    let column = 'user_id';
if (resourceType === 'groups' || resourceType === 'projects') {
  column = 'created_by';
}

const { count, error: countError } = await supabase
  .from(tableName)
  .select('*', { count: 'exact', head: true })
  .eq(column, userId);

    if (countError) throw countError;

    const current = count || 0;
    const allowed = current < limit;

    return { allowed, limit, current };

  } catch (error) {
    console.error('Error checking subscription limit:', error);
    return { allowed: false, limit: 0, current: 0 };
  }
}

module.exports = {
  SUBSCRIPTION_TIERS,
  getUserSubscriptionInfo,
  checkSubscriptionLimit
};