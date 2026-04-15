'use strict';

const { db } = require('../db/db');
const { getPaginationParams, escapeLike } = require('../utils/pagination');

async function listDashboardUsers(req, res) {
  const qRaw = typeof req.query?.q === 'string' ? req.query.q : '';
  const q = qRaw.trim().toLowerCase();

  const { page, limit, offset } = getPaginationParams(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
  });

  let where = '1=1';
  let args = [];

  if (q) {
    const like = `%${escapeLike(q)}%`;

    where = `(
      LOWER(COALESCE(u.name, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(u.display_name, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(u.username, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(u.email, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(CASE WHEN u.is_seller = 1 THEN 'seller' ELSE 'buyer' END) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(CASE WHEN u.is_restricted = 1 THEN 'restricted' ELSE 'active' END) LIKE LOWER(?) ESCAPE '\\'
    )`;

    args = [like, like, like, like, like, like];
  }

  const totalRow = await db
    .prepare(
      `SELECT COUNT(1) AS total
         FROM users u
        WHERE ${where}`,
    )
    .get(...args);

  const total = Number(totalRow?.total ?? 0);

  const rows = await db
    .prepare(
      `SELECT u.id,
              u.name,
              u.display_name AS displayName,
              u.username,
              u.is_seller AS isSeller,
              u.is_restricted AS isRestricted,
              u.created_at AS createdAt
         FROM users u
        WHERE ${where}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const users = (rows || []).map((r) => {
    const username = String(r.username ?? '').trim();
    const name =
      String(r.displayName ?? '').trim() ||
      String(r.name ?? '').trim() ||
      username ||
      'User';

    return {
      id: String(r.id),
      name,
      username,
      role: Number(r.isSeller ?? 0) === 1 ? 'Seller' : 'Buyer',
      status: Number(r.isRestricted ?? 0) === 1 ? 'Restricted' : 'Active',
    };
  });

  return res.json({ users, total, page, limit });
}

async function restrictDashboardUser(req, res) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'User id is required' });

  const row = await db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).get(id);
  if (!row) return res.status(404).json({ error: 'Not Found' });

  await db.prepare(
    `UPDATE users
        SET is_restricted = 1
      WHERE id = ?`,
  ).run(id);

  return res.json({ ok: true });
}

async function unrestrictDashboardUser(req, res) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'User id is required' });

  const row = await db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).get(id);
  if (!row) return res.status(404).json({ error: 'Not Found' });

  await db.prepare(
    `UPDATE users
        SET is_restricted = 0
      WHERE id = ?`,
  ).run(id);

  return res.json({ ok: true });
}

module.exports = {
  listDashboardUsers,
  restrictDashboardUser,
  unrestrictDashboardUser,
};
