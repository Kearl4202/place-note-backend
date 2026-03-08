const cron = require('node-cron');
const { archiveCleanup } = require('./subscription-manager');

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

  console.log('⏰ Cron jobs initialized - archive cleanup scheduled daily at 3:00 AM CT');
}

module.exports = { startCronJobs };
