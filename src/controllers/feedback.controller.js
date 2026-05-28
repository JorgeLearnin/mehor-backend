const pool = require('../db');

const FEEDBACK_SUBJECT_OPTIONS = [
  'Bug report',
  'Feature request',
  'Listing experience',
  'Order experience',
  'General feedback',
];

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

const getFeedbackOptions = (_req, res) => {
  return res.json({ options: FEEDBACK_SUBJECT_OPTIONS });
};

const createFeedback = async (req, res) => {
  try {
    const userId = req.user.id;

    const subjectResult = normalizeText(req.body?.subject, 120, 'Subject');
    const messageResult = normalizeText(req.body?.message, 3000, 'Message');

    if (subjectResult.error) {
      return res.status(400).json({ error: subjectResult.error });
    }

    if (!FEEDBACK_SUBJECT_OPTIONS.includes(subjectResult.text)) {
      return res.status(400).json({ error: 'Invalid feedback subject.' });
    }

    if (messageResult.error) {
      return res.status(400).json({ error: messageResult.error });
    }

    const result = await pool.query(
      `INSERT INTO feedback_messages (
         user_id,
         subject,
         message
       ) VALUES (
         $1::bigint,
         $2::text,
         $3::text
       )
       RETURNING id`,
      [userId, subjectResult.text, messageResult.text],
    );

    return res.status(201).json({
      success: true,
      feedbackId: result.rows[0].id,
    });
  } catch (err) {
    console.error('Create feedback error:', err);
    return res.status(500).json({ error: 'Failed to submit feedback.' });
  }
};

module.exports = {
  getFeedbackOptions,
  createFeedback,
};
