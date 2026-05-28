const pool = require('../db');
const { sendTransactionalEmail } = require('../utils/email');

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const requireNonEmptyString = (value, fieldName) => {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
};

const requireFiniteNumber = (value, fieldName) => {
  const asNumber =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(asNumber)) {
    throw new Error(`${fieldName} is required`);
  }
  return asNumber;
};

async function createNotification({
  userId,
  type,
  title,
  body,
  actionUrl,
  metadata,
  db,
}) {
  const normalizedUserId = requireFiniteNumber(userId, 'userId');
  const normalizedType = requireNonEmptyString(type, 'type');
  const normalizedTitle = requireNonEmptyString(title, 'title');

  const normalizedBody = normalizeOptionalString(body);
  const normalizedActionUrl = normalizeOptionalString(actionUrl);

  const normalizedMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata
      : {};

  const queryable = db && typeof db.query === 'function' ? db : pool;

  const result = await queryable.query(
    `INSERT INTO notifications (user_id, type, title, body, action_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, type, title, body, action_url, metadata, read_at, created_at`,
    [
      normalizedUserId,
      normalizedType,
      normalizedTitle,
      normalizedBody,
      normalizedActionUrl,
      normalizedMetadata,
    ],
  );

  return result.rows[0];
}

async function createNotificationWithEmail({
  userId,
  type,
  title,
  body,
  actionUrl,
  metadata,
  emailSubject,
  emailPreview,
  emailTitle,
  emailBody,
  emailActionLabel,
  db,
}) {
  const notification = await createNotification({
    userId,
    type,
    title,
    body,
    actionUrl,
    metadata,
    db,
  });

  try {
    const queryable = db && typeof db.query === 'function' ? db : pool;

    const userResult = await queryable.query(
      `
      SELECT email
      FROM users
      WHERE id = $1
        AND status = 'active'
      LIMIT 1
      `,
      [userId],
    );

    const email = String(userResult.rows[0]?.email ?? '').trim();

    if (email) {
      await sendTransactionalEmail({
        to: email,
        subject: emailSubject || title,
        preview: emailPreview || body || title,
        title: emailTitle || title,
        body: emailBody || body || title,
        actionUrl,
        actionLabel: emailActionLabel || 'Open Mehor',
      });
    }
  } catch (error) {
    console.error('Notification email error:', error);
  }

  return notification;
}

module.exports = {
  createNotification,
  createNotificationWithEmail,
};
