'use strict';

const { db } = require('../db/db');
const { verifySession } = require('../utils/jwt');

async function requireAuth(req, res, next) {
  try {
    const name = process.env.COOKIE_NAME || 'mehor_session';
    const token = req.cookies?.[name];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const payload = verifySession(token);
    const userId = payload?.id ? String(payload.id).trim() : '';
    if (!userId) return res.status(401).json({ error: 'Invalid session' });

    const userRow = await db
      .prepare(
        `SELECT id, is_restricted AS isRestricted FROM users WHERE id = ? LIMIT 1`,
      )
      .get(userId);

    if (!userRow?.id)
      return res.status(401).json({ error: 'Not authenticated' });
    if (Number(userRow.isRestricted ?? 0) === 1) {
      return res.status(403).json({ error: 'Account restricted' });
    }

    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

module.exports = { requireAuth };
