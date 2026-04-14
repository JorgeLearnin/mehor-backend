'use strict';

const { db } = require('../db/db');
const { getPaginationParams, escapeLike } = require('../utils/pagination');

function listDashboardFeedback(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const qRaw = typeof req.query?.q === 'string' ? req.query.q : '';
  const q = qRaw.trim().toLowerCase();
  const { page, limit, offset } = getPaginationParams(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
  });

  let where = 'removed_at IS NULL';
  let args = [];

  if (q) {
    const like = `%${escapeLike(q)}%`;
    where = `${where}
          AND (
            LOWER(COALESCE(subject, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(from_email, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(created_at, '')) LIKE LOWER(?) ESCAPE '\\'
          )`;
    args = [like, like, like];
  }

  const totalRow = db
    .prepare(
      `SELECT COUNT(1) AS total
         FROM feedback_submissions
        WHERE ${where}`,
    )
    .get(...args);

  const total = Number(totalRow?.total ?? 0);

  const rows = db
    .prepare(
      `SELECT id,
              subject,
              COALESCE(from_email, '') AS fromEmail,
              created_at AS createdAt
         FROM feedback_submissions
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const feedback = rows.map((r) => ({
    id: String(r.id),
    subject: String(r.subject ?? ''),
    from: String(r.fromEmail ?? '').trim() || '—',
    createdAt: r.createdAt ?? null,
  }));

  return res.json({ feedback, total, page, limit });
}

function getDashboardFeedback(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Feedback id is required' });

  const row = db
    .prepare(
      `SELECT id,
              subject,
              COALESCE(from_email, '') AS fromEmail,
              message,
              type,
              order_id AS orderId,
              listing_title AS listingTitle,
              created_at AS createdAt
         FROM feedback_submissions
        WHERE id = ?
          AND removed_at IS NULL
        LIMIT 1`,
    )
    .get(id);

  if (!row?.id) return res.status(404).json({ error: 'Not Found' });

  return res.json({
    feedback: {
      id: String(row.id),
      subject: String(row.subject ?? ''),
      from: String(row.fromEmail ?? '').trim() || '—',
      createdAt: row.createdAt ?? null,
      message: row.message ?? null,
      type: row.type ?? null,
      orderId: row.orderId ?? null,
      listingTitle: row.listingTitle ?? null,
    },
  });
}

function removeDashboardFeedback(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Feedback id is required' });

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE feedback_submissions
          SET removed_at = ?
        WHERE id = ?
          AND removed_at IS NULL`,
    )
    .run(now, id);

  if (info.changes === 0) return res.status(404).json({ error: 'Not Found' });

  return res.json({ ok: true });
}

module.exports = {
  listDashboardFeedback,
  getDashboardFeedback,
  removeDashboardFeedback,
};
