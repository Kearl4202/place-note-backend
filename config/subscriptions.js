const SUBSCRIPTION_TIERS = {
  viewer: {
    name: 'The Viewer',
    price_monthly: 0,
    price_yearly: 0,
    limits: {
      place_notes: 5,
      contacts: 3,
      groups: 0,
      projects: 0,
    },
    features: {
      basic_notifications: true,
      groups: false,
      projects: false,
      chat: true,
      unlimited_contacts: false,
    },
    description: 'Free plan with basic features'
  },
  
  notifier: {
    name: 'The Notifier',
    price_monthly: 1200,
    price_yearly: 9900,
    limits: {
      place_notes: 25,
      contacts: 25,
      groups: 5,
      projects: 0,
    },
    features: {
      basic_notifications: true,
      groups: true,
      projects: false,
      chat: true,
      unlimited_contacts: false,
    },
    description: 'For individuals who need groups and more capacity'
  },
  
  inspector: {
    name: 'The Inspector',
    price_monthly: 2500,
    price_yearly: 25000,
    limits: {
      place_notes: 50,
      contacts: 50,
      groups: -1,
      projects: 2,
    },
    features: {
      basic_notifications: true,
      groups: true,
      projects: true,
      chat: true,
      unlimited_contacts: false,
      unlimited_groups: true,
    },
    description: 'For teams managing multiple projects'
  },
  
  chief: {
    name: 'The Chief',
    price_monthly: 9900,
    price_yearly: 99000,
    price_per_contact_monthly: 100,
    price_per_contact_yearly: 1000,
    limits: {
      place_notes: -1,
      contacts: -1,
      groups: -1,
      projects: -1,
    },
    features: {
      basic_notifications: true,
      groups: true,
      projects: true,
      chat: true,
      unlimited_contacts: true,
      unlimited_groups: true,
      unlimited_projects: true,
      priority_support: true,
    },
    description: 'Enterprise plan for large teams'
  }
};

function getUserLimits(userTier, chiefContactLimit = 0) {
  const tier = SUBSCRIPTION_TIERS[userTier];
  
  if (userTier === 'chief') {
    return {
      place_notes: -1,
      contacts: chiefContactLimit,
      groups: -1,
      projects: -1,
    };
  }
  
  return tier.limits;
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

    const { count, error: countError } = await supabase
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

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
  checkSubscriptionLimit  // ← ADD THIS LINE
};