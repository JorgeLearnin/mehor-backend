'use strict';

const { db } = require('../db/db');
const { getPaginationParams, escapeLike } = require('../utils/pagination');

function toText(value) {
  return String(value ?? '').trim();
}

function formatReporterLabel(row) {
  const username = toText(row?.reporterUsername);
  if (username) return username.startsWith('@') ? username : `@${username}`;

  const email = toText(row?.reporterEmail);
  if (email) return email;

  const name = toText(row?.reporterName);
  return name || 'Unknown user';
}

function formatTargetLabel(row) {
  const listingTitle = toText(row?.listingTitle);
  const targetType = toText(row?.targetType);

  if (targetType === 'listing_question') {
    return listingTitle ? `Question on ${listingTitle}` : 'Listing question';
  }

  if (targetType === 'listing_reply') {
    return listingTitle ? `Reply on ${listingTitle}` : 'Listing reply';
  }

  if (targetType === 'message') {
    return listingTitle ? `Message on ${listingTitle}` : 'Private message';
  }

  return listingTitle || 'Report';
}

function getReportRow(id) {
  return db
    .prepare(
      `SELECT id,
              reporter_email AS reporterEmail,
              reporter_username AS reporterUsername,
              reporter_name AS reporterName,
              reason,
              details,
              target_type AS targetType,
              target_id AS targetId,
              thread_id AS threadId,
              listing_id AS listingId,
              listing_title AS listingTitle,
              target_excerpt AS targetExcerpt,
              created_at AS createdAt,
              removed_at AS removedAt
         FROM report_submissions
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id);
}

function listDashboardReports(req, res) {
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
            LOWER(COALESCE(reason, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(details, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(target_type, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(listing_title, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(target_excerpt, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(reporter_email, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(reporter_username, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(reporter_name, '')) LIKE LOWER(?) ESCAPE '\\'
          )`;
    args = [like, like, like, like, like, like, like, like];
  }

  const totalRow = db
    .prepare(
      `SELECT COUNT(1) AS total
         FROM report_submissions
        WHERE ${where}`,
    )
    .get(...args);

  const total = Number(totalRow?.total ?? 0);

  const rows = db
    .prepare(
      `SELECT id,
              reporter_email AS reporterEmail,
              reporter_username AS reporterUsername,
              reporter_name AS reporterName,
              reason,
              target_type AS targetType,
              listing_title AS listingTitle,
              created_at AS createdAt
         FROM report_submissions
        WHERE ${where}
        ORDER BY COALESCE(created_at, '0000-00-00T00:00:00.000Z') DESC,
                 id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const reports = rows.map((r) => ({
    id: String(r.id),
    targetLabel: formatTargetLabel(r),
    reason: toText(r.reason),
    reporterLabel: formatReporterLabel(r),
    createdAt: r.createdAt ?? null,
  }));

  return res.json({ reports, total, page, limit });
}

function getDashboardReport(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Report id is required' });

  const row = getReportRow(id);
  if (!row?.id || row.removedAt)
    return res.status(404).json({ error: 'Not Found' });

  return res.json({
    report: {
      id: String(row.id),
      targetType: toText(row.targetType),
      targetLabel: formatTargetLabel(row),
      targetId: toText(row.targetId),
      threadId: toText(row.threadId) || null,
      listingId: toText(row.listingId) || null,
      listingTitle: toText(row.listingTitle) || null,
      targetExcerpt: toText(row.targetExcerpt) || null,
      reason: toText(row.reason),
      details: toText(row.details),
      reporterLabel: formatReporterLabel(row),
      reporterEmail: toText(row.reporterEmail) || null,
      reporterUsername: toText(row.reporterUsername) || null,
      reporterName: toText(row.reporterName) || null,
      createdAt: row.createdAt ?? null,
    },
  });
}

function removeDashboardReport(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Report id is required' });

  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE report_submissions
          SET removed_at = ?
        WHERE id = ?
          AND removed_at IS NULL`,
    )
    .run(now, id);

  if (info.changes === 0) return res.status(404).json({ error: 'Not Found' });
  return res.json({ ok: true });
}

module.exports = {
  listDashboardReports,
  getDashboardReport,
  removeDashboardReport,
};
