const pool = require('../db');
const {
  createNotificationWithEmail,
} = require('../services/notification.service');

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const normalizeOptionalString = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isValidHttpUrl = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const allowedAttachmentKinds = ['image', 'pdf'];

const DEFAULT_THREAD_LIMIT = 30;
const MAX_THREAD_LIMIT = 50;
const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 50;

const parsePositiveIntegerQueryParam = ({
  value,
  label,
  defaultValue,
  max,
}) => {
  if (value === undefined) {
    return { value: defaultValue };
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { error: `${label} must be a positive integer.` };
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return { error: `${label} must be between 1 and ${max}.` };
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

const getThreads = async (req, res) => {
  try {
    const userId = req.user.id;

    const rawLimit = req.query.limit;
    const rawCursor = req.query.cursor;
    const rawTab = req.query.tab;
    const rawSearch = req.query.q;

    const limitResult = parsePositiveIntegerQueryParam({
      value: rawLimit,
      label: 'Limit',
      defaultValue: DEFAULT_THREAD_LIMIT,
      max: MAX_THREAD_LIMIT,
    });

    if (limitResult.error) {
      return res.status(400).json({ error: limitResult.error });
    }

    const cursorResult = decodeCursorQueryParam(rawCursor);

    if (cursorResult.error) {
      return res.status(400).json({ error: cursorResult.error });
    }

    const tab =
      typeof rawTab === 'string' &&
      ['all', 'unread', 'archived'].includes(rawTab)
        ? rawTab
        : 'all';

    if (rawSearch !== undefined) {
      if (typeof rawSearch !== 'string') {
        return res
          .status(400)
          .json({ error: 'Search query must be a string.' });
      }

      if (rawSearch.trim().length > 80) {
        return res
          .status(400)
          .json({ error: 'Search query must be 80 characters or less.' });
      }
    }

    const limit = limitResult.value;
    const cursor = cursorResult.value;
    const searchQuery = typeof rawSearch === 'string' ? rawSearch.trim() : '';

    const params = [userId];
    const whereClauses = [`(t.buyer_id = $1 OR t.seller_id = $1)`];

    if (tab === 'archived') {
      whereClauses.push(`(
        (t.buyer_id = $1 AND t.buyer_archived_at IS NOT NULL)
        OR
        (t.seller_id = $1 AND t.seller_archived_at IS NOT NULL)
      )`);
    } else if (tab === 'unread') {
      whereClauses.push(`(
        (
          t.buyer_id = $1
          AND t.buyer_archived_at IS NULL
          AND lm.id IS NOT NULL
          AND lm.sender_id <> $1
          AND (
            t.buyer_last_read_at IS NULL
            OR lm.created_at > t.buyer_last_read_at
          )
        )
        OR
        (
          t.seller_id = $1
          AND t.seller_archived_at IS NULL
          AND lm.id IS NOT NULL
          AND lm.sender_id <> $1
          AND (
            t.seller_last_read_at IS NULL
            OR lm.created_at > t.seller_last_read_at
          )
        )
      )`);
    } else {
      whereClauses.push(`(
        (t.buyer_id = $1 AND t.buyer_archived_at IS NULL)
        OR
        (t.seller_id = $1 AND t.seller_archived_at IS NULL)
      )`);
    }

    if (searchQuery) {
      params.push(`%${searchQuery}%`);
      whereClauses.push(`(
        CASE
          WHEN t.buyer_id = $1 THEN COALESCE(s.full_name, s.username, '')
          ELSE COALESCE(b.full_name, b.username, '')
        END ILIKE $${params.length}
        OR
        CASE
          WHEN t.buyer_id = $1 THEN COALESCE(s.username, '')
          ELSE COALESCE(b.username, '')
        END ILIKE $${params.length}
      )`);
    }

    if (cursor) {
      params.push(cursor.createdAt);
      const cursorCreatedAtParam = params.length;

      params.push(cursor.id);
      const cursorIdParam = params.length;

      whereClauses.push(`(
        COALESCE(t.last_message_at, t.created_at),
        t.id
      ) < (
        $${cursorCreatedAtParam}::timestamptz,
        $${cursorIdParam}::uuid
      )`);
    }

    const result = await pool.query(
      `SELECT
        t.id,
        t.origin_listing_id,
        t.origin_order_id,
        o.order_number AS origin_order_number,
        l.title AS origin_listing_title,
        l.description AS origin_listing_description,
        l.base_price_cents AS origin_listing_price_cents,
        COALESCE(o.listing_title, l.title) AS origin_context_title,
        CASE
          WHEN t.origin_order_id IS NOT NULL THEN 'order'
          WHEN t.origin_listing_id IS NOT NULL THEN 'listing'
          ELSE NULL
        END AS origin_context_type,
        (
          SELECT li.url
          FROM listing_images li
          WHERE li.listing_id = l.id
          ORDER BY li.position ASC
          LIMIT 1
        ) AS origin_listing_image,
        CASE
          WHEN t.buyer_id = $1 THEN t.buyer_archived_at IS NOT NULL
          WHEN t.seller_id = $1 THEN t.seller_archived_at IS NOT NULL
          ELSE false
        END AS archived,
        t.buyer_id,
        CASE
          WHEN b.status = 'deleted' OR b.deleted_at IS NOT NULL THEN 'Deleted user'
          ELSE COALESCE(b.full_name, b.username)
        END AS buyer_name,
        CASE
          WHEN b.status = 'deleted' OR b.deleted_at IS NOT NULL THEN NULL
          ELSE b.username
        END AS buyer_username,
        CASE
          WHEN b.status = 'deleted' OR b.deleted_at IS NOT NULL THEN NULL
          ELSE b.avatar_url
        END AS buyer_avatar_url,
        t.seller_id,
        CASE
          WHEN s.status = 'deleted' OR s.deleted_at IS NOT NULL THEN 'Deleted user'
          ELSE COALESCE(s.full_name, s.username)
        END AS seller_name,
        CASE
          WHEN s.status = 'deleted' OR s.deleted_at IS NOT NULL THEN NULL
          ELSE s.username
        END AS seller_username,
        CASE
          WHEN s.status = 'deleted' OR s.deleted_at IS NOT NULL THEN NULL
          ELSE s.avatar_url
        END AS seller_avatar_url,
        lm.body AS last_message_body,
        lm.attachment_kind AS last_message_attachment_kind,
        lm.created_at AS last_message_at,
        CASE
          WHEN t.buyer_id = $1 THEN (
            t.buyer_archived_at IS NULL
            AND lm.id IS NOT NULL
            AND lm.sender_id <> $1
            AND (t.buyer_last_read_at IS NULL OR lm.created_at > t.buyer_last_read_at)
          )
          WHEN t.seller_id = $1 THEN (
            t.seller_archived_at IS NULL
            AND lm.id IS NOT NULL
            AND lm.sender_id <> $1
            AND (t.seller_last_read_at IS NULL OR lm.created_at > t.seller_last_read_at)
          )
          ELSE false
        END AS unread,
        t.created_at,
        COALESCE(t.last_message_at, t.created_at) AS activity_at
      FROM message_threads t
      LEFT JOIN listings l ON l.id = t.origin_listing_id
      LEFT JOIN orders o ON o.id = t.origin_order_id
      JOIN users b ON b.id = t.buyer_id
      JOIN users s ON s.id = t.seller_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.sender_id, m.body, m.attachment_kind, m.created_at
        FROM messages m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) lm ON true
      WHERE ${whereClauses.join('\n        AND ')}
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC, t.id DESC
      LIMIT ${limit + 1}`,
      params,
    );

    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const lastRow = rows[rows.length - 1];

    return res.json({
      threads: rows,
      hasMore,
      nextCursor:
        hasMore && lastRow
          ? encodeCursor({
              createdAt: lastRow.activity_at,
              id: lastRow.id,
            })
          : null,
    });
  } catch (err) {
    console.error('Get message threads error:', err);
    return res.status(500).json({ error: 'Failed to get message threads' });
  }
};

const createThread = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const listingId = req.body?.listingId;
    const orderId = req.body?.orderId;

    const hasListingId = isUuid(listingId);
    const hasOrderId = isUuid(orderId);

    if (!hasListingId && !hasOrderId) {
      return res.status(400).json({
        error: 'Valid listing id or order id is required',
      });
    }

    if (hasListingId && hasOrderId) {
      return res.status(400).json({
        error: 'Use either listing id or order id, not both',
      });
    }

    let originListingId = null;
    let originOrderId = null;
    let buyerId = null;
    let sellerId = null;

    if (hasListingId) {
      const listingResult = await client.query(
        `SELECT id, seller_id
         FROM listings
         WHERE id = $1
           AND status = 'published'
         LIMIT 1`,
        [listingId],
      );

      if (listingResult.rows.length === 0) {
        return res.status(404).json({ error: 'Listing not found' });
      }

      const listing = listingResult.rows[0];

      originListingId = listing.id;
      buyerId = userId;
      sellerId = listing.seller_id;

      if (String(sellerId) === String(userId)) {
        return res
          .status(403)
          .json({ error: 'You cannot message your own listing' });
      }
    }

    if (hasOrderId) {
      const orderResult = await client.query(
        `SELECT id, listing_id, buyer_id, seller_id
         FROM orders
         WHERE id = $1
         LIMIT 1`,
        [orderId],
      );

      if (orderResult.rows.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orderResult.rows[0];

      const isBuyer = String(order.buyer_id) === String(userId);
      const isSeller = String(order.seller_id) === String(userId);

      if (!isBuyer && !isSeller) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      originListingId = order.listing_id;
      originOrderId = order.id;
      buyerId = order.buyer_id;
      sellerId = order.seller_id;
    }

    const participantStatusResult = await client.query(
      `
      SELECT id, status, deleted_at
      FROM users
      WHERE id = ANY($1::bigint[])
      `,
      [[buyerId, sellerId]],
    );

    const inactiveParticipant = participantStatusResult.rows.find(
      (row) => row.status !== 'active' || row.deleted_at,
    );

    if (inactiveParticipant) {
      return res.status(400).json({
        error: 'This account was deleted and can no longer receive messages.',
      });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const threadResult = await client.query(
      `INSERT INTO message_threads (
         origin_listing_id,
         origin_order_id,
         buyer_id,
         seller_id
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3::bigint,
         $4::bigint
       )
       ON CONFLICT (buyer_id, seller_id)
       DO UPDATE SET
         origin_listing_id = COALESCE(
           message_threads.origin_listing_id,
           EXCLUDED.origin_listing_id
         ),
         origin_order_id = COALESCE(
           EXCLUDED.origin_order_id,
           message_threads.origin_order_id
         )
       RETURNING
         id,
         buyer_id,
         seller_id,
         buyer_archived_at,
         seller_archived_at`,
      [originListingId, originOrderId, buyerId, sellerId],
    );

    const thread = threadResult.rows[0];

    const currentUserArchivedAt =
      String(thread.buyer_id) === String(userId)
        ? thread.buyer_archived_at
        : thread.seller_archived_at;

    if (currentUserArchivedAt !== null) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return res.status(409).json({
        error: 'Thread is archived. Unarchive it before messaging again.',
      });
    }

    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json({ threadId: thread.id });
  } catch (err) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }

    console.error('Create message thread error:', err);
    return res.status(500).json({ error: 'Failed to create message thread' });
  } finally {
    client.release();
  }
};

const getUnreadMessageStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT EXISTS (
        SELECT 1
        FROM message_threads t
        JOIN LATERAL (
          SELECT m.sender_id, m.created_at
          FROM messages m
          WHERE m.thread_id = t.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) lm ON true
        WHERE (
          t.buyer_id = $1
          AND t.buyer_archived_at IS NULL
          AND lm.sender_id <> $1
          AND (
            t.buyer_last_read_at IS NULL
            OR lm.created_at > t.buyer_last_read_at
          )
        )
        OR (
          t.seller_id = $1
          AND t.seller_archived_at IS NULL
          AND lm.sender_id <> $1
          AND (
            t.seller_last_read_at IS NULL
            OR lm.created_at > t.seller_last_read_at
          )
        )
      ) AS has_unread_messages`,
      [userId],
    );

    return res.json({
      hasUnreadMessages: Boolean(result.rows[0]?.has_unread_messages),
    });
  } catch (err) {
    console.error('Get unread message status error:', err);
    return res
      .status(500)
      .json({ error: 'Failed to get unread message status' });
  }
};

async function fetchThreadForUser(threadId, userId) {
  const result = await pool.query(
    `SELECT
      id,
      origin_listing_id,
      origin_order_id,
      buyer_id,
      seller_id,
      buyer_archived_at,
      seller_archived_at
    FROM message_threads
    WHERE id = $1::uuid
    LIMIT 1`,
    [threadId],
  );

  const thread = result.rows[0] || null;
  if (!thread) return { thread: null, role: null };

  if (String(thread.buyer_id) === String(userId)) {
    return { thread, role: 'buyer' };
  }

  if (String(thread.seller_id) === String(userId)) {
    return { thread, role: 'seller' };
  }

  return { thread, role: null };
}

const getThreadMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { threadId } = req.params;

    const rawLimit = req.query.limit;
    const rawCursor = req.query.cursor;

    if (!isUuid(threadId)) {
      return res.status(400).json({ error: 'Invalid thread id' });
    }

    const limitResult = parsePositiveIntegerQueryParam({
      value: rawLimit,
      label: 'Limit',
      defaultValue: DEFAULT_MESSAGE_LIMIT,
      max: MAX_MESSAGE_LIMIT,
    });

    if (limitResult.error) {
      return res.status(400).json({ error: limitResult.error });
    }

    const cursorResult = decodeCursorQueryParam(rawCursor);

    if (cursorResult.error) {
      return res.status(400).json({ error: cursorResult.error });
    }

    const { thread, role } = await fetchThreadForUser(threadId, userId);

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (!role) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const limit = limitResult.value;
    const cursor = cursorResult.value;

    const params = [threadId];
    const whereClauses = [`m.thread_id = $1::uuid`];

    if (cursor) {
      params.push(cursor.createdAt);
      const cursorCreatedAtParam = params.length;

      params.push(cursor.id);
      const cursorIdParam = params.length;

      whereClauses.push(`(
        m.created_at,
        m.id
      ) < (
        $${cursorCreatedAtParam}::timestamptz,
        $${cursorIdParam}::uuid
      )`);
    }

    const result = await pool.query(
      `SELECT
        m.id,
        m.thread_id,
        m.sender_id,
        m.body,
        m.reply_to_message_id,
        m.attachment_url,
        m.attachment_name,
        m.attachment_kind,
        m.context_type,
        m.context_data,
        m.created_at,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
          ELSE COALESCE(u.full_name, u.username)
        END AS sender_name,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
          ELSE u.username
        END AS sender_username
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE ${whereClauses.join('\n        AND ')}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit + 1}`,
      params,
    );

    const newestFirstRows = result.rows.slice(0, limit);
    const rows = newestFirstRows.reverse();
    const hasMore = result.rows.length > limit;
    const oldestRow = rows[0];

    return res.json({
      messages: rows,
      hasMore,
      nextCursor:
        hasMore && oldestRow
          ? encodeCursor({
              createdAt: oldestRow.created_at,
              id: oldestRow.id,
            })
          : null,
    });
  } catch (err) {
    console.error('Get thread messages error:', err);
    return res.status(500).json({ error: 'Failed to get messages' });
  }
};

const createMessage = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const { threadId } = req.params;

    if (!isUuid(threadId)) {
      return res.status(400).json({ error: 'Invalid thread id' });
    }

    const bodyRaw = req.body?.body;
    const attachmentUrlRaw = req.body?.attachmentUrl;
    const attachmentNameRaw = req.body?.attachmentName;
    const attachmentKindRaw = req.body?.attachmentKind;
    const replyToMessageIdRaw = req.body?.replyToMessageId;
    const contextTypeRaw = req.body?.contextType;
    const contextDataRaw = req.body?.contextData;

    const body = typeof bodyRaw === 'string' ? bodyRaw.trim() : '';

    const attachmentUrl =
      typeof attachmentUrlRaw === 'string' ? attachmentUrlRaw.trim() : '';
    const attachmentName = normalizeOptionalString(attachmentNameRaw);
    const attachmentKind = normalizeOptionalString(attachmentKindRaw);
    const replyToMessageId = normalizeOptionalString(replyToMessageIdRaw);

    const contextType = normalizeOptionalString(contextTypeRaw);
    const contextData =
      contextDataRaw &&
      typeof contextDataRaw === 'object' &&
      !Array.isArray(contextDataRaw)
        ? contextDataRaw
        : null;

    if (contextType !== null && !['listing', 'order'].includes(contextType)) {
      return res.status(400).json({ error: 'Invalid message context type' });
    }

    if ((contextType && !contextData) || (!contextType && contextData)) {
      return res.status(400).json({ error: 'Invalid message context' });
    }

    const hasBody = body.length > 0;
    const hasAttachment = attachmentUrl.length > 0;
    const hasContext = Boolean(contextType && contextData);

    if (!hasBody && !hasAttachment && !hasContext) {
      return res
        .status(400)
        .json({ error: 'Message body or attachment is required' });
    }

    if (hasAttachment) {
      if (!isValidHttpUrl(attachmentUrl)) {
        return res.status(400).json({ error: 'Invalid attachment url' });
      }

      if (!allowedAttachmentKinds.includes(attachmentKind)) {
        return res.status(400).json({
          error:
            'Attachment kind must be image or pdf when attachmentUrl is set',
        });
      }
    }

    if (replyToMessageId !== null && !isUuid(replyToMessageId)) {
      return res.status(400).json({ error: 'Invalid replyToMessageId' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const threadResult = await client.query(
      `SELECT
        t.id,
        t.buyer_id,
        t.seller_id,
        t.origin_listing_id,
        t.origin_order_id,
        t.buyer_archived_at,
        t.seller_archived_at,
        b.status AS buyer_status,
        b.deleted_at AS buyer_deleted_at,
        s.status AS seller_status,
        s.deleted_at AS seller_deleted_at
      FROM message_threads t
      JOIN users b
        ON b.id = t.buyer_id
      JOIN users s
        ON s.id = t.seller_id
      WHERE t.id = $1::uuid
      LIMIT 1`,
      [threadId],
    );

    if (threadResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Thread not found' });
    }

    const thread = threadResult.rows[0];

    const isBuyer = String(thread.buyer_id) === String(userId);
    const isSeller = String(thread.seller_id) === String(userId);

    if (!isBuyer && !isSeller) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Not allowed' });
    }

    const senderArchivedAt = isBuyer
      ? thread.buyer_archived_at
      : thread.seller_archived_at;

    if (senderArchivedAt !== null) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Thread not found' });
    }

    const recipientId = isBuyer ? thread.seller_id : thread.buyer_id;
    const recipientArchivedAt = isBuyer
      ? thread.seller_archived_at
      : thread.buyer_archived_at;

    const recipientDeleted = isBuyer
      ? thread.seller_status !== 'active' || thread.seller_deleted_at
      : thread.buyer_status !== 'active' || thread.buyer_deleted_at;

    if (recipientDeleted) {
      await client.query('ROLLBACK');
      transactionStarted = false;

      return res.status(400).json({
        error: 'This account was deleted and can no longer receive messages.',
      });
    }

    if (contextType === 'listing') {
      const contextListingId = normalizeOptionalString(contextData?.listingId);

      if (
        !contextListingId ||
        String(contextListingId) !== String(thread.origin_listing_id)
      ) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(400).json({ error: 'Invalid listing context' });
      }
    }

    if (contextType === 'order') {
      const contextOrderId = normalizeOptionalString(contextData?.orderId);

      if (
        !contextOrderId ||
        String(contextOrderId) !== String(thread.origin_order_id)
      ) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(400).json({ error: 'Invalid order context' });
      }
    }

    if (replyToMessageId) {
      const replyResult = await client.query(
        `SELECT 1
         FROM messages
         WHERE id = $1::uuid
           AND thread_id = $2::uuid
         LIMIT 1`,
        [replyToMessageId, threadId],
      );

      if (replyResult.rows.length === 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(400).json({ error: 'Invalid replyToMessageId' });
      }
    }

    const insertedResult = await client.query(
      `WITH inserted AS (
        INSERT INTO messages (
          thread_id,
          sender_id,
          body,
          reply_to_message_id,
          attachment_url,
          attachment_name,
          attachment_kind,
          context_type,
          context_data
        ) VALUES (
          $1::uuid,
          $2::bigint,
          $3::text,
          $4::uuid,
          $5::text,
          $6::text,
          $7::text,
          $8::text,
          $9::jsonb
        )
        RETURNING
          id,
          thread_id,
          sender_id,
          body,
          reply_to_message_id,
          attachment_url,
          attachment_name,
          attachment_kind,
          context_type,
          context_data,
          created_at
      )
      SELECT
        inserted.*,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
          ELSE COALESCE(u.full_name, u.username)
        END AS sender_name,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
          ELSE u.username
        END AS sender_username
      FROM inserted
      JOIN users u ON u.id = inserted.sender_id`,
      [
        threadId,
        userId,
        hasBody ? body : '',
        replyToMessageId,
        hasAttachment ? attachmentUrl : null,
        attachmentName,
        hasAttachment ? attachmentKind : null,
        contextType,
        contextData ? JSON.stringify(contextData) : null,
      ],
    );

    const createdMessage = insertedResult.rows[0];

    await client.query(
      `UPDATE message_threads
       SET last_message_at = $2
       WHERE id = $1::uuid`,
      [threadId, createdMessage.created_at],
    );

    const bodyForNotification = (() => {
      const messageBody = String(createdMessage.body || '').trim();
      if (messageBody) return messageBody;

      const messageContextType = String(
        createdMessage.context_type || '',
      ).trim();
      if (messageContextType === 'listing') return 'Sent listing details';
      if (messageContextType === 'order') return 'Sent order details';

      const kind = String(createdMessage.attachment_kind || '').trim();
      if (kind === 'image') return 'Sent an image';
      if (kind === 'pdf') return 'Sent a PDF';
      return 'Sent a message';
    })();

    if (recipientArchivedAt === null) {
      await createNotificationWithEmail({
        userId: recipientId,
        type: 'message_received',
        title: 'New message',
        body: bodyForNotification,
        actionUrl: `/messages?thread=${threadId}`,
        metadata: {
          threadId,
          messageId: createdMessage.id,
          senderId: userId,
        },
        emailSubject: 'New message on Mehor',
        emailPreview: bodyForNotification,
        emailTitle: 'You have a new message',
        emailBody: bodyForNotification,
        emailActionLabel: 'Open message',
        db: client,
      });
    }

    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json({ message: createdMessage });
  } catch (err) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    console.error('Create message error:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
};

const markThreadRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { threadId } = req.params;

    if (!isUuid(threadId)) {
      return res.status(400).json({ error: 'Invalid thread id' });
    }

    const { thread, role } = await fetchThreadForUser(threadId, userId);

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (!role) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (role === 'buyer') {
      await pool.query(
        `UPDATE message_threads
         SET buyer_last_read_at = NOW()
         WHERE id = $1::uuid`,
        [threadId],
      );
    } else {
      await pool.query(
        `UPDATE message_threads
         SET seller_last_read_at = NOW()
         WHERE id = $1::uuid`,
        [threadId],
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Mark thread read error:', err);
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
};

const archiveThread = async (req, res) => {
  try {
    const userId = req.user.id;
    const { threadId } = req.params;

    if (!isUuid(threadId)) {
      return res.status(400).json({ error: 'Invalid thread id' });
    }

    const { thread, role } = await fetchThreadForUser(threadId, userId);

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (!role) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const shouldArchive = req.body?.archived !== false;

    if (role === 'buyer') {
      await pool.query(
        `UPDATE message_threads
         SET buyer_archived_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
         WHERE id = $1::uuid`,
        [threadId, shouldArchive],
      );
    } else {
      await pool.query(
        `UPDATE message_threads
         SET seller_archived_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
         WHERE id = $1::uuid`,
        [threadId, shouldArchive],
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Archive thread error:', err);
    return res.status(500).json({ error: 'Failed to archive thread' });
  }
};

module.exports = {
  getThreads,
  createThread,
  getUnreadMessageStatus,
  getThreadMessages,
  createMessage,
  markThreadRead,
  archiveThread,
};
