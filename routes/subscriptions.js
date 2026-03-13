const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { getUserSubscriptionInfo } = require('../config/subscriptions');

// Map RevenueCat product IDs to subscription tiers
const PRODUCT_TIER_MAP = {
  // Monthly products
  'notifier_sub:notifier-monthly': 'notifier',
  'inspector_sub:inspector-monthly': 'inspector',
  'chief_sub:chief-monthly': 'chief',
  // Yearly products — actual RevenueCat product IDs
  'notifier_yearly:notifier-yearly': 'notifier',
  'inspector_yearly:inspector-yearly': 'inspector',
  'chief_yearly:chief-yearly': 'chief',
};

const CONTACT_PACK_MAP = {
  'chief_contacts_50': 50,
  'chief_contacts_100': 100,
  'chief_contacts_150': 150,
  'chief_contacts_200': 200,
  'chief_contacts_250': 250,
};

// Get current subscription info
router.get('/info', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const subscriptionInfo = await getUserSubscriptionInfo(userId);
    res.json(subscriptionInfo);
  } catch (error) {
    console.error('Error fetching subscription info:', error);
    res.status(500).json({ error: 'Failed to fetch subscription information' });
  }
});

// RevenueCat webhook — called when subscription changes
router.post('/revenuecat', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Handle both Buffer (raw) and pre-parsed object (if global JSON middleware ran first)
    const body = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString())
      : typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;
    const event = body.event;

    if (!event) return res.status(400).json({ error: 'No event in body' });

    const { type, app_user_id, product_id, expiration_at_ms } = event;
    console.log('💳 RevenueCat webhook:', type, 'user:', app_user_id, 'product:', product_id);

    const ACTIVATE_EVENTS = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION'];
    const DEACTIVATE_EVENTS = ['CANCELLATION', 'EXPIRATION', 'BILLING_ISSUE'];

    if (ACTIVATE_EVENTS.includes(type)) {
      const tier = PRODUCT_TIER_MAP[product_id];
      if (tier) {
        await supabase
          .from('users')
          .update({
            subscription_tier: tier,
            subscription_expires_at: expiration_at_ms
              ? new Date(expiration_at_ms).toISOString()
              : null,
          })
          .eq('id', app_user_id);

        console.log('💳 Updated user', app_user_id, 'to tier:', tier);

        await supabase.from('subscription_history').insert({
          user_id: app_user_id,
          event_type: type,
          product_id,
          tier,
          created_at: new Date().toISOString(),
        });
      }

      const contactCount = CONTACT_PACK_MAP[product_id];
      if (contactCount) {
        // Fetch current pack count and add to it (stacking)
        const { data: userRow } = await supabase
          .from('users')
          .select('contact_pack_count')
          .eq('id', app_user_id)
          .single();
        
        const currentPackCount = userRow?.contact_pack_count || 0;
        const newPackCount = Math.min(currentPackCount + contactCount, 250);
        
        await supabase
          .from('users')
          .update({ contact_pack_count: newPackCount })
          .eq('id', app_user_id);
        console.log('💳 Contact pack updated for user', app_user_id, ':', currentPackCount, '+', contactCount, '=', newPackCount);
      }
    }

    if (DEACTIVATE_EVENTS.includes(type)) {
      await supabase
        .from('users')
        .update({
          subscription_tier: 'viewer',
          subscription_expires_at: null,
          contact_pack_count: 0,
        })
        .eq('id', app_user_id);

      console.log('💳 Downgraded user', app_user_id, 'to viewer');

      await supabase.from('subscription_history').insert({
        user_id: app_user_id,
        event_type: type,
        product_id,
        tier: 'viewer',
        created_at: new Date().toISOString(),
      });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('💳 RevenueCat webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Called from app after purchase to verify and sync subscription
router.post('/verify', authenticateToken, async (req, res) => {
  try {
    const { tier } = req.body;
    const userId = req.user?.userId;

    if (!userId || !tier) return res.status(400).json({ error: 'Missing userId or tier' });

    await supabase
      .from('users')
      .update({ subscription_tier: tier })
      .eq('id', userId);

    console.log('💳 Verified tier for user', userId, ':', tier);
    res.json({ success: true, tier });
  } catch (error) {
    console.error('💳 Verify error:', error);
    res.status(500).json({ error: 'Failed to verify subscription' });
  }
});

// Called from app after contact pack purchase
router.post('/contact-pack', authenticateToken, async (req, res) => {
  try {
    const { contactCount } = req.body;
    const userId = req.user?.userId;

    if (!userId || !contactCount) return res.status(400).json({ error: 'Missing userId or contactCount' });

    const validPacks = [50, 100, 150, 200, 250];
    if (!validPacks.includes(Number(contactCount))) {
      return res.status(400).json({ error: 'Invalid contact pack size' });
    }

    const { data: userRow, error: fetchError } = await supabase
      .from('users')
      .select('subscription_tier, contact_pack_count')
      .eq('id', userId)
      .single();

    if (fetchError || !userRow) return res.status(404).json({ error: 'User not found' });

    if (userRow.subscription_tier !== 'chief') {
      return res.status(403).json({ error: 'Contact packs are only available on The Chief plan' });
    }

    const currentPackCount = userRow.contact_pack_count || 0;
    const newPackCount = currentPackCount + Number(contactCount);

    // Cap at 250 pack count (50 base + 250 pack = 300 total max)
    if (newPackCount > 250) {
      return res.status(400).json({ 
        error: `This pack would exceed the maximum of 300 contacts. You currently have ${50 + currentPackCount} contacts (${currentPackCount} from packs). Maximum pack total is 250.`,
        currentPackCount,
        maxPackCount: 250
      });
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({ contact_pack_count: newPackCount })
      .eq('id', userId);

    if (updateError) throw updateError;

    console.log('💳 Contact pack updated for user', userId, ':', currentPackCount, '+', contactCount, '=', newPackCount);
    res.json({ success: true, contactCount: newPackCount });
  } catch (error) {
    console.error('💳 Contact pack error:', error);
    res.status(500).json({ error: 'Failed to update contact pack' });
  }
});

module.exports = router;
