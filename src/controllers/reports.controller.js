'use strict';

const crypto = require('crypto');

const { db } = require('../db/db');

const REPORT_REASON_OPTIONS = [
  'Scam or fraud',
  'Spam',
  'Harassment',
  'Inappropriate content',
  'Misleading information',
  'Other',
];

const REPORT_TARGET_TYPES = new Set([
  'listing_question',
  'listing_reply',
  'message',
]);

function toText(value) {
  return String(value ?? '').trim();
}

function makeExcerpt(value, max = 180) {
  const normalized = toText(value).replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function listReportReasons(req, res) {
  return res.json({ options: REPORT_REASON_OPTIONS });
}

async function resolveListingQuestionTarget(targetId, expectedThreadId) {
  const row = await db
    .prepare(
      `SELECT q.id AS targetId,
              q.id AS threadId,
              q.listing_id AS listingId,
              l.title AS listingTitle,
              q.question AS targetExcerpt
         FROM listing_questions q
         JOIN listings l ON l.id = q.listing_id
        WHERE q.id = ?
          AND (? = '' OR q.id = ?)
        LIMIT 1`,
    )
    .get(targetId, expectedThreadId, expectedThreadId);

  if (!row?.targetId) return null;
  return {
    targetId: toText(row.targetId),
    threadId: toText(row.threadId),
    listingId: toText(row.listingId) || null,
    listingTitle: toText(row.listingTitle) || null,
    targetExcerpt: makeExcerpt(row.targetExcerpt),
  };
}

async function resolveListingReplyTarget(targetId, expectedThreadId) {
  const row = await db
    .prepare(
      `SELECT r.id AS targetId,
              q.id AS threadId,
              q.listing_id AS listingId,
              l.title AS listingTitle,
              r.reply AS targetExcerpt
         FROM listing_question_replies r
         JOIN listing_questions q ON q.id = r.question_id
         JOIN listings l ON l.id = q.listing_id
        WHERE r.id = ?
          AND (? = '' OR q.id = ?)
        LIMIT 1`,
    )
    .get(targetId, expectedThreadId, expectedThreadId);

  if (!row?.targetId) return null;
  return {
    targetId: toText(row.targetId),
    threadId: toText(row.threadId),
    listingId: toText(row.listingId) || null,
    listingTitle: toText(row.listingTitle) || null,
    targetExcerpt: makeExcerpt(row.targetExcerpt),
  };
}

async function resolveMessageTarget(targetId, expectedThreadId, userId) {
  const row = await db
    .prepare(
      `SELECT m.id AS targetId,
              m.thread_id AS threadId,
              t.listing_id AS listingId,
              l.title AS listingTitle,
              CASE
                WHEN LENGTH(TRIM(COALESCE(m.body, ''))) > 0 THEN m.body
                WHEN LENGTH(TRIM(COALESCE(m.attachment_name, ''))) > 0 THEN 'Attachment: ' || m.attachment_name
                ELSE ''
              END AS targetExcerpt
         FROM message_thread_messages m
         JOIN message_threads t ON t.id = m.thread_id
         JOIN listings l ON l.id = t.listing_id
        WHERE m.id = ?
          AND (? = '' OR m.thread_id = ?)
          AND (t.buyer_id = ? OR t.seller_id = ?)
        LIMIT 1`,
    )
    .get(targetId, expectedThreadId, expectedThreadId, userId, userId);

  if (!row?.targetId) return null;
  return {
    targetId: toText(row.targetId),
    threadId: toText(row.threadId),
    listingId: toText(row.listingId) || null,
    listingTitle: toText(row.listingTitle) || null,
    targetExcerpt: makeExcerpt(row.targetExcerpt),
  };
}

async function submitReport(req, res) {
  const userId = toText(req.user?.id);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const reason = toText(req.body?.reason);
  const details = toText(req.body?.details);
  const targetType = toText(req.body?.targetType);
  const targetId = toText(req.body?.targetId);
  const threadId = toText(req.body?.threadId);

  if (!REPORT_REASON_OPTIONS.includes(reason)) {
    return res.status(400).json({ error: 'Please select a valid reason' });
  }

  if (!details) {
    return res.status(400).json({ error: 'Details are required' });
  }

  if (details.length > 2000) {
    return res.status(400).json({ error: 'Details are too long' });
  }

  if (!REPORT_TARGET_TYPES.has(targetType)) {
    return res.status(400).json({ error: 'Invalid report target' });
  }

  if (!targetId) {
    return res.status(400).json({ error: 'Report target is required' });
  }

  const reporter = await db
    .prepare(
      `SELECT id,
              email,
              username,
              COALESCE(display_name, name, '') AS reporter_name
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId);

  if (!reporter?.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let target = null;
  if (targetType === 'listing_question') {
    target = await resolveListingQuestionTarget(targetId, threadId);
  } else if (targetType === 'listing_reply') {
    target = await resolveListingReplyTarget(targetId, threadId);
  } else if (targetType === 'message') {
    target = await resolveMessageTarget(targetId, threadId, userId);
  }

  if (!target) {
    return res.status(404).json({ error: 'Report target not found' });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO report_submissions (
       id,
       reporter_user_id,
       reporter_email,
       reporter_username,
       reporter_name,
       reason,
       details,
       target_type,
       target_id,
       thread_id,
       listing_id,
       listing_title,
       target_excerpt,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    toText(reporter.email) || null,
    toText(reporter.username) || null,
    toText(reporter.reporter_name) || null,
    reason,
    details,
    targetType,
    target.targetId,
    target.threadId || null,
    target.listingId || null,
    target.listingTitle || null,
    target.targetExcerpt || null,
    now,
  );

  return res.status(201).json({ ok: true, reportId: id });
}

module.exports = {
  REPORT_REASON_OPTIONS,
  listReportReasons,
  submitReport,
};
