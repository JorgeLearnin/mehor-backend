'use strict';

const crypto = require('crypto');
const { db } = require('../db/db');
const {
  createNotification,
  upsertUnreadNotification,
} = require('./notifications.controller');
const {
  createSignedImageUploadParams,
  createSignedRawDownloadUrl,
  createSignedRawUploadParams,
} = require('../utils/cloudinary');
const { toInt } = require('../utils/order');

function toUserFullName(row) {
  const fullName = String(row.display_name ?? '').trim();
  if (fullName) return fullName;

  const username = String(row.username ?? '').trim();
  if (username) return username;

  return 'User';
}

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

function getMessageAttachmentKind({ url, publicId }) {
  const rawUrl = String(url ?? '')
    .trim()
    .toLowerCase();
  const rawPublicId = String(publicId ?? '')
    .trim()
    .toLowerCase();
  if (!rawUrl && !rawPublicId) return null;

  if (rawUrl.includes('/raw/upload/')) return 'pdf';
  if (rawUrl.includes('/image/upload/')) return 'image';
  if (rawUrl.endsWith('.pdf') || rawPublicId.endsWith('.pdf')) return 'pdf';
  return 'image';
}

function getMessageAttachmentPreviewLabel({ url, publicId, attachmentKind }) {
  const kind =
    attachmentKind || getMessageAttachmentKind({ url, publicId }) || 'image';
  return kind === 'pdf' ? 'PDF' : 'Image';
}

function toSafeAttachmentFilename(filename, fallback = 'attachment') {
  const cleaned = String(filename ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return cleaned || fallback;
}

function getAttachmentFormat({ attachmentName, url }) {
  const name = String(attachmentName ?? '').trim();
  const rawUrl = String(url ?? '').trim();
  const fromName = name.match(/\.([a-zA-Z0-9]{2,8})$/);
  if (fromName?.[1]) return fromName[1].toLowerCase();

  const fromUrl = rawUrl.match(/\.([a-zA-Z0-9]{2,8})(?:$|\?|#)/);
  if (fromUrl?.[1]) return fromUrl[1].toLowerCase();

  return '';
}

async function getThreadOr404({ threadId }) {
  const row = await db
    .prepare(
      `SELECT id,
              listing_id AS listingId,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              kind,
              order_id AS orderId,
              created_at AS createdAt,
              updated_at AS updatedAt,
              last_message_at AS lastMessageAt,
              last_message_text AS lastMessageText,
              buyer_last_read_at AS buyerLastReadAt,
              seller_last_read_at AS sellerLastReadAt,
              buyer_archived AS buyerArchived,
              seller_archived AS sellerArchived,
              buyer_deleted AS buyerDeleted,
              seller_deleted AS sellerDeleted
         FROM message_threads
        WHERE id = ?
        LIMIT 1`,
    )
    .get(threadId);

  return row || null;
}

function assertThreadParticipant({ threadRow, userId }) {
  if (!threadRow) return { ok: false, status: 404, error: 'Not Found' };
  const isBuyer = threadRow.buyerId === userId;
  const isSeller = threadRow.sellerId === userId;
  if (!isBuyer && !isSeller)
    return { ok: false, status: 403, error: 'Not authorized' };

  const deleted = isBuyer
    ? Number(threadRow.buyerDeleted) > 0
    : Number(threadRow.sellerDeleted) > 0;

  return { ok: true, isBuyer, isSeller, deleted };
}

async function listThreads(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const rows = await db
    .prepare(
      `SELECT t.id,
              t.listing_id AS legacyListingId,
              t.buyer_id AS buyerId,
              t.seller_id AS sellerId,
              COALESCE(NULLIF(t.kind, ''), 'listing') AS kind,
              t.order_id AS orderId,
              t.updated_at AS updatedAt,
              t.last_message_at AS lastMessageAt,
              t.last_message_text AS lastMessageText,
              t.buyer_last_read_at AS buyerLastReadAt,
              t.seller_last_read_at AS sellerLastReadAt,
              t.buyer_archived AS buyerArchived,
              t.seller_archived AS sellerArchived,
              t.buyer_deleted AS buyerDeleted,
              t.seller_deleted AS sellerDeleted,
              COALESCE(lr.id, l.id) AS listingId,
              COALESCE(lr.title, l.title) AS listingTitle,
              ub.username AS buyerUsername,
              ub.display_name AS buyerDisplayName,
              ub.avatar_url AS buyerAvatarUrl,
              us.username AS sellerUsername,
              us.display_name AS sellerDisplayName,
              us.avatar_url AS sellerAvatarUrl
         FROM message_threads t
         JOIN listings l ON l.id = t.listing_id
         LEFT JOIN message_thread_listing_refs r
           ON r.thread_id = t.id
          AND r.created_at = (
                SELECT MAX(r2.created_at)
                  FROM message_thread_listing_refs r2
                 WHERE r2.thread_id = t.id
              )
         LEFT JOIN listings lr ON lr.id = r.listing_id
         JOIN users ub ON ub.id = t.buyer_id
         JOIN users us ON us.id = t.seller_id
        WHERE ((t.buyer_id = ? AND t.buyer_deleted = 0)
            OR (t.seller_id = ? AND t.seller_deleted = 0))
          AND COALESCE(NULLIF(t.kind, ''), 'listing') = 'listing'
        ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
        LIMIT 200`,
    )
    .all(userId, userId);

  // Collapse legacy duplicates: keep only the most recent thread per buyer/seller pair,
  // but do NOT collapse different thread kinds (e.g. dispute threads per order).
  const seenPairs = new Set();
  const threads = [];
  for (const r of rows) {
    const pairKey = `${String(r.buyerId)}|${String(r.sellerId)}|${String(r.kind || 'listing')}|${String(r.orderId || '')}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const isBuyer = r.buyerId === userId;
    const other = isBuyer
      ? {
          username: r.sellerUsername,
          display_name: r.sellerDisplayName,
          avatar_url: r.sellerAvatarUrl,
        }
      : {
          username: r.buyerUsername,
          display_name: r.buyerDisplayName,
          avatar_url: r.buyerAvatarUrl,
        };

    const otherFullName = toUserFullName(other);
    const otherAvatarUrl = String(other.avatar_url ?? '').trim();

    const archived = isBuyer
      ? Number(r.buyerArchived) > 0
      : Number(r.sellerArchived) > 0;

    const lastReadAt = isBuyer ? r.buyerLastReadAt : r.sellerLastReadAt;
    const lastMessageAt = r.lastMessageAt;
    const unreadRaw =
      !!lastMessageAt &&
      (!lastReadAt ||
        new Date(lastReadAt).getTime() < new Date(lastMessageAt).getTime());
    // Archived threads should not contribute to unread indicators (red dots).
    const unread = archived ? false : unreadRaw;

    threads.push({
      id: r.id,
      listingId: String(r.listingId || '').trim() || String(r.legacyListingId),
      title: otherFullName,
      name: String(r.listingTitle || '').trim() || 'Listing',
      avatarUrl: otherAvatarUrl,
      preview: String(r.lastMessageText || '').trim() || 'No messages yet',
      time: lastMessageAt ? timeAgo(lastMessageAt) : timeAgo(r.updatedAt),
      lastMessageAt: lastMessageAt ? String(lastMessageAt) : null,
      unread,
      archived,
    });
  }

  return res.json({ threads });
}

async function getThreadMessages(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const threadId = req.params?.threadId;
  if (!threadId)
    return res.status(400).json({ error: 'Thread id is required' });

  const threadRow = await getThreadOr404({ threadId });
  const participant = assertThreadParticipant({ threadRow, userId });
  if (!participant.ok)
    return res.status(participant.status).json({ error: participant.error });
  if (participant.deleted) return res.status(404).json({ error: 'Not Found' });

  const limit = toInt(req.query?.limit, { min: 1, max: 100 });
  const beforeId = String(req.query?.beforeId ?? '').trim();
  const afterId = String(req.query?.afterId ?? '').trim();

  if (beforeId && afterId) {
    return res
      .status(400)
      .json({ error: 'Provide either beforeId or afterId' });
  }

  let rows = [];
  let hasMore = false;

  if (limit) {
    if (beforeId) {
      const cursor = await db
        .prepare(
          `SELECT id, created_at AS createdAt
             FROM message_thread_messages
            WHERE id = ?
              AND thread_id = ?
            LIMIT 1`,
        )
        .get(beforeId, threadId);

      if (!cursor) {
        return res.status(400).json({ error: 'Invalid beforeId' });
      }

      const fetched = await db
        .prepare(
          `SELECT id,
                  sender_id AS senderId,
                  body,
                  reply_to_id AS replyToId,
                  listing_context_json AS listingContextJson,
                  image_url AS imageUrl,
                  image_public_id AS imagePublicId,
              attachment_name AS attachmentName,
                  created_at AS createdAt
             FROM message_thread_messages
            WHERE thread_id = ?
              AND (
                created_at < ?
                OR (created_at = ? AND id < ?)
              )
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
        )
        .all(
          threadId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.id,
          limit + 1,
        );

      hasMore = fetched.length > limit;
      rows = (hasMore ? fetched.slice(0, limit) : fetched).reverse();
    } else if (afterId) {
      const cursor = await db
        .prepare(
          `SELECT id, created_at AS createdAt
             FROM message_thread_messages
            WHERE id = ?
              AND thread_id = ?
            LIMIT 1`,
        )
        .get(afterId, threadId);

      if (!cursor) {
        return res.status(400).json({ error: 'Invalid afterId' });
      }

      const fetched = await db
        .prepare(
          `SELECT id,
                  sender_id AS senderId,
                  body,
                  reply_to_id AS replyToId,
                  listing_context_json AS listingContextJson,
                  image_url AS imageUrl,
                  image_public_id AS imagePublicId,
              attachment_name AS attachmentName,
                  created_at AS createdAt
             FROM message_thread_messages
            WHERE thread_id = ?
              AND (
                created_at > ?
                OR (created_at = ? AND id > ?)
              )
            ORDER BY created_at ASC, id ASC
            LIMIT ?`,
        )
        .all(
          threadId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.id,
          limit + 1,
        );

      hasMore = fetched.length > limit;
      rows = hasMore ? fetched.slice(0, limit) : fetched;
    } else {
      const fetched = await db
        .prepare(
          `SELECT id,
                  sender_id AS senderId,
                  body,
                  reply_to_id AS replyToId,
                  listing_context_json AS listingContextJson,
                  image_url AS imageUrl,
                  image_public_id AS imagePublicId,
              attachment_name AS attachmentName,
                  created_at AS createdAt
             FROM message_thread_messages
            WHERE thread_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
        )
        .all(threadId, limit + 1);

      hasMore = fetched.length > limit;
      rows = (hasMore ? fetched.slice(0, limit) : fetched).reverse();
    }
  } else {
    rows = await db
      .prepare(
        `SELECT id,
                sender_id AS senderId,
                body,
                reply_to_id AS replyToId,
                listing_context_json AS listingContextJson,
                image_url AS imageUrl,
                image_public_id AS imagePublicId,
          attachment_name AS attachmentName,
                created_at AS createdAt
           FROM message_thread_messages
          WHERE thread_id = ?
          ORDER BY created_at ASC
          LIMIT 500`,
      )
      .all(threadId);
  }

  const messages = rows.map((m) => {
    let listingContext = null;
    const raw = String(m.listingContextJson ?? '').trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') listingContext = parsed;
      } catch {
        // ignore
      }
    }

    return {
      id: m.id,
      senderId: String(m.senderId),
      senderRole:
        String(m.senderId) === String(threadRow.buyerId)
          ? 'buyer'
          : String(m.senderId) === String(threadRow.sellerId)
            ? 'seller'
            : 'support',
      from: m.senderId === userId ? 'me' : 'them',
      body: m.body,
      replyToId: m.replyToId ? String(m.replyToId) : null,
      listingContext,
      imageUrl: m.imageUrl ? String(m.imageUrl) : null,
      attachmentName: m.attachmentName ? String(m.attachmentName) : null,
      attachmentKind: getMessageAttachmentKind({
        url: m.imageUrl,
        publicId: m.imagePublicId,
      }),
      createdAt: m.createdAt ? String(m.createdAt) : null,
      time: timeAgo(m.createdAt),
    };
  });

  // Mark as read for current viewer.
  const now = new Date().toISOString();
  if (!beforeId) {
    if (participant.isBuyer) {
      await db
        .prepare(
          `UPDATE message_threads
            SET buyer_last_read_at = COALESCE(last_message_at, buyer_last_read_at, ?),
                updated_at = updated_at
          WHERE id = ?`,
        )
        .run(now, threadId);
    } else {
      await db
        .prepare(
          `UPDATE message_threads
            SET seller_last_read_at = COALESCE(last_message_at, seller_last_read_at, ?),
                updated_at = updated_at
          WHERE id = ?`,
        )
        .run(now, threadId);
    }
  }

  return res.json({ messages, hasMore });
}

async function downloadThreadMessageAttachment(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const threadId = req.params?.threadId;
  const messageId = req.params?.messageId;
  if (!threadId)
    return res.status(400).json({ error: 'Thread id is required' });
  if (!messageId)
    return res.status(400).json({ error: 'Message id is required' });

  const threadRow = await getThreadOr404({ threadId });
  const participant = assertThreadParticipant({ threadRow, userId });
  if (!participant.ok)
    return res.status(participant.status).json({ error: participant.error });
  if (participant.deleted) return res.status(404).json({ error: 'Not Found' });

  const messageRow = await db
    .prepare(
      `SELECT image_url AS imageUrl,
              image_public_id AS imagePublicId,
              attachment_name AS attachmentName
         FROM message_thread_messages
        WHERE id = ?
          AND thread_id = ?
        LIMIT 1`,
    )
    .get(messageId, threadId);

  const attachmentUrl = String(messageRow?.imageUrl ?? '').trim();
  if (!attachmentUrl) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const attachmentKind = getMessageAttachmentKind({
    url: attachmentUrl,
    publicId: messageRow?.imagePublicId,
  });

  const requestedName = String(messageRow?.attachmentName ?? '').trim();
  const fallbackName = attachmentKind === 'pdf' ? 'document.pdf' : 'attachment';
  const filename = toSafeAttachmentFilename(requestedName, fallbackName);
  const filenameStar = requestedName
    ? encodeURIComponent(requestedName.replace(/[\r\n]/g, ' ').trim())
    : '';

  try {
    const upstreamUrl = (() => {
      if (attachmentKind === 'pdf' && messageRow?.imagePublicId) {
        const format = getAttachmentFormat({
          attachmentName: requestedName,
          url: attachmentUrl,
        });
        if (format) {
          return createSignedRawDownloadUrl({
            publicId: messageRow.imagePublicId,
            format,
          });
        }
      }
      return attachmentUrl;
    })();

    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok) {
      return res
        .status(502)
        .json({ error: `Attachment download failed (${upstream.status})` });
    }

    const contentType = String(
      upstream.headers.get('content-type') || '',
    ).trim();
    const contentLength = String(
      upstream.headers.get('content-length') || '',
    ).trim();
    const cd = filenameStar
      ? `attachment; filename="${filename}"; filename*=UTF-8''${filenameStar}`
      : `attachment; filename="${filename}"`;

    res.setHeader(
      'Content-Type',
      contentType ||
        (attachmentKind === 'pdf'
          ? 'application/pdf'
          : 'application/octet-stream'),
    );
    res.setHeader('Content-Disposition', cd);
    res.setHeader('Cache-Control', 'private, no-store');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(200).send(buffer);
  } catch (e) {
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'Attachment download failed',
    });
  }
}

async function createThreadImageUploadSignature(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const threadId = req.params?.threadId;
  if (!threadId)
    return res.status(400).json({ error: 'Thread id is required' });

  const threadRow = await getThreadOr404({ threadId });
  const participant = assertThreadParticipant({ threadRow, userId });
  if (!participant.ok)
    return res.status(participant.status).json({ error: participant.error });
  if (participant.deleted) return res.status(404).json({ error: 'Not Found' });

  const kindRaw = String(req.body?.kind ?? 'image')
    .trim()
    .toLowerCase();
  const attachmentKind = kindRaw === 'pdf' ? 'pdf' : 'image';

  try {
    const signed =
      attachmentKind === 'pdf'
        ? createSignedRawUploadParams({
            folder: `mehor/messages/${threadId}`,
            publicId: crypto.randomUUID(),
          })
        : createSignedImageUploadParams({
            folder: `mehor/messages/${threadId}`,
            publicId: crypto.randomUUID(),
          });
    return res.json({ ok: true, upload: signed });
  } catch (e) {
    if (e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED') {
      return res
        .status(500)
        .json({ error: 'Attachment uploads are not configured' });
    }
    console.error(e);
    return res
      .status(500)
      .json({ error: 'Failed to prepare attachment upload' });
  }
}

async function sendMessage(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const threadId = req.params?.threadId;
  if (!threadId)
    return res.status(400).json({ error: 'Thread id is required' });

  const threadRow = await getThreadOr404({ threadId });
  const participant = assertThreadParticipant({ threadRow, userId });
  if (!participant.ok)
    return res.status(participant.status).json({ error: participant.error });
  if (participant.deleted) return res.status(404).json({ error: 'Not Found' });

  const body = String(req.body?.body ?? '').trim();
  const replyToId = String(req.body?.replyToId ?? '').trim();
  const imageUrl = String(req.body?.imageUrl ?? '').trim();
  const imagePublicId = String(req.body?.imagePublicId ?? '').trim();
  const attachmentName = String(req.body?.attachmentName ?? '').trim();
  const attachmentKindRaw = String(req.body?.attachmentKind ?? '')
    .trim()
    .toLowerCase();
  const attachmentKind =
    attachmentKindRaw === 'pdf'
      ? 'pdf'
      : attachmentKindRaw === 'image'
        ? 'image'
        : null;
  const listingContextInput = req.body?.listingContext;

  if (!body && !imageUrl)
    return res.status(400).json({ error: 'Message is required' });
  if (body && body.length > 5_000)
    return res.status(400).json({ error: 'Message is too long' });
  if (imageUrl && !/cloudinary\.com\//i.test(imageUrl)) {
    return res.status(400).json({ error: 'Invalid attachment URL' });
  }
  if (imageUrl && !imagePublicId) {
    return res.status(400).json({ error: 'Invalid attachment' });
  }
  if (imageUrl && !attachmentKind) {
    return res.status(400).json({ error: 'Invalid attachment type' });
  }
  if (attachmentName && attachmentName.length > 255) {
    return res.status(400).json({ error: 'Attachment name is too long' });
  }
  if (imagePublicId) {
    const expectedPrefix = `mehor/messages/${threadId}/`;
    if (!imagePublicId.startsWith(expectedPrefix)) {
      return res.status(400).json({ error: 'Invalid attachment' });
    }
  }

  if (replyToId) {
    const replied = await db
      .prepare(
        `SELECT id
           FROM message_thread_messages
          WHERE id = ? AND thread_id = ?
          LIMIT 1`,
      )
      .get(replyToId, threadId);
    if (!replied) return res.status(400).json({ error: 'Invalid reply' });
  }

  let listingContextJson = null;
  if (listingContextInput != null) {
    if (!listingContextInput || typeof listingContextInput !== 'object') {
      return res.status(400).json({ error: 'Invalid listing context' });
    }

    const listingId = String(listingContextInput.listingId ?? '').trim();
    const title = String(listingContextInput.title ?? '').trim();
    const description = String(listingContextInput.description ?? '').trim();
    const priceUsdRaw = listingContextInput.priceUsd;
    const priceUsd = Number.isFinite(Number(priceUsdRaw))
      ? Math.floor(Number(priceUsdRaw))
      : NaN;

    if (!listingId || !title || !description || !Number.isFinite(priceUsd)) {
      return res.status(400).json({ error: 'Invalid listing context' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'Invalid listing context' });
    }

    const ref = await db
      .prepare(
        `SELECT 1
           FROM message_thread_listing_refs
          WHERE thread_id = ?
            AND listing_id = ?
          LIMIT 1`,
      )
      .get(threadId, listingId);
    if (!ref) return res.status(400).json({ error: 'Invalid listing context' });

    listingContextJson = JSON.stringify({
      listingId,
      title,
      description: description.slice(0, 5_000),
      priceUsd,
    });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO message_thread_messages (
        id,
        thread_id,
        sender_id,
        body,
        reply_to_id,
        listing_context_json,
        image_url,
        image_public_id,
          attachment_name,
        created_at
     )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      threadId,
      userId,
      body || '',
      replyToId || null,
      listingContextJson,
      imageUrl || null,
      imagePublicId || null,
      attachmentName || null,
      now,
    );

  const previewText = (
    body ||
    (imageUrl
      ? getMessageAttachmentPreviewLabel({
          url: imageUrl,
          publicId: imagePublicId,
          attachmentKind,
        })
      : '')
  ).slice(0, 220);

  // Update thread preview + timestamps; also un-delete the sender's copy if needed.
  if (participant.isBuyer) {
    await db
      .prepare(
        `UPDATE message_threads
          SET updated_at = ?,
              last_message_at = ?,
              last_message_text = ?,
              buyer_deleted = 0,
              buyer_last_read_at = ?,
              seller_deleted = 0
        WHERE id = ?`,
      )
      .run(now, now, previewText, now, threadId);
  } else {
    await db
      .prepare(
        `UPDATE message_threads
          SET updated_at = ?,
              last_message_at = ?,
              last_message_text = ?,
              seller_deleted = 0,
              seller_last_read_at = ?,
              buyer_deleted = 0
        WHERE id = ?`,
      )
      .run(now, now, previewText, now, threadId);
  }

  // Notifications (v1): new message + mentions.
  try {
    const otherUserId = participant.isBuyer
      ? threadRow.sellerId
      : threadRow.buyerId;

    const kind = String(threadRow.kind ?? '').trim() || 'listing';
    const orderId = String(threadRow.orderId ?? '').trim();

    const otherArchived = participant.isBuyer
      ? Number(threadRow.sellerArchived) > 0
      : Number(threadRow.buyerArchived) > 0;

    if (otherUserId && otherUserId !== userId && !otherArchived) {
      if (kind === 'dispute' && orderId) {
        await upsertUnreadNotification({
          userId: otherUserId,
          type: participant.isBuyer
            ? 'seller.dispute_message'
            : 'buyer.dispute_message',
          title: 'New dispute message',
          detail: 'You have a new message in a dispute',
          entityType: 'order',
          entityId: orderId,
          data: {
            orderId,
            threadId,
            messageId: id,
            preview: previewText,
          },
        });
      } else {
        await createNotification({
          userId: otherUserId,
          type: participant.isBuyer
            ? 'seller.new_message'
            : 'buyer.new_message',
          title: 'New message',
          detail: 'You have a new message',
          entityType: 'message_thread',
          entityId: threadId,
          data: { preview: body.slice(0, 220) },
        });
      }

      // Mention: only notify the other participant when they are @mentioned.
      const mentionMatches = body.match(/(^|\s)@([a-zA-Z0-9_]{2,30})\b/g);
      if (mentionMatches && mentionMatches.length > 0) {
        const other = await db
          .prepare(
            `SELECT id, username
               FROM users
              WHERE id = ?
              LIMIT 1`,
          )
          .get(otherUserId);

        const otherUsername = String(other?.username ?? '').trim();
        if (otherUsername) {
          const mentioned = new Set(
            mentionMatches
              .map((m) => m.trim().slice(1))
              .filter(Boolean)
              .map((m) => m.toLowerCase()),
          );

          if (mentioned.has(otherUsername.toLowerCase())) {
            await createNotification({
              userId: otherUserId,
              type: 'mention',
              title: "You've been mentioned",
              detail: 'Someone mentioned you in a message',
              entityType:
                kind === 'dispute' && orderId ? 'order' : 'message_thread',
              entityId: kind === 'dispute' && orderId ? orderId : threadId,
              data: { preview: body.slice(0, 220) },
            });
          }
        }
      }
    }
  } catch {
    // Notifications are best-effort.
  }

  return res.json({
    message: {
      id,
      senderId: String(userId),
      senderRole: participant.isBuyer ? 'buyer' : 'seller',
      from: 'me',
      body: body || '',
      replyToId: replyToId || null,
      listingContext: listingContextJson
        ? JSON.parse(listingContextJson)
        : null,
      imageUrl: imageUrl || null,
      attachmentName: attachmentName || null,
      attachmentKind:
        attachmentKind ||
        getMessageAttachmentKind({ url: imageUrl, publicId: imagePublicId }),
      createdAt: now,
      time: timeAgo(now),
    },
  });
}

async function setThreadArchived(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const threadId = req.params?.threadId;
  if (!threadId)
    return res.status(400).json({ error: 'Thread id is required' });

  const archived = Boolean(req.body?.archived);

  const threadRow = await getThreadOr404({ threadId });
  const participant = assertThreadParticipant({ threadRow, userId });
  if (!participant.ok)
    return res.status(participant.status).json({ error: participant.error });
  if (participant.deleted) return res.status(404).json({ error: 'Not Found' });

  if (participant.isBuyer) {
    await db
      .prepare(`UPDATE message_threads SET buyer_archived = ? WHERE id = ?`)
      .run(archived ? 1 : 0, threadId);
  } else {
    await db
      .prepare(`UPDATE message_threads SET seller_archived = ? WHERE id = ?`)
      .run(archived ? 1 : 0, threadId);
  }

  return res.json({ ok: true });
}

async function setThreadReadState(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const threadId = req.params?.threadId;
  if (!threadId)
    return res.status(400).json({ error: 'Thread id is required' });

  const read = Boolean(req.body?.read);

  const threadRow = await getThreadOr404({ threadId });
  const participant = assertThreadParticipant({ threadRow, userId });
  if (!participant.ok)
    return res.status(participant.status).json({ error: participant.error });
  if (participant.deleted) return res.status(404).json({ error: 'Not Found' });

  if (read) {
    const stamp = threadRow.lastMessageAt || new Date().toISOString();
    if (participant.isBuyer) {
      await db
        .prepare(
          `UPDATE message_threads SET buyer_last_read_at = ? WHERE id = ?`,
        )
        .run(stamp, threadId);
    } else {
      await db
        .prepare(
          `UPDATE message_threads SET seller_last_read_at = ? WHERE id = ?`,
        )
        .run(stamp, threadId);
    }
  } else {
    // Force unread by clearing last_read_at.
    if (participant.isBuyer) {
      await db
        .prepare(
          `UPDATE message_threads SET buyer_last_read_at = NULL WHERE id = ?`,
        )
        .run(threadId);
    } else {
      await db
        .prepare(
          `UPDATE message_threads SET seller_last_read_at = NULL WHERE id = ?`,
        )
        .run(threadId);
    }
  }

  return res.json({ ok: true });
}

async function createOrGetThread(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = String(req.body?.listingId ?? '').trim();
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id, seller_id AS sellerId, title, status
         FROM listings
        WHERE id = ?
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });
  if (String(listingRow.sellerId) === String(userId))
    return res.status(400).json({ error: 'Cannot message yourself' });

  const existing = await db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE buyer_id = ?
          AND seller_id = ?
          AND kind = 'listing'
        ORDER BY COALESCE(last_message_at, updated_at) DESC
        LIMIT 1`,
    )
    .get(userId, listingRow.sellerId);

  let threadId = existing?.id;
  const now = new Date().toISOString();
  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO message_threads (id, listing_id, buyer_id, seller_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, listingId, userId, listingRow.sellerId, now, now);
  } else {
    // Ensure it's visible for the creator if it was previously deleted.
    await db
      .prepare(
        `UPDATE message_threads
          SET buyer_deleted = 0
        WHERE id = ?`,
      )
      .run(threadId);
  }

  // Record listing context (accumulates across multiple listing pages).
  await db
    .prepare(
      `INSERT INTO message_thread_listing_refs (thread_id, listing_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id, listing_id) DO UPDATE SET created_at = excluded.created_at`,
    )
    .run(threadId, listingId, now);

  return res.json({ ok: true, thread: { id: threadId } });
}

async function createOrGetThreadByOrder(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.body?.orderId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });

  const orderRow = await db
    .prepare(
      `SELECT id, listing_id AS listingId, buyer_id AS buyerId, seller_id AS sellerId
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!orderRow) return res.status(404).json({ error: 'Not Found' });

  const buyerId = String(orderRow.buyerId);
  const sellerId = String(orderRow.sellerId);
  const listingId = String(orderRow.listingId);

  const isBuyer = buyerId === String(userId);
  const isSeller = sellerId === String(userId);
  if (!isBuyer && !isSeller)
    return res.status(403).json({ error: 'Forbidden' });

  const existing = await db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE buyer_id = ?
          AND seller_id = ?
          AND kind = 'listing'
        ORDER BY COALESCE(last_message_at, updated_at) DESC
        LIMIT 1`,
    )
    .get(buyerId, sellerId);

  let threadId = existing?.id;
  const now = new Date().toISOString();
  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO message_threads (id, listing_id, buyer_id, seller_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, listingId, buyerId, sellerId, now, now);
  } else {
    // Ensure it's visible for the participant if it was previously deleted.
    if (isBuyer) {
      await db
        .prepare(
          `UPDATE message_threads
            SET buyer_deleted = 0
          WHERE id = ?`,
        )
        .run(threadId);
    }
    if (isSeller) {
      await db
        .prepare(
          `UPDATE message_threads
            SET seller_deleted = 0
          WHERE id = ?`,
        )
        .run(threadId);
    }
  }

  // Keep listing context available in the thread.
  await db
    .prepare(
      `INSERT INTO message_thread_listing_refs (thread_id, listing_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id, listing_id) DO UPDATE SET created_at = excluded.created_at`,
    )
    .run(threadId, listingId, now);

  return res.json({ ok: true, thread: { id: threadId } });
}

async function createOrGetDisputeThreadByOrder(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.body?.orderId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });

  const stageRaw = String(req.body?.stage ?? '')
    .trim()
    .toLowerCase();
  const stage = stageRaw === 'addons' ? 'addons' : 'delivery';

  const orderRow = await db
    .prepare(
      `SELECT id,
              listing_id AS listingId,
              buyer_id AS buyerId,
              seller_id AS sellerId
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!orderRow) return res.status(404).json({ error: 'Not Found' });

  const buyerId = String(orderRow.buyerId);
  const sellerId = String(orderRow.sellerId);
  const listingId = String(orderRow.listingId);

  const isBuyer = buyerId === String(userId);
  const isSeller = sellerId === String(userId);
  if (!isBuyer && !isSeller)
    return res.status(403).json({ error: 'Forbidden' });

  // If the thread already exists, always return it (even if the dispute was resolved).
  // This keeps the dispute discussion readable after approval.
  const existing = await db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE kind = 'dispute'
          AND order_id = ?
          AND COALESCE(NULLIF(dispute_stage, ''), 'delivery') = ?
        LIMIT 1`,
    )
    .get(orderId, stage);

  let threadId = existing?.id;
  const now = new Date().toISOString();
  if (threadId) {
    // Ensure it's visible for the participant if it was previously deleted.
    if (isBuyer) {
      await db
        .prepare(
          `UPDATE message_threads
            SET buyer_deleted = 0
          WHERE id = ?`,
        )
        .run(threadId);
    }
    if (isSeller) {
      await db
        .prepare(
          `UPDATE message_threads
            SET seller_deleted = 0
          WHERE id = ?`,
        )
        .run(threadId);
    }

    // Keep listing context available in the thread.
    await db
      .prepare(
        `INSERT INTO message_thread_listing_refs (thread_id, listing_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id, listing_id) DO UPDATE SET created_at = excluded.created_at`,
      )
      .run(threadId, listingId, now);

    return res.json({ ok: true, thread: { id: threadId } });
  }

  // Only allow creating a new thread while the dispute is open.
  const openDispute = await db
    .prepare(
      `SELECT id
         FROM order_disputes
        WHERE order_id = ?
          AND stage = ?
          AND resolved_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1`,
    )
    .get(orderId, stage);

  if (!openDispute?.id) {
    return res.status(400).json({ error: 'Dispute is not open' });
  }

  if (!threadId) {
    threadId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO message_threads (
          id,
          listing_id,
          buyer_id,
          seller_id,
          kind,
          order_id,
          dispute_stage,
          created_at,
          updated_at
       )
       VALUES (?, ?, ?, ?, 'dispute', ?, ?, ?, ?)`,
      )
      .run(threadId, listingId, buyerId, sellerId, orderId, stage, now, now);
  } else {
    // Ensure it's visible for the participant if it was previously deleted.
    if (isBuyer) {
      await db
        .prepare(
          `UPDATE message_threads
            SET buyer_deleted = 0
          WHERE id = ?`,
        )
        .run(threadId);
    }
    if (isSeller) {
      await db
        .prepare(
          `UPDATE message_threads
            SET seller_deleted = 0
          WHERE id = ?`,
        )
        .run(threadId);
    }
  }

  // Keep listing context available in the thread.
  await db
    .prepare(
      `INSERT INTO message_thread_listing_refs (thread_id, listing_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id, listing_id) DO UPDATE SET created_at = excluded.created_at`,
    )
    .run(threadId, listingId, now);

  return res.json({ ok: true, thread: { id: threadId } });
}

module.exports = {
  listThreads,
  getThreadMessages,
  downloadThreadMessageAttachment,
  createThreadImageUploadSignature,
  sendMessage,
  setThreadArchived,
  setThreadReadState,
  createOrGetThread,
  createOrGetThreadByOrder,
  createOrGetDisputeThreadByOrder,
};
