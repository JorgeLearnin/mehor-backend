const pool = require('../db');

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );

const DEFAULT_NOTIFICATION_LIMIT = 20;
const MAX_NOTIFICATION_LIMIT = 50;

const parseLimitQueryParam = (value) => {
  if (value === undefined) {
    return { value: DEFAULT_NOTIFICATION_LIMIT };
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { error: 'Limit must be a positive integer.' };
  }

  const parsed = Number.parseInt(value, 10);

  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_NOTIFICATION_LIMIT
  ) {
    return { error: `Limit must be between 1 and ${MAX_NOTIFICATION_LIMIT}.` };
  }

  return { value: parsed };
};

const encodeCursor = ({ createdAt, id }) => {
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(createdAt).toISOString(),
      id: String(id),
    }),
    'utf8',
  ).toString('base64url');
};

const decodeCursorQueryParam = (value) => {
  if (value === undefined) {
    return { value: null };
  }

  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Invalid cursor.' };
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

    const createdAt = String(parsed?.createdAt || '').trim();
    const id = String(parsed?.id || '').trim();

    if (!createdAt || Number.isNaN(Date.parse(createdAt)) || !isUuid(id)) {
      return { error: 'Invalid cursor.' };
    }

    return {
      value: {
        createdAt,
        id,
      },
    };
  } catch {
    return { error: 'Invalid cursor.' };
  }
};

const getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;

    const rawLimit = req.query.limit;
    const rawCursor = req.query.cursor;

    const limitResult = parseLimitQueryParam(rawLimit);

    if (limitResult.error) {
      return res.status(400).json({ error: limitResult.error });
    }

    const cursorResult = decodeCursorQueryParam(rawCursor);

    if (cursorResult.error) {
      return res.status(400).json({ error: cursorResult.error });
    }

    const limit = limitResult.value;
    const cursor = cursorResult.value;

    const params = [userId];
    const whereClauses = ['user_id = $1'];

    if (cursor) {
      params.push(cursor.createdAt);
      const cursorCreatedAtParam = params.length;

      params.push(cursor.id);
      const cursorIdParam = params.length;

      whereClauses.push(`(
        created_at,
        id
      ) < (
        $${cursorCreatedAtParam}::timestamptz,
        $${cursorIdParam}::uuid
      )`);
    }

    const notificationsResult = await pool.query(
      `SELECT id, type, title, body, action_url, metadata, read_at, created_at
       FROM notifications
       WHERE ${whereClauses.join('\n         AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`,
      params,
    );

    const rows = notificationsResult.rows.slice(0, limit);
    const hasMore = notificationsResult.rows.length > limit;
    const lastRow = rows[rows.length - 1];

    const statusResult = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM notifications n
         JOIN users u ON u.id = n.user_id
         WHERE n.user_id = $1
           AND (
             u.notifications_seen_at IS NULL
             OR n.created_at > u.notifications_seen_at
           )
       ) AS has_new_notifications`,
      [userId],
    );

    return res.json({
      notifications: rows,
      hasMore,
      nextCursor:
        hasMore && lastRow
          ? encodeCursor({
              createdAt: lastRow.created_at,
              id: lastRow.id,
            })
          : null,
      hasNewNotifications: Boolean(statusResult.rows[0]?.has_new_notifications),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};

const markNotificationsSeen = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE users
       SET notifications_seen_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};

const markNotificationRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const notificationId = String(req.params.notificationId || '').trim();

    if (!isUuid(notificationId)) {
      return res.status(400).json({ error: 'Invalid notification id' });
    }

    const result = await pool.query(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2
       RETURNING id, read_at`,
      [notificationId, userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    return res.json({
      ok: true,
      notification: result.rows[0],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};

const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE notifications
       SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );

    await pool.query(
      `UPDATE users
       SET notifications_seen_at = NOW()
       WHERE id = $1`,
      [userId],
    );

    return res.json({ ok: true, updated: result.rowCount });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};

module.exports = {
  getNotifications,
  markNotificationsSeen,
  markNotificationRead,
  markAllNotificationsRead,
};
