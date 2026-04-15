'use strict';

const crypto = require('crypto');

const { db } = require('../db/db');

const FEEDBACK_SUBJECT_OPTIONS = Object.freeze([
  'Report a bug',
  'Suggest an improvement',
  'Share a feature request',
  'Checkout or payment issue',
  'Messages or notifications issue',
  'Order or dispute issue',
  'Account or profile issue',
  'General feedback',
]);

function listFeedbackSubjectOptions(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  return res.json({ options: FEEDBACK_SUBJECT_OPTIONS });
}

async function submitFeedback(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const subject = String(req.body?.subject ?? '').trim();
  const message = String(req.body?.message ?? '').trim();
  const typeRaw = String(req.body?.type ?? '').trim();
  const type = typeRaw ? typeRaw : null;

  const orderIdRaw = String(req.body?.orderId ?? '').trim();
  const orderId = orderIdRaw ? orderIdRaw : null;
  const listingIdRaw = String(req.body?.listingId ?? '').trim();
  const listingId = listingIdRaw ? listingIdRaw : null;
  const listingTitleRaw = String(req.body?.listingTitle ?? '').trim();
  const listingTitle = listingTitleRaw ? listingTitleRaw : null;

  if (!subject) return res.status(400).json({ error: 'Subject is required' });
  if (!FEEDBACK_SUBJECT_OPTIONS.includes(subject)) {
    return res.status(400).json({ error: 'Subject is invalid' });
  }
  if (!message) return res.status(400).json({ error: 'Message is required' });

  const userRow = await db
    .prepare(`SELECT email FROM users WHERE id = ? LIMIT 1`)
    .get(userId);
  const fromEmail = userRow?.email ? String(userRow.email) : null;

  const id = `fb_${crypto.randomBytes(10).toString('hex')}`;
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO feedback_submissions (
        id,
        user_id,
        from_email,
        subject,
        message,
        type,
        order_id,
        listing_id,
        listing_title,
        created_at,
        removed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    userId,
    fromEmail,
    subject,
    message,
    type,
    orderId,
    listingId,
    listingTitle,
    now,
  );

  return res.json({ ok: true, id });
}

module.exports = { listFeedbackSubjectOptions, submitFeedback };
