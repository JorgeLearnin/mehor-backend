'use strict';

const { db } = require('../db/db');
const { verifySession } = require('../utils/jwt');

const DASHBOARD_COOKIE_NAME =
  process.env.DASHBOARD_COOKIE_NAME || 'mehor_admin_session';

async function requireDashboardAuth(req, res, next) {
  const token = req.cookies?.[DASHBOARD_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = verifySession(token);
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!payload || payload.type !== 'dashboard' || !payload.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = await db
    .prepare(
      `SELECT id, email, role, status
         FROM dashboard_users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(String(payload.id));

  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.dashboardUser = {
    id: String(user.id),
    email: String(user.email),
    role: String(user.role || 'admin'),
  };

  return next();
}

module.exports = { requireDashboardAuth };
