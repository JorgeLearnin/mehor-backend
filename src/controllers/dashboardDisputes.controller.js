'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');
const { db } = require('../db/db');
const {
  createSignedImageUploadParams,
  createSignedRawDownloadUrl,
  createSignedRawUploadParams,
} = require('../utils/cloudinary');
const { getPaginationParams, escapeLike } = require('../utils/pagination');
const {
  getSellerPlatformFeeBps,
  getBuyerServiceFeeBps,
  computeFeeUsd,
} = require('../utils/fees');

const SUPPORT_USER_ID = 'mehor_support_user';

function normalizeDisputeStage(input) {
  const v = String(input ?? '')
    .trim()
    .toLowerCase();
  return v === 'addons' ? 'addons' : 'delivery';
}

function computeSubtotalUsd({ listingPriceUsd, addOnsTotalUsd }) {
  const listing = Number(listingPriceUsd ?? 0);
  const addOns = Number(addOnsTotalUsd ?? 0);
  return Math.max(0, listing + addOns);
}

function getDisputeAttachmentKind({ url, publicId }) {
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

function getDisputeAttachmentPreviewLabel({ url, publicId, attachmentKind }) {
  const kind =
    attachmentKind || getDisputeAttachmentKind({ url, publicId }) || 'image';
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

function ensureDisputeThread({
  orderId,
  listingId,
  buyerId,
  sellerId,
  stage,
  now,
}) {
  const disputeStage = normalizeDisputeStage(stage);
  let threadRow = db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE kind = 'dispute'
          AND order_id = ?
          AND COALESCE(NULLIF(dispute_stage, ''), 'delivery') = ?
        LIMIT 1`,
    )
    .get(orderId, disputeStage);

  if (threadRow?.id) return String(threadRow.id);

  const newThreadId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO message_threads (
          id,
          listing_id,
          buyer_id,
          seller_id,
          kind,
          order_id,
          dispute_stage,
          created_at,
          updated_at,
          last_message_at,
          last_message_text
        ) VALUES (?, ?, ?, ?, 'dispute', ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    newThreadId,
    String(listingId),
    String(buyerId),
    String(sellerId),
    orderId,
    disputeStage,
    now,
    now,
  );

  return newThreadId;
}

function insertSupportThreadMessage({ threadId, body, now }) {
  const messageId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO message_thread_messages (
        id,
        thread_id,
        sender_id,
        body,
        image_url,
        image_public_id,
        created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(messageId, threadId, SUPPORT_USER_ID, body, now);

  db.prepare(
    `UPDATE message_threads
        SET updated_at = ?,
            last_message_at = ?,
            last_message_text = ?
      WHERE id = ?`,
  ).run(now, now, String(body || '').slice(0, 500), threadId);

  return messageId;
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

function toCentsUsd(amountUsd) {
  const n = Number.parseInt(String(amountUsd ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * 100;
}

async function createRefundSafe({ stripe, paymentIntentId, amountUsd }) {
  const id = String(paymentIntentId ?? '').trim();
  if (!id) throw new Error('Missing payment intent id');

  const baseParams = {
    payment_intent: id,
    amount: toCentsUsd(amountUsd),
    reason: 'requested_by_customer',
  };

  const withConnectParams = {
    ...baseParams,
    reverse_transfer: true,
  };

  try {
    const r = await stripe.refunds.create(withConnectParams);
    return { refundId: r?.id ?? null };
  } catch {
    const r = await stripe.refunds.create(baseParams);
    return { refundId: r?.id ?? null };
  }
}

function ensureSupportUser() {
  const existing = db
    .prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`)
    .get(SUPPORT_USER_ID);
  if (existing?.id) return;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, provider, provider_id, name, username, display_name, avatar_url, created_at)
     VALUES (?, NULL, NULL, 'system', NULL, 'Mehor Support', 'mehor-support', 'Mehor Support', NULL, ?)`,
  ).run(SUPPORT_USER_ID, now);
}

function listDashboardDisputes(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const qRaw = typeof req.query?.q === 'string' ? req.query.q : '';
  const q = qRaw.trim().toLowerCase();
  const { page, limit, offset } = getPaginationParams(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
  });

  let where = `o.dispute_opened_at IS NOT NULL
          AND o.dispute_resolved_at IS NULL`;
  let args = [];

  if (q) {
    const like = `%${escapeLike(q)}%`;
    where = `${where}
          AND (
            LOWER(COALESCE(o.order_number, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(l.title, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(b.name, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(b.username, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(b.email, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(s.name, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(s.username, '')) LIKE LOWER(?) ESCAPE '\\'
            OR LOWER(COALESCE(s.email, '')) LIKE LOWER(?) ESCAPE '\\'
          )`;
    args = [like, like, like, like, like, like, like, like];
  }

  const totalRow = db
    .prepare(
      `SELECT COUNT(1) AS total
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         JOIN users b ON b.id = o.buyer_id
         JOIN users s ON s.id = o.seller_id
        WHERE ${where}`,
    )
    .get(...args);

  const total = Number(totalRow?.total ?? 0);

  const rows = db
    .prepare(
      `SELECT o.id AS orderId,
              o.order_number AS orderNumber,
              o.status AS orderStatus,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_opened_stage AS disputeOpenedStage,
              o.dispute_edited_at AS disputeEditedAt,
              o.dispute_reason AS disputeReason,
              o.dispute_other_reason AS disputeOtherReason,
              o.dispute_message AS disputeMessage,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.total_usd AS totalUsd,
              COALESCE(o.refunded_usd, 0) AS refundedUsd,
              COALESCE(o.refunded_subtotal_usd, COALESCE(o.refunded_usd, 0)) AS refundedSubtotalUsd,
              COALESCE(o.payout_status, 'unpaid') AS payoutStatus,
              o.seller_platform_fee_bps AS sellerPlatformFeeBps,
              o.buyer_service_fee_bps AS buyerServiceFeeBps,
              COALESCE(o.seller_paid_out_usd, 0) AS sellerPaidOutUsd,
              l.id AS listingId,
              l.title AS listingTitle,
              b.id AS buyerId,
              b.name AS buyerName,
              b.username AS buyerUsername,
              b.email AS buyerEmail,
              s.id AS sellerId,
              s.name AS sellerName,
              s.username AS sellerUsername,
              s.email AS sellerEmail
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         JOIN users b ON b.id = o.buyer_id
         JOIN users s ON s.id = o.seller_id
        WHERE ${where}
        ORDER BY o.dispute_opened_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const disputes = rows.map((r) => {
    const listingPriceUsd = Number(r.listingPriceUsd ?? 0);
    const addOnsTotalUsd = Number(r.addOnsTotalUsd ?? 0);
    const subtotalUsd = Math.max(0, listingPriceUsd + addOnsTotalUsd);

    const totalUsd = Number(r.totalUsd ?? 0);
    const refundedSubtotalUsd = Math.max(0, Number(r.refundedSubtotalUsd ?? 0));
    const refundedUsd = Math.max(
      Math.max(0, Number(r.refundedUsd ?? 0)),
      refundedSubtotalUsd,
    );

    const buyerServiceFeeBpsRaw = Number.parseInt(
      String(r.buyerServiceFeeBps ?? ''),
      10,
    );
    const buyerServiceFeeBps = Number.isFinite(buyerServiceFeeBpsRaw)
      ? Math.max(0, Math.min(10_000, buyerServiceFeeBpsRaw))
      : getBuyerServiceFeeBps();
    const buyerServiceFeeUsd = computeFeeUsd({
      amountUsd: subtotalUsd,
      feeBps: buyerServiceFeeBps,
    });

    const keptSubtotalUsd = Math.max(0, subtotalUsd - refundedSubtotalUsd);
    const bpsRaw = Number.parseInt(String(r.sellerPlatformFeeBps ?? ''), 10);
    const feeBps = Number.isFinite(bpsRaw) ? bpsRaw : getSellerPlatformFeeBps();

    // IMPORTANT: seller platform fee is computed from the original subtotal,
    // not the post-refund kept amount (promo orders will have feeBps=0).
    const platformFeeUsd = computeFeeUsd({
      amountUsd: subtotalUsd,
      feeBps,
    });
    const sellerNetUsd = Math.max(0, keptSubtotalUsd - platformFeeUsd);

    const payoutStatus = String(r.payoutStatus ?? 'unpaid');
    const paidOutUsdRaw = Number(r.sellerPaidOutUsd ?? 0);
    const sellerPaidOutUsd =
      payoutStatus === 'paid'
        ? sellerNetUsd
        : payoutStatus === 'partial'
          ? Math.max(0, Math.min(sellerNetUsd, paidOutUsdRaw))
          : 0;

    return {
      orderId: String(r.orderId),
      orderNumber: r.orderNumber ?? null,
      orderStatus: r.orderStatus ?? null,
      openedStage: r.disputeOpenedStage ?? null,
      disputeOpenedAt: r.disputeOpenedAt ?? null,
      disputeOpenedStage: r.disputeOpenedStage ?? null,
      disputeEditedAt: r.disputeEditedAt ?? null,
      disputeReason: r.disputeReason ?? null,
      disputeOtherReason: r.disputeOtherReason ?? null,
      disputeMessage: r.disputeMessage ?? null,
      subtotalUsd,
      buyerServiceFeeUsd,
      totalUsd,
      refundedUsd,
      refundedSubtotalUsd,
      payoutStatus,
      sellerPaidOutUsd,
      sellerPlatformFeeBps: feeBps,
      buyerServiceFeeBps,
      listing: { id: r.listingId ?? null, title: r.listingTitle ?? null },
      buyer: {
        id: r.buyerId ?? null,
        name: r.buyerName ?? null,
        username: r.buyerUsername ?? null,
        email: r.buyerEmail ?? null,
      },
      seller: {
        id: r.sellerId ?? null,
        name: r.sellerName ?? null,
        username: r.sellerUsername ?? null,
        email: r.sellerEmail ?? null,
      },
    };
  });

  return res.json({ disputes, total, page, limit });
}

function listDashboardDisputeMessages(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.orderId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });
  const disputeStage = normalizeDisputeStage(req.query?.stage);

  const orderRow = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!orderRow?.id) return res.status(404).json({ error: 'Not Found' });

  const disputeRow = db
    .prepare(
      `SELECT opened_at AS openedAt,
              message
         FROM order_disputes
        WHERE order_id = ?
          AND stage = ?
          AND resolved_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1`,
    )
    .get(orderId, disputeStage);

  if (!disputeRow?.openedAt) {
    return res.status(404).json({ error: 'Dispute discussion not found' });
  }

  const threadRow = db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE kind = 'dispute'
          AND order_id = ?
          AND COALESCE(NULLIF(dispute_stage, ''), 'delivery') = ?
        LIMIT 1`,
    )
    .get(orderId, disputeStage);

  const seedBody = String(disputeRow.message ?? '').trim();
  const seed =
    seedBody && String(disputeRow.openedAt || '').trim()
      ? {
          id: `dispute-opened:${String(orderRow.id)}`,
          senderId: String(orderRow.buyerId ?? ''),
          body: seedBody,
          createdAt: String(disputeRow.openedAt),
        }
      : null;

  const threadId = threadRow?.id ? String(threadRow.id) : null;

  const threadMessages = threadId
    ? db
        .prepare(
          `SELECT m.id,
                  m.sender_id AS senderId,
                  m.body,
                  m.image_url AS imageUrl,
                  m.image_public_id AS imagePublicId,
              m.attachment_name AS attachmentName,
                  m.created_at AS createdAt
             FROM message_thread_messages m
            WHERE m.thread_id = ?
            ORDER BY m.created_at ASC
            LIMIT 500`,
        )
        .all(threadId)
        .map((m) => ({
          id: String(m.id),
          senderId: String(m.senderId),
          body: String(m.body ?? ''),
          imageUrl: m.imageUrl ? String(m.imageUrl) : null,
          imagePublicId: m.imagePublicId ? String(m.imagePublicId) : null,
          attachmentName: m.attachmentName ? String(m.attachmentName) : null,
          attachmentKind: getDisputeAttachmentKind({
            url: m.imageUrl,
            publicId: m.imagePublicId,
          }),
          createdAt: m.createdAt ?? null,
        }))
    : [];

  const messages = (() => {
    if (!seed) return threadMessages;
    const first = threadMessages[0];
    if (
      first &&
      String(first.senderId).trim() === String(seed.senderId).trim() &&
      String(first.body).trim() === String(seed.body).trim()
    ) {
      return threadMessages;
    }
    return [seed, ...threadMessages];
  })();

  return res.json({ threadId, messages });
}

async function downloadDashboardDisputeAttachment(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.orderId ?? '').trim();
  const messageId = String(req.params?.messageId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });
  if (!messageId)
    return res.status(400).json({ error: 'Message id is required' });

  const disputeStage = normalizeDisputeStage(req.query?.stage);
  const threadRow = db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE kind = 'dispute'
          AND order_id = ?
          AND COALESCE(NULLIF(dispute_stage, ''), 'delivery') = ?
        LIMIT 1`,
    )
    .get(orderId, disputeStage);

  if (!threadRow?.id) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const messageRow = db
    .prepare(
      `SELECT image_url AS imageUrl,
              image_public_id AS imagePublicId,
              attachment_name AS attachmentName
         FROM message_thread_messages
        WHERE id = ?
          AND thread_id = ?
        LIMIT 1`,
    )
    .get(messageId, String(threadRow.id));

  const attachmentUrl = String(messageRow?.imageUrl ?? '').trim();
  if (!attachmentUrl) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const attachmentKind = getDisputeAttachmentKind({
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

function createDashboardDisputeImageUploadSignature(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.orderId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });
  const disputeStage = normalizeDisputeStage(req.query?.stage);
  const kindRaw = String(req.body?.kind ?? '')
    .trim()
    .toLowerCase();
  const attachmentKind = kindRaw === 'pdf' ? 'pdf' : 'image';

  const orderRow = db
    .prepare(
      `SELECT id,
              listing_id AS listingId,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              dispute_opened_at AS disputeOpenedAt
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!orderRow?.id) return res.status(404).json({ error: 'Not Found' });
  const openDispute = db
    .prepare(
      `SELECT id
         FROM order_disputes
        WHERE order_id = ?
          AND stage = ?
          AND resolved_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1`,
    )
    .get(orderId, disputeStage);

  if (!String(orderRow.disputeOpenedAt ?? '').trim() || !openDispute?.id) {
    return res
      .status(409)
      .json({ error: 'Dispute is not opened for this order' });
  }

  const now = new Date().toISOString();
  const threadId = ensureDisputeThread({
    orderId,
    listingId: orderRow.listingId,
    buyerId: orderRow.buyerId,
    sellerId: orderRow.sellerId,
    stage: disputeStage,
    now,
  });

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
    return res.json({ ok: true, threadId, upload: signed });
  } catch (e) {
    if (e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED') {
      return res
        .status(500)
        .json({ error: 'Image uploads are not configured' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to prepare image upload' });
  }
}

async function sendDashboardDisputeMessage(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.orderId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });
  const disputeStage = normalizeDisputeStage(req.query?.stage);

  const body = String(req.body?.body ?? '').trim();
  const imageUrl = String(req.body?.imageUrl ?? '').trim();
  const imagePublicId = String(req.body?.imagePublicId ?? '').trim();
  const attachmentKindRaw = String(req.body?.attachmentKind ?? '')
    .trim()
    .toLowerCase();
  const attachmentKind =
    attachmentKindRaw === 'pdf'
      ? 'pdf'
      : attachmentKindRaw === 'image'
        ? 'image'
        : null;
  const attachmentName = toSafeAttachmentFilename(
    String(req.body?.attachmentName ?? '').trim(),
    '',
  );

  if (!body && !imageUrl) {
    return res.status(400).json({ error: 'Message body or image is required' });
  }
  if (body && body.length > 5_000) {
    return res.status(400).json({ error: 'Message is too long' });
  }
  if (imageUrl && !/cloudinary\.com\//i.test(imageUrl)) {
    return res.status(400).json({ error: 'Invalid image URL' });
  }
  if (imageUrl && !imagePublicId) {
    return res.status(400).json({ error: 'Invalid image' });
  }
  if (imageUrl && !attachmentKind) {
    return res.status(400).json({ error: 'Invalid attachment type' });
  }
  if (attachmentName && attachmentName.length > 255) {
    return res.status(400).json({ error: 'Attachment name is too long' });
  }

  const orderRow = db
    .prepare(
      `SELECT id,
              listing_id AS listingId,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              dispute_opened_at AS disputeOpenedAt
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!orderRow?.id) return res.status(404).json({ error: 'Not Found' });
  const openDispute = db
    .prepare(
      `SELECT id
         FROM order_disputes
        WHERE order_id = ?
          AND stage = ?
          AND resolved_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1`,
    )
    .get(orderId, disputeStage);

  if (!String(orderRow.disputeOpenedAt ?? '').trim() || !openDispute?.id) {
    return res
      .status(409)
      .json({ error: 'Dispute is not opened for this order' });
  }

  ensureSupportUser();

  const now = new Date().toISOString();

  const threadId = ensureDisputeThread({
    orderId,
    listingId: orderRow.listingId,
    buyerId: orderRow.buyerId,
    sellerId: orderRow.sellerId,
    stage: disputeStage,
    now,
  });
  const messageId = crypto.randomUUID();

  let nextImageUrl = imageUrl || null;
  let nextImagePublicId = imagePublicId || null;

  if (nextImagePublicId) {
    const expectedPrefix = `mehor/messages/${threadId}/`;
    if (!nextImagePublicId.startsWith(expectedPrefix)) {
      return res.status(400).json({ error: 'Invalid image' });
    }
  }

  db.prepare(
    `INSERT INTO message_thread_messages (
        id,
        thread_id,
        sender_id,
        body,
        image_url,
        image_public_id,
        attachment_name,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    threadId,
    SUPPORT_USER_ID,
    body,
    nextImageUrl,
    nextImagePublicId,
    attachmentName || null,
    now,
  );

  db.prepare(
    `UPDATE message_threads
        SET updated_at = ?,
            last_message_at = ?,
            last_message_text = ?
      WHERE id = ?`,
  ).run(
    now,
    now,
    (
      body ||
      (imageUrl
        ? getDisputeAttachmentPreviewLabel({
            url: imageUrl,
            publicId: imagePublicId,
            attachmentKind,
          })
        : '')
    ).slice(0, 500),
    threadId,
  );

  return res.json({
    threadId,
    message: {
      id: messageId,
      senderId: SUPPORT_USER_ID,
      body,
      imageUrl: nextImageUrl,
      imagePublicId: nextImagePublicId,
      attachmentName: attachmentName || null,
      attachmentKind,
      createdAt: now,
    },
  });
}

async function resolveDashboardDispute(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.orderId ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });

  const actionRaw = String(req.body?.action ?? '')
    .trim()
    .toLowerCase();
  const reasonRaw = String(req.body?.reason ?? '').trim();
  const percentRaw = req.body?.percent;

  if (!reasonRaw) {
    return res.status(400).json({ error: 'reason is required' });
  }
  if (reasonRaw.length > 5_000) {
    return res.status(400).json({ error: 'reason is too long' });
  }

  const action =
    actionRaw === 'approve'
      ? 'approve'
      : actionRaw === 'cancel'
        ? 'cancel'
        : actionRaw === 'part_refund' || actionRaw === 'partial_refund'
          ? 'part_refund'
          : null;

  if (!action) {
    return res
      .status(400)
      .json({ error: "action must be 'approve', 'cancel', or 'part_refund'" });
  }

  const order = db
    .prepare(
      `SELECT id,
              status,
              listing_id AS listingId,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              stripe_payment_intent_id AS stripePaymentIntentId,
              dispute_opened_at AS disputeOpenedAt,
              dispute_opened_stage AS disputeOpenedStage,
              listing_price_usd AS listingPriceUsd,
              add_ons_total_usd AS addOnsTotalUsd,
              refunded_usd AS refundedUsd,
                  refunded_subtotal_usd AS refundedSubtotalUsd
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!order?.id) return res.status(404).json({ error: 'Not Found' });
  if (!String(order.disputeOpenedAt ?? '').trim()) {
    return res
      .status(409)
      .json({ error: 'Dispute is not opened for this order' });
  }

  const now = new Date().toISOString();
  const disputeStage = normalizeDisputeStage(order.disputeOpenedStage);
  const subtotalUsd = computeSubtotalUsd({
    listingPriceUsd: order.listingPriceUsd,
    addOnsTotalUsd: order.addOnsTotalUsd,
  });

  const refundedSubtotalUsd = Math.max(
    0,
    Number(order.refundedSubtotalUsd ?? 0),
  );
  const refundedUsd = Math.max(
    Math.max(0, Number(order.refundedUsd ?? 0)),
    refundedSubtotalUsd,
  );

  const remainingSubtotalUsd = Math.max(0, subtotalUsd - refundedSubtotalUsd);

  let refundUsd = 0;
  let nextRefundedSubtotalUsd = refundedSubtotalUsd;
  let nextRefundedUsd = refundedUsd;
  let nextStatus = String(order.status ?? '').trim() || 'completed';
  let nextFinalizedReason = null;

  if (action === 'approve') {
    nextStatus = 'completed';
    nextFinalizedReason = 'dispute_approved';
  } else if (action === 'cancel') {
    refundUsd = remainingSubtotalUsd;
    nextRefundedSubtotalUsd = subtotalUsd;
    nextRefundedUsd = Math.max(refundedUsd, nextRefundedSubtotalUsd);
    nextStatus = 'canceled';
    nextFinalizedReason = 'dispute_canceled';
  } else if (action === 'part_refund') {
    const parsed = Number.parseFloat(String(percentRaw ?? '').trim());
    const percent = Number.isFinite(parsed)
      ? Math.max(1, Math.min(100, Math.round(parsed)))
      : null;
    if (!percent) {
      return res.status(400).json({ error: 'percent is required (1-100)' });
    }

    const desiredRefundSubtotalUsd = Math.max(
      0,
      Math.min(subtotalUsd, Math.round((subtotalUsd * percent) / 100)),
    );
    const targetAdditionalRefundUsd = Math.max(
      0,
      desiredRefundSubtotalUsd - refundedSubtotalUsd,
    );

    refundUsd = Math.min(remainingSubtotalUsd, targetAdditionalRefundUsd);
    nextRefundedSubtotalUsd = refundedSubtotalUsd + refundUsd;
    nextRefundedUsd = Math.max(refundedUsd, nextRefundedSubtotalUsd);

    const fullyRefundedSubtotal =
      subtotalUsd > 0 && nextRefundedSubtotalUsd >= subtotalUsd;
    nextStatus = fullyRefundedSubtotal ? 'canceled' : 'completed';
    nextFinalizedReason = fullyRefundedSubtotal
      ? 'dispute_canceled'
      : 'dispute_partial_refund';
  }

  const paymentIntentId = String(order.stripePaymentIntentId ?? '').trim();
  if ((action === 'cancel' || action === 'part_refund') && refundUsd > 0) {
    if (!paymentIntentId) {
      return res.status(409).json({ error: 'Order has no payment intent' });
    }

    let stripe;
    try {
      stripe = getStripe();
    } catch (e) {
      return res.status(500).json({
        error: e instanceof Error ? e.message : 'Stripe not configured',
      });
    }

    try {
      await createRefundSafe({
        stripe,
        paymentIntentId,
        amountUsd: refundUsd,
      });
    } catch (e) {
      return res
        .status(500)
        .json({ error: e instanceof Error ? e.message : 'Refund failed' });
    }
  }

  ensureSupportUser();

  try {
    db.transaction(() => {
      // Resolve stage-specific dispute history row (best-effort; older DBs may not have table).
      try {
        db.prepare(
          `UPDATE order_disputes
              SET resolved_at = COALESCE(resolved_at, ?),
                  updated_at = ?
            WHERE order_id = ?
              AND stage = ?
              AND resolved_at IS NULL`,
        ).run(now, now, orderId, disputeStage);
      } catch {
        // ignore
      }

      db.prepare(
        `UPDATE orders
            SET refunded_subtotal_usd = ?,
                refunded_usd = ?,
                status = ?,
                finalized_reason = COALESCE(finalized_reason, ?),
                finalized_at = COALESCE(finalized_at, ?),
                dispute_resolved_at = COALESCE(dispute_resolved_at, ?),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        nextRefundedSubtotalUsd,
        nextRefundedUsd,
        nextStatus,
        nextFinalizedReason,
        now,
        now,
        now,
        orderId,
      );

      const threadId = ensureDisputeThread({
        orderId,
        listingId: order.listingId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        now,
      });

      const actionLine =
        action === 'approve'
          ? 'Approved order'
          : action === 'cancel'
            ? 'Canceled order'
            : 'Partial refund';
      const body = `${actionLine}\n${reasonRaw}`;
      insertSupportThreadMessage({ threadId, body, now });
    })();

    return res.json({
      ok: true,
      order: {
        orderId,
        status: nextStatus,
        refundedUsd: nextRefundedUsd,
        refundedSubtotalUsd: nextRefundedSubtotalUsd,
      },
      refund: refundUsd > 0 ? { amountUsd: refundUsd } : null,
    });
  } catch (e) {
    return res.status(500).json({
      error: e instanceof Error ? e.message : 'Failed to resolve dispute',
    });
  }
}

module.exports = {
  listDashboardDisputes,
  listDashboardDisputeMessages,
  downloadDashboardDisputeAttachment,
  createDashboardDisputeImageUploadSignature,
  sendDashboardDisputeMessage,
  resolveDashboardDispute,
};
