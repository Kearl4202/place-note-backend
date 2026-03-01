const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
const locationRoutes = require('./routes/location');
const noteActivityRoutes = require('./routes/note-activity');

const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscriptions');
const placeNoteRoutes = require('./routes/place-notes');
const contactRoutes = require('./routes/contacts');
const groupRoutes = require('./routes/groups');
const projectRoutes = require('./routes/projects');
const chatRoutes = require('./routes/chat');

app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/place-notes', placeNoteRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/note-activity', noteActivityRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Place Note API is running' });
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  console.log('Place Note Backend API');
});
