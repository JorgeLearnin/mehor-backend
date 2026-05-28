const pool = require('../db');

const REPORT_REASON_OPTIONS = [
  'Spam or misleading content',
  'Harassment or abusive content',
  'Inappropriate content',
  'Scam or suspicious behavior',
  'Other',
];

const REPORT_TARGET_TYPES = ['listing_question', 'listing_reply', 'message'];

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const normalizeText = (value, maxLength, label) => {
  if (typeof value !== 'string') {
    return { text: '', error: `${label} is required.` };
  }

  const text = value.trim();

  if (!text) {
    return { text: '', error: `${label} is required.` };
  }

  if (text.length > maxLength) {
    return {
      text: '',
      error: `${label} must be ${maxLength} characters or less.`,
    };
  }

  return { text, error: null };
};

const getReportOptions = (_req, res) => {
  return res.json({ options: REPORT_REASON_OPTIONS });
};

const verifyReportTargetExists = async ({
  targetType,
  targetId,
  reporterId,
}) => {
  if (targetType === 'listing_question') {
    const result = await pool.query(
      `SELECT q.id
       FROM listing_questions q
       JOIN listings l ON l.id = q.listing_id
       WHERE q.id = $1::uuid
         AND q.deleted_at IS NULL
         AND l.status = 'published'
       LIMIT 1`,
      [targetId],
    );

    return result.rows.length > 0;
  }

  if (targetType === 'listing_reply') {
    const result = await pool.query(
      `SELECT r.id
       FROM listing_question_replies r
       JOIN listing_questions q ON q.id = r.question_id
       JOIN listings l ON l.id = q.listing_id
       WHERE r.id = $1::uuid
         AND r.deleted_at IS NULL
         AND q.deleted_at IS NULL
         AND l.status = 'published'
       LIMIT 1`,
      [targetId],
    );

    return result.rows.length > 0;
  }

  if (targetType === 'message') {
    const result = await pool.query(
      `SELECT m.id
       FROM messages m
       JOIN message_threads t ON t.id = m.thread_id
       WHERE m.id = $1::uuid
         AND (t.buyer_id = $2::bigint OR t.seller_id = $2::bigint)
         AND m.sender_id <> $2::bigint
       LIMIT 1`,
      [targetId, reporterId],
    );

    return result.rows.length > 0;
  }

  return false;
};

const createReport = async (req, res) => {
  try {
    const reporterId = req.user.id;

    const targetType =
      typeof req.body?.targetType === 'string'
        ? req.body.targetType.trim()
        : '';

    const targetId =
      typeof req.body?.targetId === 'string' ? req.body.targetId.trim() : '';

    const reasonResult = normalizeText(req.body?.reason, 120, 'Reason');
    const detailsResult = normalizeText(req.body?.details, 2000, 'Details');

    if (!REPORT_TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ error: 'Invalid report target.' });
    }

    if (!isUuid(targetId)) {
      return res.status(400).json({ error: 'Invalid report target.' });
    }

    if (reasonResult.error) {
      return res.status(400).json({ error: reasonResult.error });
    }

    if (!REPORT_REASON_OPTIONS.includes(reasonResult.text)) {
      return res.status(400).json({ error: 'Invalid report reason.' });
    }

    if (detailsResult.error) {
      return res.status(400).json({ error: detailsResult.error });
    }

    const targetExists = await verifyReportTargetExists({
      targetType,
      targetId,
      reporterId,
    });

    if (!targetExists) {
      return res.status(404).json({ error: 'Report target not found.' });
    }

    const result = await pool.query(
      `INSERT INTO reports (
         reporter_id,
         target_type,
         target_id,
         reason,
         details
       ) VALUES (
         $1::bigint,
         $2::text,
         $3::uuid,
         $4::text,
         $5::text
       )
       RETURNING id`,
      [reporterId, targetType, targetId, reasonResult.text, detailsResult.text],
    );

    return res.status(201).json({
      success: true,
      reportId: result.rows[0].id,
    });
  } catch (err) {
    console.error('Create report error:', err);
    return res.status(500).json({ error: 'Failed to submit report.' });
  }
};

module.exports = {
  getReportOptions,
  createReport,
};
