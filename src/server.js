'use strict';

process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('UNHANDLED REJECTION:', reason);
  process.exitCode = 1;
});

console.log('SERVER BOOT =>', __filename);
console.log('USING APP =>', require.resolve('./app'));

const path = require('path');

// load backend/.env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createApp } = require('./app');
const { runOrderTimersTick } = require('./controllers/orders.controller');

const port = Number.parseInt(process.env.PORT ?? '5000', 10);
if (!Number.isFinite(port) || port <= 0)
  throw new Error('PORT must be a valid positive number');

const app = createApp();

// Background timer processing (best-effort):
// - Auto-complete delivered orders whose review window ended
// - Auto-cancel + refund paid orders past delivery deadline
// Runs in-process; if you scale to multiple instances, consider moving this to a single worker.
const TIMER_INTERVAL_MS = 60 * 1000;
let timerHandle = null;

function startOrderTimers() {
  if (timerHandle) return;
  const tick = async () => {
    try {
      await runOrderTimersTick({ nowIso: new Date().toISOString() });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Order timers tick failed:', e);
    }
  };

  // Run once shortly after boot, then on interval.
  setTimeout(() => {
    void tick();
  }, 5000);
  timerHandle = setInterval(() => {
    void tick();
  }, TIMER_INTERVAL_MS);
}

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`);
  startOrderTimers();
});
