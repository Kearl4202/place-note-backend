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

    // Pick a random message so it doesn't feel repetitive
    const message = messages[Math.floor(Math.random() * messages.length)];

    let sent = 0;
    for (const user of users) {
      // Respect notification preferences
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

  console.log('⏰ Cron jobs initialized - archive cleanup daily at 3:00 AM CT, re-engagement every 2 days at 9:00 AM CT');
}

module.exports = { startCronJobs };
