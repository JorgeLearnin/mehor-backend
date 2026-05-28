const pool = require('../db');

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(
    value,
  );

const getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;

    const notificationsResult = await pool.query(
      `SELECT id, type, title, body, action_url, metadata, read_at, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [userId],
    );

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
      notifications: notificationsResult.rows,
      hasNewNotifications: Boolean(
        statusResult.rows[0]?.has_new_notifications,
      ),
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
       SET read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [notificationId, userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    return res.json({ ok: true });
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