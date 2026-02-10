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

module.exports = {
  SUBSCRIPTION_TIERS,
  getUserLimits
};