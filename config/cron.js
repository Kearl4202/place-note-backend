const cron = require('node-cron');
const axios = require('axios');
const { archiveCleanup } = require('./subscription-manager');
const { supabase } = require('./database');

const sendPushNotification = async (pushToken, title, body, data = {}) => {
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data,
    });
  } catch (error) {
    console.error('🔔 Error sending re-engagement push notification:', error.message);
  }
};

const messages = [
  { title: '📍 Place Note', body: 'Any new tags or messages waiting for you? Tap to check in!' },
  { title: '📍 Place Note', body: 'Don\'t miss updates from your team — open Place Note to stay in sync.' },
  { title: '📍 Place Note', body: 'You have Place Notes out there — tap to see what\'s happening!' },
  { title: '📍 Place Note', body: 'Did someone drop a tag on your note? Tap to find out!' },
];

const reEngagementNotification = async () => {
  console.log('🔔 Running re-engagement notifications...');
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, push_token, notification_prefs')
      .not('push_token', 'is', null);

    if (error) throw error;

    if (!users || users.length === 0) {
      console.log('🔔 No users with push tokens found');
      return;
    }

    const message = messages[Math.floor(Math.random() * messages.length)];

    let sent = 0;
    for (const user of users) {
      const prefs = user.notification_prefs || {};
      if (prefs.geofence === false && prefs.tags === false) {
        continue;
      }
      await sendPushNotification(
        user.push_token,
        message.title,
        message.body,
        { screen: 'home' }
      );
      sent++;
    }

    console.log('🔔 Re-engagement notifications sent to', sent, 'users');
  } catch (error) {
    console.error('🔔 Re-engagement notification failed:', error);
  }
};

// =====================================================
// Phase 3: Auto-schedule sponsored ad runs
// Every 5 min: activate scheduled runs whose start has passed.
// Every 5 min: end active/paused runs whose end has passed.
// =====================================================
const processSponsoredRunSchedule = async () => {
  try {
    const nowIso = new Date().toISOString();

    // 1) Activate scheduled runs whose start_date has passed
    const { data: toActivate, error: activateErr } = await supabase
      .from('sponsored_note_runs')
      .update({ status: 'active' })
      .eq('status', 'scheduled')
      .lte('start_date', nowIso)
      .select('id');

    if (activateErr) {
      console.error('📍 Failed to activate scheduled runs:', activateErr);
    } else if (toActivate && toActivate.length > 0) {
      console.log('📍 Activated', toActivate.length, 'sponsored run(s)');
    }

    // 2) End runs (active or paused) whose end_date has passed
    const { data: toEnd, error: endErr } = await supabase
      .from('sponsored_note_runs')
      .update({ status: 'ended' })
      .in('status', ['active', 'paused'])
      .lte('end_date', nowIso)
      .select('id');

    if (endErr) {
      console.error('📍 Failed to end expired runs:', endErr);
    } else if (toEnd && toEnd.length > 0) {
      console.log('📍 Ended', toEnd.length, 'expired sponsored run(s)');
    }
  } catch (error) {
    console.error('📍 Sponsored run scheduler failed:', error);
  }
};

// Run archive cleanup daily at 3:00 AM Central Time (8:00 AM UTC)
function startCronJobs() {
  cron.schedule('0 8 * * *', async () => {
    console.log('⏰ Running scheduled archive cleanup...');
    try {
      await archiveCleanup();
      console.log('⏰ Archive cleanup completed');
    } catch (error) {
      console.error('⏰ Archive cleanup failed:', error);
    }
  });

  // Run re-engagement notifications every 2 days at 9:00 AM Central Time (14:00 UTC)
  cron.schedule('0 14 */2 * *', async () => {
    await reEngagementNotification();
  });

  // Phase 3: Process sponsored ad scheduling every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await processSponsoredRunSchedule();
  });

  console.log('⏰ Cron jobs initialized:');
  console.log('   - Archive cleanup daily at 3:00 AM CT');
  console.log('   - Re-engagement every 2 days at 9:00 AM CT');
  console.log('   - Sponsored run scheduler every 5 minutes');
}

module.exports = { startCronJobs };
