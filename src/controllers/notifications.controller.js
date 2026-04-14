'use strict';

const crypto = require('crypto');
const { db } = require('../db/db');

// Only ship the core v1 types (+ mentions).
const ALLOWED_TYPES = new Set([
  // Buyer
  'buyer.order_confirmed',
  'buyer.seller_delivered_order',
  'buyer.new_message',
  'buyer.order_completed',
  'buyer.order_refunded',
  'buyer.review_ends_soon',
  'buyer.addons_review_ends_soon',
  'buyer.more_time_approval_needed',

  // Seller
  'seller.new_order_received',
  'seller.buyer_confirmed_delivery',
  'seller.new_message',
  'seller.listing_question',
  'seller.dispute_opened',
  'seller.dispute_message',
  'seller.order_canceled',
  'seller.delivery_due_soon',
  'seller.addons_due_soon',
  'seller.more_time_approval_needed',

  // Buyer dispute notifications
  'buyer.dispute_message',

  // Cross-cutting
  'mention',
  'qa.question_liked',
  'qa.question_replied',
]);

function timeAgo(iso) {
  const d = new Date(String(iso || '').trim());
  if (!Number.isFinite(d.getTime())) return 'recently';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 30) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  return `${Math.max(1, mo)}mo`;
}

function toInt(value, { min = 1, max = 200 } = {}) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function listNotifications(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const allowedTypes = Array.from(ALLOWED_TYPES);
  const typePlaceholders = allowedTypes.map(() => '?').join(', ');
  const page = toInt(req.query?.page, { min: 1, max: 100_000 }) || 1;
  const limit = toInt(req.query?.limit, { min: 1, max: 50 }) || 12;
  const offset = (page - 1) * limit;

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM notifications
        WHERE user_id = ?
          AND type IN (${typePlaceholders})`,
    )
    .get(userId, ...allowedTypes);
  const total = Number(totalRow?.total ?? 0);

  const unreadRow = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM notifications
        WHERE user_id = ?
          AND read_at IS NULL
          AND type IN (${typePlaceholders})`,
    )
    .get(userId, ...allowedTypes);
  const unreadCount = Number(unreadRow?.total ?? 0);

  const rows = db
    .prepare(
      `SELECT id,
              type,
              title,
              detail,
              entity_type AS entityType,
              entity_id AS entityId,
              data_json AS dataJson,
              read_at AS readAt,
              created_at AS createdAt
         FROM notifications
        WHERE user_id = ?
          AND type IN (${typePlaceholders})
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, ...allowedTypes, limit, offset);

  const items = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    detail: r.detail,
    time: timeAgo(r.createdAt),
    unread: !r.readAt,
    createdAt: r.createdAt,
    entity:
      r.entityType && r.entityId
        ? { type: r.entityType, id: r.entityId }
        : null,
    data: (() => {
      if (typeof r.dataJson !== 'string' || r.dataJson.trim() === '')
        return null;
      try {
        return JSON.parse(r.dataJson);
      } catch {
        return null;
      }
    })(),
  }));

  return res.json({
    items,
    unreadCount,
    total,
    page,
    limit,
    hasMore: offset + items.length < total,
  });
}

function markNotificationRead(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.notificationId ?? '').trim();
  if (!id)
    return res.status(400).json({ error: 'Notification id is required' });

  const now = new Date().toISOString();

  const result = db
    .prepare(
      `UPDATE notifications
          SET read_at = COALESCE(read_at, ?)
        WHERE id = ?
          AND user_id = ?`,
    )
    .run(now, id, userId);

  if (result.changes === 0) return res.status(404).json({ error: 'Not Found' });
  return res.json({ ok: true });
}

function markAllRead(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, ?)
      WHERE user_id = ?`,
  ).run(now, userId);

  return res.json({ ok: true });
}

function deleteAll(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  db.prepare(`DELETE FROM notifications WHERE user_id = ?`).run(userId);
  return res.json({ ok: true });
}

// Internal helper (used by other controllers)
function createNotification({
  userId,
  type,
  title,
  detail,
  entityType = null,
  entityId = null,
  data = null,
}) {
  const resolvedUserId = String(userId ?? '').trim();
  if (!resolvedUserId) return null;

  const resolvedType = String(type ?? '').trim();
  if (!resolvedType || !ALLOWED_TYPES.has(resolvedType)) return null;

  const resolvedTitle = String(title ?? '').trim();
  const resolvedDetail = String(detail ?? '').trim();
  if (!resolvedTitle || !resolvedDetail) return null;

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO notifications
        (id, user_id, type, title, detail, entity_type, entity_id, data_json, read_at, created_at)
     VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    resolvedUserId,
    resolvedType,
    resolvedTitle,
    resolvedDetail,
    entityType ? String(entityType) : null,
    entityId ? String(entityId) : null,
    data ? JSON.stringify(data) : null,
    createdAt,
  );

  return id;
}

// Internal helper (used by other controllers)
// Coalesces duplicates: if an unread notification already exists for the same
// (user,type,entityType,entityId), update it and bump created_at.
function upsertUnreadNotification({
  userId,
  type,
  title,
  detail,
  entityType = null,
  entityId = null,
  data = null,
}) {
  const resolvedUserId = String(userId ?? '').trim();
  if (!resolvedUserId) return null;

  const resolvedType = String(type ?? '').trim();
  if (!resolvedType || !ALLOWED_TYPES.has(resolvedType)) return null;

  const resolvedTitle = String(title ?? '').trim();
  const resolvedDetail = String(detail ?? '').trim();
  if (!resolvedTitle || !resolvedDetail) return null;

  const resolvedEntityType = entityType ? String(entityType) : null;
  const resolvedEntityId = entityId ? String(entityId) : null;
  const now = new Date().toISOString();

  const existing = db
    .prepare(
      `SELECT id
         FROM notifications
        WHERE user_id = ?
          AND type = ?
          AND entity_type IS ?
          AND entity_id IS ?
          AND read_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(resolvedUserId, resolvedType, resolvedEntityType, resolvedEntityId);

  if (existing?.id) {
    db.prepare(
      `UPDATE notifications
          SET title = ?,
              detail = ?,
              data_json = ?,
              created_at = ?
        WHERE id = ?
          AND user_id = ?`,
    ).run(
      resolvedTitle,
      resolvedDetail,
      data ? JSON.stringify(data) : null,
      now,
      String(existing.id),
      resolvedUserId,
    );
    return String(existing.id);
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO notifications
        (id, user_id, type, title, detail, entity_type, entity_id, data_json, read_at, created_at)
     VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    resolvedUserId,
    resolvedType,
    resolvedTitle,
    resolvedDetail,
    resolvedEntityType,
    resolvedEntityId,
    data ? JSON.stringify(data) : null,
    now,
  );

  return id;
}

module.exports = {
  listNotifications,
  markNotificationRead,
  markAllRead,
  deleteAll,
  createNotification,
  upsertUnreadNotification,
};
