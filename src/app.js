'use strict';

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { authRouter } = require('./routes/auth.routes');
const { dashboardAuthRouter } = require('./routes/dashboardAuth.routes');
const {
  dashboardListingsRouter,
} = require('./routes/dashboardListings.routes');
const { dashboardUsersRouter } = require('./routes/dashboardUsers.routes');
const {
  dashboardDisputesRouter,
} = require('./routes/dashboardDisputes.routes');
const {
  dashboardTransactionsRouter,
} = require('./routes/dashboardTransactions.routes');
const {
  dashboardFeedbackRouter,
} = require('./routes/dashboardFeedback.routes');
const { dashboardReportsRouter } = require('./routes/dashboardReports.routes');
const { listingsRouter } = require('./routes/listings.routes');
const { messagesRouter } = require('./routes/messages.routes');
const { notificationsRouter } = require('./routes/notifications.routes');
const { usersRouter } = require('./routes/users.routes');
const { ordersRouter } = require('./routes/orders.routes');
const { stripeRouter } = require('./routes/stripe.routes');
const { feesRouter } = require('./routes/fees.routes');
const { contactRouter } = require('./routes/contact.routes');
const { feedbackRouter } = require('./routes/feedback.routes');
const { reportsRouter } = require('./routes/reports.routes');
const { stripeWebhook } = require('./controllers/stripe.controller');
require('./db/db');

function createApp() {
  const app = express();
  console.log('APP BOOT =>', __filename);

  const isProd = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());

  const allowed = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (isProd && allowed.length === 0) {
    throw new Error('CLIENT_ORIGIN must be set in production');
  }

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowed.length === 0) return cb(null, true);
        if (allowed.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }),
  );

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  // Stripe webhook MUST use the raw body for signature verification.
  // Mount it before express.json().
  app.post(
    '/api/stripe/webhook',
    express.raw({ type: 'application/json' }),
    stripeWebhook,
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));
  app.get('/api', (req, res) =>
    res.status(200).json({ name: 'mehor-backend', ok: true }),
  );

  app.use('/api/auth', authRouter);
  app.use('/api/dashboard-auth', dashboardAuthRouter);
  app.use('/api/dashboard', dashboardListingsRouter);
  app.use('/api/dashboard', dashboardUsersRouter);
  app.use('/api/dashboard', dashboardDisputesRouter);
  app.use('/api/dashboard', dashboardTransactionsRouter);
  app.use('/api/dashboard', dashboardFeedbackRouter);
  app.use('/api/dashboard', dashboardReportsRouter);
  app.use('/api/listings', listingsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/stripe', stripeRouter);
  app.use('/api/fees', feesRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/contact', contactRouter);
  app.use('/api/feedback', feedbackRouter);
  app.use('/api/reports', reportsRouter);

  app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = typeof err.status === 'number' ? err.status : 500;
    const message = status >= 500 ? 'Internal Server Error' : err.message;

    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error('[backend:error]', {
        method: req.method,
        path: req.originalUrl || req.url,
        error: err,
      });
    }

    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
