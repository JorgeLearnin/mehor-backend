'use strict';

const { db } = require('../db/db');

function requireSeller(req, res, next) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  const row = db
    .prepare(`SELECT is_seller AS isSeller FROM users WHERE id = ?`)
    .get(id);

  if (!row) return res.status(401).json({ error: 'Not authenticated' });
  if (!row.isSeller) return res.status(403).json({ error: 'Not authorized' });

  // Controllers may rely on req.user.isSeller; the session payload may not include it.
  req.user = { ...(req.user || {}), isSeller: true };

  return next();
}

module.exports = { requireSeller };
