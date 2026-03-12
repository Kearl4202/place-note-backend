const { supabase } = require('./database');

const SUBSCRIPTION_TIERS = {
  'The Viewer': {
    name: 'The Viewer',
    level: 0,
    description: 'Free tier with basic features',
    features: ['View place notes', 'Basic notifications', 'Limited contacts'],
    limits: {
      notes: 5,
      contacts: 5,
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
      notes: 10,
      contacts: 20,
      groups: 2,
      projects: 0
    }
  },
  'The Inspector': {
    name: 'The Inspector',
    level: 2,
    description: 'Group features unlocked',
    features: ['Everything in Notifier', 'Create groups', 'Share notes'],
    limits: {
      notes: 20,
      contacts: 50,
      groups: 5,
      projects: 2
    }
  },
  'The Chief': {
    name: 'The Chief',
    level: 3,
    description: 'Full access to all features',
    features: ['Everything in Inspector', 'Unlimited projects', 'Priority support'],
    limits: {
      notes: 50,
      contacts: 50,  // ✅ Base limit — contact packs add on top of this
      groups: 10,
      projects: 10
    }
  }
};

// Get user's subscription info with usage stats
async function getUserSubscriptionInfo(userId) {
  try {
    // ✅ Also fetch contact_pack_count for dynamic Chief contact limit
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('subscription_tier, email, name, contact_pack_count')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    const TIER_ALIASES = {
      'viewer': 'The Viewer',
      'notifier': 'The Notifier', 
      'inspector': 'The Inspector',
      'chief': 'The Chief',
    };
    const tierKey = TIER_ALIASES[user.subscription_tier?.toLowerCase()] || user.subscription_tier;
    const tier = SUBSCRIPTION_TIERS[tierKey] || SUBSCRIPTION_TIERS['The Viewer'];

    // ✅ Dynamic contact limit: base + contact_pack_count (Chief only)
    const contactPackCount = user.contact_pack_count || 0;
    const dynamicContactLimit = tierKey === 'The Chief'
      ? tier.limits.contacts + contactPackCount
      : tier.limits.contacts;

    const dynamicLimits = {
      ...tier.limits,
      contacts: dynamicContactLimit,
    };

    // ✅ Only count ACTIVE notes created by this user
    const { count: notesCount } = await supabase
      .from('place_notes')
      .select('*', { count: 'exact', head: true })
      .eq('creator_id', userId)
      .eq('status', 'active');

    // Only count ACTIVE contacts
    const { count: contactsCount } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'active');

    const { count: groupsCount } = await supabase
      .from('groups')
      .select('*', { count: 'exact', head: true })
      .eq('created_by', userId);

    const { count: projectsCount } = await supabase
      .from('projects')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .neq('name', 'Personal');

    return {
      user: {
        email: user.email,
        name: user.name
      },
      tier: tier,
      limits: dynamicLimits,
      usage: {
        notes: notesCount || 0,
        contacts: contactsCount || 0,
        groups: groupsCount || 0,
        projects: projectsCount || 0
      }
    };

  } catch (error) {
    console.error('=== SUBSCRIPTION INFO ERROR ===');
    console.error('Error:', error);
    return {
      user: { email: '', name: '' },
      tier: SUBSCRIPTION_TIERS['The Viewer'],
      limits: SUBSCRIPTION_TIERS['The Viewer'].limits,
      usage: { notes: 0, contacts: 0, groups: 0, projects: 0 }
    };
  }
}

// Check if user can create more of a resource type
async function checkSubscriptionLimit(userId, resourceType) {
  try {
    // ✅ Also fetch contact_pack_count for dynamic Chief contact limit
    const { data: user, error } = await supabase
      .from('users')
      .select('subscription_tier, contact_pack_count')
      .eq('id', userId)
      .single();

    if (error) throw error;

    const TIER_ALIASES = {
      'viewer': 'The Viewer',
      'notifier': 'The Notifier',
      'inspector': 'The Inspector',
      'chief': 'The Chief',
    };
    const tierKey = TIER_ALIASES[user.subscription_tier?.toLowerCase()] || user.subscription_tier;
    const tier = SUBSCRIPTION_TIERS[tierKey] || SUBSCRIPTION_TIERS['The Viewer'];
    let limit = tier.limits[resourceType];

    // ✅ Dynamic contact limit for Chief: base 50 + contact_pack_count
    if (resourceType === 'contacts' && tierKey === 'The Chief') {
      limit = tier.limits.contacts + (user.contact_pack_count || 0);
    }

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
    if (resourceType === 'groups') {
      column = 'created_by';
    } else if (resourceType === 'projects') {
      column = 'owner_id';
    } else if (resourceType === 'notes') {
      column = 'creator_id';
    }

    let query = supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq(column, userId);

    // Only count ACTIVE notes toward the limit
    if (resourceType === 'notes') {
      query = query.eq('status', 'active');
    }

    // Only count active contacts toward the limit
    if (resourceType === 'contacts') {
      query = query.eq('status', 'active');
    }

    // Exclude Personal project from count (everyone gets it free)
    if (resourceType === 'projects') {
      query = query.neq('name', 'Personal');
    }

    const { count, error: countError } = await query;

    if (countError) throw countError;

    const current = count || 0;
    const allowed = current < limit;

    return { allowed, limit, current };

  } catch (error) {
    console.error('Error checking subscription limit:', error);
    console.error('Error details:', error.message, error.code);
    return { allowed: false, limit: 0, current: 0 };
  }
}

module.exports = {
  SUBSCRIPTION_TIERS,
  getUserSubscriptionInfo,
  checkSubscriptionLimit
};
