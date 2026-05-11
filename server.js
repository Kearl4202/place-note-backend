const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
const locationRoutes = require('./routes/location');
const noteActivityRoutes = require('./routes/note-activity');
const reportRoutes = require('./routes/reports');
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscriptions');
const placeNoteRoutes = require('./routes/place-notes');
const contactRoutes = require('./routes/contacts');
const groupRoutes = require('./routes/groups');
const projectRoutes = require('./routes/projects');
const chatRoutes = require('./routes/chat');
const adminAuthRoutes = require('./routes/admin-auth'); // Phase 1: admin auth route
const adminMessagesRoutes = require('./routes/messages'); // Phase 2: admin messaging
const adminBusinessesRoutes = require('./routes/admin-businesses'); // Phase 3: sponsored businesses
const adminSponsoredNotesRoutes = require('./routes/admin-sponsored-notes'); // Phase 3: sponsored ads
const adminSponsoredRunsRoutes = require('./routes/admin-sponsored-runs'); // Phase 3: ad campaign runs
const adminSponsoredStatsRoutes = require('./routes/admin-sponsored-stats'); // Phase 3: ad analytics
const sponsoredUserRoutes = require('./routes/sponsored-user'); // Phase 3: user-facing sponsored ads
const { startCronJobs } = require('./config/cron');
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/place-notes', placeNoteRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/note-activity', noteActivityRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin/auth', adminAuthRoutes); // Phase 1: admin auth endpoints
app.use('/api/admin/messages', adminMessagesRoutes); // Phase 2: admin messaging endpoints
app.use('/api/admin/businesses', adminBusinessesRoutes); // Phase 3: sponsored businesses
app.use('/api/admin/sponsored-notes', adminSponsoredNotesRoutes); // Phase 3: sponsored ads
app.use('/api/admin/sponsored-runs', adminSponsoredRunsRoutes); // Phase 3: ad campaign runs
app.use('/api/admin/sponsored-stats', adminSponsoredStatsRoutes); // Phase 3: ad analytics
app.use('/api/sponsored', sponsoredUserRoutes); // Phase 3: user-facing sponsored ads
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Place Note API is running' });
});
app.get('/app-ads.txt', (req, res) => {
  res.type('text/plain');
  res.send('google.com, pub-9932191100331429, DIRECT, f08c47fec0942fa0');
});
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  console.log('Place Note Backend API');
});
startCronJobs();
