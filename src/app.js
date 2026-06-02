const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

require('dotenv').config();

const authRoutes = require('./routes/auth.routes');
const sellerRoutes = require('./routes/seller.routes');
const listingsRoutes = require('./routes/listings.routes');
const savedListingsRoutes = require('./routes/savedListings.routes');
const uploadRoutes = require('./routes/upload.routes');
const profileRoutes = require('./routes/profile.routes');
const contactRoutes = require('./routes/contact.routes');
const reportsRoutes = require('./routes/reports.routes');
const feedbackRoutes = require('./routes/feedback.routes');
const messagesRoutes = require('./routes/messages.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const ordersRoutes = require('./routes/orders.routes');
const dashboardAuthRoutes = require('./routes/dashboardAuth.routes');
const dashboardMarketplaceRoutes = require('./routes/dashboardMarketplace.routes');

const {
  handleStripeWebhook,
  processExpiredOrderWindows,
} = require('./controllers/order.controller');
const {
  handleStripeConnectWebhook,
} = require('./controllers/seller.controller');

const app = express();

app.use(helmet());

const allowedOrigins = String(process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }),
);

app.post(
  '/api/orders/stripe-webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook,
);

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeConnectWebhook,
);

app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/saved-listings', savedListingsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/dashboard/auth', dashboardAuthRoutes);
app.use('/api/dashboard', dashboardMarketplaceRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;

let expiredOrderWindowProcessorInFlight = false;

async function runExpiredOrderWindowProcessor() {
  if (expiredOrderWindowProcessorInFlight) return;

  expiredOrderWindowProcessorInFlight = true;

  try {
    const result = await processExpiredOrderWindows();

    if (result.totalProcessed > 0) {
      console.log('Processed expired order windows:', result);
    }
  } catch (error) {
    console.error('Expired order window processor error:', error);
  } finally {
    expiredOrderWindowProcessorInFlight = false;
  }
}

const expiredOrderWindowIntervalMs = Number(
  process.env.ORDER_WINDOW_PROCESSOR_INTERVAL_MS ?? 60_000,
);

if (expiredOrderWindowIntervalMs > 0) {
  setTimeout(() => {
    void runExpiredOrderWindowProcessor();
  }, 10_000);

  setInterval(() => {
    void runExpiredOrderWindowProcessor();
  }, expiredOrderWindowIntervalMs);
}

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
