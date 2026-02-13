const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Import routes
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscriptions');
const placeNoteRoutes = require('./routes/place-notes');

// Use routes
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/place-notes', placeNoteRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Place Note API is running' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Place Note Backend API`);
});;