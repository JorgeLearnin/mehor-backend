'use strict';

const pool = require('../db');
const cloudinary = require('../lib/cloudinary');
const {
  hardDeleteListingSafely,
} = require('../services/listingDeletion.service');
const {
  createStripeItemRefundIfNeeded,
  getOrderItemTotalCents,
  getRemainingItemRefundableCents,
  getSellerPayoutAfterRefund,
} = require('../services/orderStripeRefund.service');
const {
  createSellerTransferForCompletedOrder,
} = require('../services/orderStripeTransfer.service');
const { createOrderEvent } = require('../services/orderTimeline.service');
const {
  createNotificationWithEmail,
} = require('../services/notification.service');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeBoolean(value) {
  return value === true || value === 'true';
}

function normalizeUuid(value) {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase();
}

function isUuid(value) {
  return UUID_REGEX.test(normalizeUuid(value));
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDashboardDisputeAction(value) {
  const action = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (action === 'cancel' || action === 'cancel_order') {
    return 'cancel_order';
  }

  if (action === 'approve' || action === 'approve_order') {
    return 'approve_order';
  }

  if (action === 'part_refund' || action === 'partial_refund') {
    return 'part_refund';
  }

  return '';
}

function getDashboardResolveLabels(action) {
  if (action === 'cancel_order') {
    return {
      resolution: 'dashboard_canceled_order',
      eventType: 'dashboard_dispute_order_canceled',
      title: 'Order canceled by Mehor',
      body: 'Mehor resolved the dispute by canceling the order.',
      notificationTitle: 'Dispute resolved: order canceled',
      notificationBody: 'Mehor resolved the dispute and canceled the order.',
    };
  }

  if (action === 'part_refund') {
    return {
      resolution: 'dashboard_part_refunded_order',
      eventType: 'dashboard_dispute_order_part_refunded',
      title: 'Order part-refunded by Mehor',
      body: 'Mehor resolved the dispute with a partial refund.',
      notificationTitle: 'Dispute resolved: partial refund issued',
      notificationBody:
        'Mehor resolved the dispute and issued a partial refund.',
    };
  }

  return {
    resolution: 'dashboard_approved_order',
    eventType: 'dashboard_dispute_order_approved',
    title: 'Order approved by Mehor',
    body: 'Mehor resolved the dispute by approving the order.',
    notificationTitle: 'Dispute resolved: order approved',
    notificationBody: 'Mehor resolved the dispute and approved the order.',
  };
}

async function restoreDashboardCanceledOrderListing({ client, listingId }) {
  const normalizedListingId = normalizeUuid(listingId);

  if (!isUuid(normalizedListingId)) return;

  await client.query(
    `
    UPDATE listings
    SET
      status = 'published',
      hidden_by_restriction_at = NULL,
      sold_at = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND status = 'sold'
    `,
    [normalizedListingId],
  );
}

async function getSellerStripeAccountId(client, sellerId) {
  const result = await client.query(
    `
    SELECT stripe_account_id
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [sellerId],
  );

  return result.rows[0]?.stripe_account_id || null;
}

async function createDashboardCompletionTransfer({
  client,
  order,
  amountCents,
}) {
  const sellerStripeAccountId = await getSellerStripeAccountId(
    client,
    order.seller_id,
  );

  const transferResult = await createSellerTransferForCompletedOrder({
    order,
    sellerStripeAccountId,
    amountCents,
    idempotencyKey: `dashboard-order-completion-transfer-${order.id}`,
  });

  return transferResult.transferId;
}

async function notifyDashboardDisputeResolved({
  client,
  order,
  dispute,
  action,
  labels,
  refundCents,
  sellerPayoutCents,
}) {
  const orderLabel = order.order_number
    ? `#${order.order_number}`
    : 'your order';

  await Promise.all([
    createNotificationWithEmail({
      userId: order.buyer_id,
      type: 'order_dispute_resolved_by_platform',
      title: labels.notificationTitle,
      body: labels.notificationBody,
      actionUrl: `/order/${order.id}`,
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        disputeId: dispute.id,
        action,
        refundCents,
        sellerPayoutCents,
        role: 'buyer',
      },
      emailSubject: `${labels.notificationTitle}: ${orderLabel}`,
      emailTitle: labels.notificationTitle,
      emailBody: labels.notificationBody,
      emailActionLabel: 'View order',
      db: client,
    }),
    createNotificationWithEmail({
      userId: order.seller_id,
      type: 'order_dispute_resolved_by_platform',
      title: labels.notificationTitle,
      body: labels.notificationBody,
      actionUrl: `/order/${order.id}`,
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        disputeId: dispute.id,
        action,
        refundCents,
        sellerPayoutCents,
        role: 'seller',
      },
      emailSubject: `${labels.notificationTitle}: ${orderLabel}`,
      emailTitle: labels.notificationTitle,
      emailBody: labels.notificationBody,
      emailActionLabel: 'View order',
      db: client,
    }),
  ]);
}

function isAllowedDashboardDisputeAttachment(file) {
  if (!file) return false;

  const mimetype = String(file.mimetype ?? '').toLowerCase();

  return new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
  ]).has(mimetype);
}

function getDashboardDisputeAttachmentResourceType(file) {
  const mimetype = String(file?.mimetype ?? '').toLowerCase();
  return mimetype === 'application/pdf' ? 'raw' : 'image';
}

function uploadDashboardDisputeAttachmentToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const resourceType = getDashboardDisputeAttachmentResourceType(file);

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'mehor/orders/disputes',
        resource_type: resourceType,
      },
      (error, uploadResult) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          ...uploadResult,
          resource_type: resourceType,
        });
      },
    );

    stream.end(file.buffer);
  });
}

async function insertDashboardDisputeMessageAttachments({
  client,
  messageId,
  files,
  uploadedFiles,
}) {
  const attachments = [];

  for (const file of files) {
    const uploadedFile =
      await uploadDashboardDisputeAttachmentToCloudinary(file);
    uploadedFiles.push(uploadedFile);

    const attachmentResult = await client.query(
      `
      INSERT INTO order_dispute_message_attachments (
        message_id,
        url,
        public_id,
        file_name,
        mime_type,
        size_bytes,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      RETURNING *
      `,
      [
        messageId,
        uploadedFile.secure_url,
        uploadedFile.public_id,
        file.originalname || null,
        file.mimetype || null,
        file.size || null,
      ],
    );

    attachments.push(attachmentResult.rows[0]);
  }

  return attachments;
}

function mapDashboardDisputeMessage(message) {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : [];

  const senderRole = String(message.sender_role ?? '').trim();

  return {
    id: message.id,
    senderId:
      senderRole === 'platform'
        ? 'mehor_support_user'
        : message.sender_id
          ? String(message.sender_id)
          : '',
    senderRole,
    body: message.body || '',
    reason: message.reason || null,
    openedStage: message.opened_stage || null,
    isInitial: message.is_initial === true,
    createdAt: message.created_at,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      url: attachment.url,
      publicId: attachment.public_id,
      fileName: attachment.file_name,
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
      attachmentKind:
        String(attachment.mime_type ?? '').toLowerCase() === 'application/pdf'
          ? 'pdf'
          : 'image',
    })),
  };
}

async function getDashboardDisputeMessagesPayload({ client, disputeId }) {
  const queryable =
    client && typeof client.query === 'function' ? client : pool;

  const disputeResult = await queryable.query(
    `
    SELECT
      d.*,
      o.order_number,
      o.buyer_id,
      o.seller_id
    FROM order_disputes d
    INNER JOIN orders o ON o.id = d.order_id
    WHERE d.id = $1
    LIMIT 1
    `,
    [disputeId],
  );

  const dispute = disputeResult.rows[0];

  if (!dispute) {
    return null;
  }

  const messagesResult = await queryable.query(
    `
    SELECT *
    FROM order_dispute_messages
    WHERE dispute_id = $1
    ORDER BY created_at ASC
    `,
    [disputeId],
  );

  const attachmentsResult = await queryable.query(
    `
    SELECT
      a.*
    FROM order_dispute_message_attachments a
    INNER JOIN order_dispute_messages m ON m.id = a.message_id
    WHERE m.dispute_id = $1
    ORDER BY a.created_at ASC
    `,
    [disputeId],
  );

  const attachmentsByMessageId = new Map();

  for (const attachment of attachmentsResult.rows) {
    const messageId = String(attachment.message_id);

    if (!attachmentsByMessageId.has(messageId)) {
      attachmentsByMessageId.set(messageId, []);
    }

    attachmentsByMessageId.get(messageId).push(attachment);
  }

  return {
    dispute: {
      id: dispute.id,
      orderId: dispute.order_id,
      orderNumber: dispute.order_number,
      status: dispute.status,
      openedStage: dispute.opened_stage,
      openedAt: dispute.opened_at,
      resolvedAt: dispute.resolved_at,
    },
    messages: messagesResult.rows.map((message) =>
      mapDashboardDisputeMessage({
        ...message,
        attachments: attachmentsByMessageId.get(String(message.id)) ?? [],
      }),
    ),
  };
}

function normalizeTransactionStatus(order) {
  const status = String(order.status || '').toLowerCase();
  const paymentStatus = String(order.payment_status || '').toLowerCase();
  const refundedCents = Number(order.total_refunded_cents || 0);

  if (status === 'canceled') return 'canceled';

  if (status === 'completed' && refundedCents > 0) {
    return 'part-refunded';
  }

  if (status === 'completed') return 'completed';

  if (paymentStatus === 'refunded' && refundedCents > 0) {
    return 'canceled';
  }

  return 'pending';
}

function formatDashboardUser({ id, username, fullName, email }) {
  return {
    id,
    username: username || '',
    name: fullName || username || email || '',
    email: email || '',
  };
}

async function getDashboardUsers(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        id,
        email,
        username,
        full_name,
        role,
        status,
        is_seller,
        created_at,
        updated_at
      FROM users
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
    `);

    return res.json({
      users: result.rows.map((user) => ({
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.full_name || user.username || user.email,
        role:
          user.is_seller === true || user.role === 'seller' ? 'seller' : 'user',
        status: user.status,
        restricted: user.status === 'restricted',
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      })),
    });
  } catch (error) {
    console.error('Dashboard get users error:', error);
    return res.status(500).json({ error: 'Failed to load users.' });
  }
}

async function cancelActiveOrdersForRestrictedUser({ client, targetUserId }) {
  const activeOrdersResult = await client.query(
    `
    SELECT
      id,
      order_number,
      listing_id,
      buyer_id,
      seller_id,
      status,
      payment_status,
      base_price_cents,
      addons_total_cents,
      item_refunded_cents,
      total_paid_cents,
      total_refunded_cents,
      seller_fee_cents,
      stripe_charge_id,
      stripe_payment_intent_id
    FROM orders
    WHERE finalized_at IS NULL
      AND status NOT IN ('completed', 'canceled')
      AND payment_status = 'paid'
      AND (buyer_id = $1 OR seller_id = $1)
    ORDER BY created_at ASC
    FOR UPDATE
    `,
    [targetUserId],
  );

  const orders = activeOrdersResult.rows;

  for (const order of orders) {
    const refundResult = await createStripeItemRefundIfNeeded({
      order,
      amountCents: getRemainingItemRefundableCents(order),
      reason: 'dashboard_user_restricted',
      idempotencyKey: `dashboard-restrict-item-refund-${order.id}`,
    });

    await client.query(
      `
      UPDATE orders
      SET
        status = 'canceled',
        payment_status = CASE
          WHEN $2::integer > 0 THEN 'refunded'
          ELSE payment_status
        END,
        stripe_refund_id = COALESCE($3, stripe_refund_id),
        item_refunded_cents = item_refunded_cents + $2,
        total_refunded_cents = total_refunded_cents + $2,
        seller_fee_cents = 0,
        seller_payout_cents = 0,
        refunded_at = CASE
          WHEN $2::integer > 0 THEN NOW()
          ELSE refunded_at
        END,
        finalized_at = NOW(),
        canceled_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      `,
      [order.id, refundResult.refundedCents, refundResult.refundId],
    );

    await client.query(
      `
      UPDATE order_parts
      SET
        status = 'canceled',
        canceled_at = NOW(),
        updated_at = NOW()
      WHERE order_id = $1
        AND status <> 'completed'
      `,
      [order.id],
    );

    await client.query(
      `
      UPDATE listings
      SET
        status = CASE
          WHEN seller_id = $2 THEN 'disabled'::listing_status
          ELSE 'published'::listing_status
        END,
        hidden_by_restriction_at = CASE
          WHEN seller_id = $2 THEN NOW()
          ELSE NULL
        END,
        sold_at = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND status = 'sold'
      `,
      [order.listing_id, targetUserId],
    );

    await createOrderEvent(client, {
      orderId: order.id,
      actorId: null,
      type: 'dashboard_user_restricted_order_canceled',
      title: 'Order canceled by Mehor',
      body: 'This order was canceled because one of the accounts involved was restricted.',
      metadata: {
        targetUserId,
        refundId: refundResult.refundId,
        refundedCents: refundResult.refundedCents,
      },
    });
  }

  return orders.length;
}

async function updateUserRestriction(req, res) {
  const targetUserId = Number.parseInt(String(req.params.userId), 10);
  const shouldRestrict = normalizeBoolean(req.body?.restricted);

  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `
      SELECT
        id,
        email,
        username,
        full_name,
        role,
        status,
        is_seller,
        deleted_at
      FROM users
      WHERE id = $1
      FOR UPDATE
      `,
      [targetUserId],
    );

    const user = userResult.rows[0];

    if (!user || user.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }

    const nextStatus = shouldRestrict ? 'restricted' : 'active';

    await client.query(
      `
      UPDATE users
      SET
        status = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [targetUserId, nextStatus],
    );

    let hiddenListingsCount = 0;
    let canceledOrdersCount = 0;

    if (shouldRestrict) {
      if (user.is_seller === true || user.role === 'seller') {
        const hiddenListingsResult = await client.query(
          `
          UPDATE listings
          SET
            status = 'disabled',
            hidden_by_restriction_at = NOW(),
            updated_at = NOW()
          WHERE seller_id = $1
            AND status = 'published'
          RETURNING id
          `,
          [targetUserId],
        );

        hiddenListingsCount = hiddenListingsResult.rowCount;
      }

      canceledOrdersCount = await cancelActiveOrdersForRestrictedUser({
        client,
        targetUserId,
      });
    } else if (user.is_seller === true || user.role === 'seller') {
      const restoredListingsResult = await client.query(
        `
        UPDATE listings
        SET
          status = 'published',
          hidden_by_restriction_at = NULL,
          updated_at = NOW()
        WHERE seller_id = $1
          AND status = 'disabled'
          AND hidden_by_restriction_at IS NOT NULL
        RETURNING id
        `,
        [targetUserId],
      );

      hiddenListingsCount = restoredListingsResult.rowCount;
    }

    await client.query('COMMIT');

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.full_name || user.username || user.email,
        role:
          user.is_seller === true || user.role === 'seller' ? 'seller' : 'user',
        status: nextStatus,
        restricted: nextStatus === 'restricted',
      },
      hiddenListingsCount,
      canceledOrdersCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Dashboard update user restriction error:', error);
    return res.status(500).json({ error: 'Failed to update user.' });
  } finally {
    client.release();
  }
}

async function getDashboardListings(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        l.id,
        l.title,
        l.base_price_cents,
        l.status,
        l.sold_at,
        l.created_at,
        l.updated_at,
        u.id AS seller_id,
        u.username AS seller_username,
        u.full_name AS seller_full_name,
        u.email AS seller_email
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE l.status IN ('published', 'disabled')
      ORDER BY l.created_at DESC
    `);

    return res.json({
      listings: result.rows.map((listing) => ({
        id: listing.id,
        title: listing.title,
        seller: {
          id: listing.seller_id,
          username: listing.seller_username,
          name:
            listing.seller_full_name ||
            listing.seller_username ||
            listing.seller_email,
          email: listing.seller_email,
        },
        basePriceCents: listing.base_price_cents,
        basePrice: Number(listing.base_price_cents || 0) / 100,
        status: listing.status,
        visible: listing.status === 'published',
        soldAt: listing.sold_at,
        createdAt: listing.created_at,
        updatedAt: listing.updated_at,
      })),
    });
  } catch (error) {
    console.error('Dashboard get listings error:', error);
    return res.status(500).json({ error: 'Failed to load listings.' });
  }
}

async function updateListingVisibility(req, res) {
  const listingId = normalizeUuid(req.params.listingId);
  const shouldBeVisible = normalizeBoolean(req.body?.visible);

  if (!isUuid(listingId)) {
    return res.status(400).json({ error: 'Invalid listing id.' });
  }

  try {
    const currentResult = await pool.query(
      `
      SELECT
        l.id,
        l.title,
        l.status,
        l.base_price_cents,
        l.seller_id,
        u.status AS seller_status,
        u.deleted_at AS seller_deleted_at
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE l.id = $1
      LIMIT 1
      `,
      [listingId],
    );

    const current = currentResult.rows[0];

    if (!current) {
      return res.status(404).json({ error: 'Listing not found.' });
    }

    if (!['published', 'disabled'].includes(current.status)) {
      return res.status(400).json({
        error: 'Only published or disabled listings can be changed here.',
      });
    }

    if (
      shouldBeVisible &&
      (current.seller_status !== 'active' || current.seller_deleted_at)
    ) {
      return res.status(400).json({
        error: 'Cannot enable a listing from a restricted or deleted seller.',
      });
    }

    const nextStatus = shouldBeVisible ? 'published' : 'disabled';

    const updatedResult = await pool.query(
      `
      UPDATE listings
      SET
        status = $2,
        hidden_by_restriction_at = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND status IN ('published', 'disabled')
      RETURNING id, title, base_price_cents, status, sold_at, created_at, updated_at
      `,
      [listingId, nextStatus],
    );

    const listing = updatedResult.rows[0];

    return res.json({
      listing: {
        id: listing.id,
        title: listing.title,
        basePriceCents: listing.base_price_cents,
        basePrice: Number(listing.base_price_cents || 0) / 100,
        status: listing.status,
        visible: listing.status === 'published',
        soldAt: listing.sold_at,
        createdAt: listing.created_at,
        updatedAt: listing.updated_at,
      },
    });
  } catch (error) {
    console.error('Dashboard update listing visibility error:', error);
    return res.status(500).json({ error: 'Failed to update listing.' });
  }
}

async function getDashboardTransactions(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.order_number,
        o.listing_id,
        o.listing_title,
        o.base_price_cents,
        o.addons_total_cents,
        o.total_paid_cents,
        o.total_refunded_cents,
        o.status,
        o.payment_status,
        o.created_at,
        o.finalized_at,
        o.canceled_at,
        o.refunded_at,

        buyer.id AS buyer_id,
        buyer.username AS buyer_username,
        buyer.full_name AS buyer_full_name,
        buyer.email AS buyer_email,

        seller.id AS seller_id,
        seller.username AS seller_username,
        seller.full_name AS seller_full_name,
        seller.email AS seller_email
      FROM orders o
      LEFT JOIN users buyer ON buyer.id = o.buyer_id
      LEFT JOIN users seller ON seller.id = o.seller_id
      ORDER BY o.created_at DESC
    `);

    return res.json({
      transactions: result.rows.map((order) => {
        const totalAmountCents =
          Number(order.base_price_cents || 0) +
          Number(order.addons_total_cents || 0);

        return {
          id: order.id,
          orderNumber: order.order_number,
          listingId: order.listing_id,
          listingTitle: order.listing_title,
          totalAmountCents,
          totalAmount: totalAmountCents / 100,
          totalPaidCents: order.total_paid_cents,
          totalRefundedCents: order.total_refunded_cents,
          status: normalizeTransactionStatus(order),
          rawStatus: order.status,
          paymentStatus: order.payment_status,
          buyer: formatDashboardUser({
            id: order.buyer_id,
            username: order.buyer_username,
            fullName: order.buyer_full_name,
            email: order.buyer_email,
          }),
          seller: formatDashboardUser({
            id: order.seller_id,
            username: order.seller_username,
            fullName: order.seller_full_name,
            email: order.seller_email,
          }),
          createdAt: order.created_at,
          finalizedAt: order.finalized_at,
          canceledAt: order.canceled_at,
          refundedAt: order.refunded_at,
        };
      }),
    });
  } catch (error) {
    console.error('Dashboard get transactions error:', error);
    return res.status(500).json({ error: 'Failed to load transactions.' });
  }
}

async function getDashboardDisputes(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        d.id,
        d.order_id,
        d.order_part_id,
        d.opened_by,
        d.status,
        d.resolution,
        d.opened_at,
        d.resolved_at,
        d.created_at,
        d.updated_at,
        d.opened_stage,

        o.order_number,
        o.listing_id,
        o.listing_title,
        o.base_price_cents,
        o.addons_total_cents,
        o.total_paid_cents,
        o.total_refunded_cents,
        o.status AS order_status,
        o.payment_status AS order_payment_status,

        buyer.id AS buyer_id,
        buyer.username AS buyer_username,
        buyer.full_name AS buyer_full_name,
        buyer.email AS buyer_email,

        seller.id AS seller_id,
        seller.username AS seller_username,
        seller.full_name AS seller_full_name,
        seller.email AS seller_email
      FROM order_disputes d
      INNER JOIN orders o ON o.id = d.order_id
      LEFT JOIN users buyer ON buyer.id = o.buyer_id
      LEFT JOIN users seller ON seller.id = o.seller_id
      ORDER BY d.opened_at DESC, d.created_at DESC
    `);

    return res.json({
      disputes: result.rows.map((dispute) => {
        const totalAmountCents =
          Number(dispute.base_price_cents || 0) +
          Number(dispute.addons_total_cents || 0);

        return {
          id: dispute.id,
          orderId: dispute.order_id,
          orderPartId: dispute.order_part_id,
          orderNumber: dispute.order_number,
          listingId: dispute.listing_id,
          listingTitle: dispute.listing_title,
          totalAmountCents,
          totalAmount: totalAmountCents / 100,
          status: dispute.status,
          resolution: dispute.resolution,
          openedStage: dispute.opened_stage,
          orderStatus: dispute.order_status,
          orderPaymentStatus: dispute.order_payment_status,
          buyer: formatDashboardUser({
            id: dispute.buyer_id,
            username: dispute.buyer_username,
            fullName: dispute.buyer_full_name,
            email: dispute.buyer_email,
          }),
          seller: formatDashboardUser({
            id: dispute.seller_id,
            username: dispute.seller_username,
            fullName: dispute.seller_full_name,
            email: dispute.seller_email,
          }),
          openedBy: dispute.opened_by,
          openedAt: dispute.opened_at,
          resolvedAt: dispute.resolved_at,
          createdAt: dispute.created_at,
          updatedAt: dispute.updated_at,
        };
      }),
    });
  } catch (error) {
    console.error('Dashboard get disputes error:', error);
    return res.status(500).json({ error: 'Failed to load disputes.' });
  }
}

async function getDashboardDisputeMessages(req, res) {
  const disputeId = normalizeUuid(req.params.disputeId);

  if (!isUuid(disputeId)) {
    return res.status(400).json({ error: 'Invalid dispute id.' });
  }

  try {
    const payload = await getDashboardDisputeMessagesPayload({ disputeId });

    if (!payload) {
      return res.status(404).json({ error: 'Dispute not found.' });
    }

    return res.json(payload);
  } catch (error) {
    console.error('Dashboard get dispute messages error:', error);
    return res.status(500).json({ error: 'Failed to load dispute messages.' });
  }
}

async function createDashboardDisputeMessage(req, res) {
  const disputeId = normalizeUuid(req.params.disputeId);
  const message = trimString(req.body?.message);
  const attachments = Array.isArray(req.files) ? req.files : [];
  const uploadedFiles = [];
  const client = await pool.connect();

  if (!isUuid(disputeId)) {
    return res.status(400).json({ error: 'Invalid dispute id.' });
  }

  if (attachments.length > 5) {
    return res.status(400).json({ error: 'Maximum 5 attachments allowed.' });
  }

  for (const file of attachments) {
    if (!isAllowedDashboardDisputeAttachment(file)) {
      return res.status(400).json({
        error: 'Only JPG, PNG, WEBP, GIF, or PDF attachments are allowed.',
      });
    }
  }

  if (!message && attachments.length === 0) {
    return res.status(400).json({
      error: 'A dispute reply requires a message or at least one attachment.',
    });
  }

  try {
    await client.query('BEGIN');

    const disputeResult = await client.query(
      `
      SELECT
        d.*,
        o.order_number,
        o.buyer_id,
        o.seller_id
      FROM order_disputes d
      INNER JOIN orders o ON o.id = d.order_id
      WHERE d.id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [disputeId],
    );

    const dispute = disputeResult.rows[0];

    if (!dispute) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dispute not found.' });
    }

    const disputeStatus = String(dispute.status ?? '')
      .trim()
      .toLowerCase();

    if (disputeStatus !== 'open' && disputeStatus !== 'under_review') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Dispute is not open.' });
    }

    const messageResult = await client.query(
      `
      INSERT INTO order_dispute_messages (
        order_id,
        dispute_id,
        sender_id,
        sender_role,
        body,
        is_initial,
        reason,
        created_at,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      RETURNING *
      `,
      [
        dispute.order_id,
        dispute.id,
        null,
        'platform',
        message || null,
        false,
        null,
      ],
    );

    const disputeMessage = messageResult.rows[0];

    await insertDashboardDisputeMessageAttachments({
      client,
      messageId: disputeMessage.id,
      files: attachments,
      uploadedFiles,
    });

    const orderLabel = dispute.order_number
      ? `#${dispute.order_number}`
      : 'your order';

    await Promise.all([
      createNotificationWithEmail({
        userId: dispute.buyer_id,
        type: 'order_dispute_platform_reply',
        title: 'Mehor replied to a dispute',
        body: `Mehor replied to the dispute for order ${orderLabel}.`,
        actionUrl: `/order/${dispute.order_id}`,
        metadata: {
          orderId: dispute.order_id,
          orderNumber: dispute.order_number,
          disputeId: dispute.id,
          messageId: disputeMessage.id,
        },
        emailSubject: `Mehor replied to dispute ${orderLabel}`,
        emailTitle: 'Mehor replied to a dispute',
        emailBody: `Mehor replied to the dispute for order ${orderLabel}.`,
        emailActionLabel: 'View dispute',
        db: client,
      }),
      createNotificationWithEmail({
        userId: dispute.seller_id,
        type: 'order_dispute_platform_reply',
        title: 'Mehor replied to a dispute',
        body: `Mehor replied to the dispute for order ${orderLabel}.`,
        actionUrl: `/order/${dispute.order_id}`,
        metadata: {
          orderId: dispute.order_id,
          orderNumber: dispute.order_number,
          disputeId: dispute.id,
          messageId: disputeMessage.id,
        },
        emailSubject: `Mehor replied to dispute ${orderLabel}`,
        emailTitle: 'Mehor replied to a dispute',
        emailBody: `Mehor replied to the dispute for order ${orderLabel}.`,
        emailActionLabel: 'View dispute',
        db: client,
      }),
    ]);

    const payload = await getDashboardDisputeMessagesPayload({
      client,
      disputeId,
    });

    await client.query('COMMIT');

    return res.status(201).json(payload);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }

    for (const uploadedFile of uploadedFiles) {
      if (!uploadedFile?.public_id) continue;

      try {
        await cloudinary.uploader.destroy(uploadedFile.public_id, {
          resource_type: uploadedFile.resource_type || 'image',
        });
      } catch (cleanupError) {
        console.error(
          'Dashboard dispute attachment cleanup error:',
          cleanupError,
        );
      }
    }

    console.error('Dashboard create dispute message error:', error);
    return res.status(500).json({ error: 'Failed to send dispute message.' });
  } finally {
    client.release();
  }
}

async function resolveDashboardDispute(req, res) {
  const disputeId = normalizeUuid(req.params.disputeId);
  const action = normalizeDashboardDisputeAction(req.body?.action);
  const reason = trimString(req.body?.reason);
  const percentRaw = req.body?.percent;
  const percent = Number(percentRaw);
  const client = await pool.connect();

  if (!isUuid(disputeId)) {
    return res.status(400).json({ error: 'Invalid dispute id.' });
  }

  if (!action) {
    return res.status(400).json({ error: 'Invalid dispute action.' });
  }

  if (!reason) {
    return res.status(400).json({ error: 'Decision reason is required.' });
  }

  if (
    action === 'part_refund' &&
    (!Number.isFinite(percent) || percent < 1 || percent > 100)
  ) {
    return res.status(400).json({
      error: 'Part-refund percent must be between 1 and 100.',
    });
  }

  let shouldHardDeleteListing = false;

  try {
    await client.query('BEGIN');

    const disputeResult = await client.query(
      `
      SELECT
        d.id AS dispute_id,
        d.order_id AS dispute_order_id,
        d.order_part_id AS dispute_order_part_id,
        d.opened_by AS dispute_opened_by,
        d.status AS dispute_status,
        d.resolution AS dispute_resolution,
        d.opened_stage AS dispute_opened_stage,
        d.opened_at AS dispute_opened_at,
        d.resolved_at AS dispute_resolved_at,

        o.id AS order_id,
        o.order_number,
        o.listing_id,
        o.buyer_id,
        o.seller_id,
        o.status AS order_status,
        o.payment_status AS order_payment_status,
        o.base_price_cents,
        o.addons_total_cents,
        o.buyer_fee_cents,
        o.seller_fee_cents,
        o.item_refunded_cents,
        o.total_refunded_cents,
        o.seller_payout_cents,
        o.currency,
        o.stripe_transfer_id,
        o.stripe_charge_id,
        o.stripe_payment_intent_id,
        o.stripe_refund_id,
        o.finalized_at
      FROM order_disputes d
      INNER JOIN orders o ON o.id = d.order_id
      WHERE d.id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [disputeId],
    );

    const row = disputeResult.rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dispute not found.' });
    }

    const dispute = {
      id: row.dispute_id,
      order_id: row.dispute_order_id,
      order_part_id: row.dispute_order_part_id,
      opened_by: row.dispute_opened_by,
      status: row.dispute_status,
      resolution: row.dispute_resolution,
      opened_stage: row.dispute_opened_stage,
      opened_at: row.dispute_opened_at,
      resolved_at: row.dispute_resolved_at,
    };

    const order = {
      id: row.order_id,
      order_number: row.order_number,
      listing_id: row.listing_id,
      buyer_id: row.buyer_id,
      seller_id: row.seller_id,
      status: row.order_status,
      payment_status: row.order_payment_status,
      base_price_cents: row.base_price_cents,
      addons_total_cents: row.addons_total_cents,
      buyer_fee_cents: row.buyer_fee_cents,
      seller_fee_cents: row.seller_fee_cents,
      item_refunded_cents: row.item_refunded_cents,
      total_refunded_cents: row.total_refunded_cents,
      seller_payout_cents: row.seller_payout_cents,
      currency: row.currency,
      stripe_transfer_id: row.stripe_transfer_id,
      stripe_charge_id: row.stripe_charge_id,
      stripe_payment_intent_id: row.stripe_payment_intent_id,
      stripe_refund_id: row.stripe_refund_id,
      finalized_at: row.finalized_at,
    };

    const disputeStatus = String(dispute.status ?? '')
      .trim()
      .toLowerCase();

    if (disputeStatus !== 'open' && disputeStatus !== 'under_review') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Dispute is not open.' });
    }

    if (order.finalized_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order is already finalized.' });
    }

    if (String(order.payment_status) !== 'paid') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order is not paid.' });
    }

    const now = new Date().toISOString();
    const labels = getDashboardResolveLabels(action);
    const currentItemRefundedCents = Number(order.item_refunded_cents || 0);
    const itemTotalCents = getOrderItemTotalCents(order);
    const remainingItemRefundableCents = getRemainingItemRefundableCents(order);

    let refundId = null;
    let refundCents = 0;
    let finalOrderStatus = 'completed';
    let finalPaymentStatus = 'paid';
    let finalItemRefundedCents = currentItemRefundedCents;
    let finalSellerPayoutCents = Number(order.seller_payout_cents || 0);

    if (action === 'cancel_order') {
      finalOrderStatus = 'canceled';
      finalPaymentStatus = 'refunded';

      const refundResult = await createStripeItemRefundIfNeeded({
        order,
        amountCents: remainingItemRefundableCents,
        reason: labels.resolution,
        idempotencyKey: `dashboard-dispute-cancel-${dispute.id}`,
      });

      refundId = refundResult.refundId;
      refundCents = refundResult.refundedCents;
      finalItemRefundedCents = currentItemRefundedCents + refundCents;
      finalSellerPayoutCents = 0;
    }

    if (action === 'part_refund') {
      const calculatedRefundCents = Math.round(
        (remainingItemRefundableCents * Math.round(percent)) / 100,
      );

      if (calculatedRefundCents <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Calculated refund amount must be greater than 0.',
        });
      }

      const refundResult = await createStripeItemRefundIfNeeded({
        order,
        amountCents: calculatedRefundCents,
        reason: labels.resolution,
        idempotencyKey: `dashboard-dispute-part-refund-${dispute.id}-${Math.round(
          percent,
        )}`,
      });

      refundId = refundResult.refundId;
      refundCents = refundResult.refundedCents;
      finalItemRefundedCents = currentItemRefundedCents + refundCents;
      finalSellerPayoutCents = getSellerPayoutAfterRefund({
        order,
        itemRefundedCents: finalItemRefundedCents,
      });
    }

    if (action === 'approve_order') {
      finalSellerPayoutCents = getSellerPayoutAfterRefund({
        order,
        itemRefundedCents: finalItemRefundedCents,
      });
    }

    const openDisputesResult = await client.query(
      `
      SELECT id, order_part_id, opened_stage
      FROM order_disputes
      WHERE order_id = $1
        AND status IN ('open', 'under_review')
      ORDER BY created_at ASC
      FOR UPDATE
      `,
      [order.id],
    );

    const openDisputes = openDisputesResult.rows;

    for (const openDispute of openDisputes) {
      await client.query(
        `
        INSERT INTO order_dispute_messages (
          order_id,
          dispute_id,
          sender_id,
          sender_role,
          body,
          is_initial,
          reason,
          opened_stage,
          created_at,
          updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        `,
        [
          order.id,
          openDispute.id,
          null,
          'platform',
          reason,
          false,
          null,
          openDispute.opened_stage || null,
        ],
      );
    }

    await client.query(
      `
      UPDATE order_disputes
      SET
        status = 'resolved',
        resolution = $2,
        resolved_by = NULL,
        resolved_at = $3,
        updated_at = NOW()
      WHERE order_id = $1
        AND status IN ('open', 'under_review')
      `,
      [order.id, labels.resolution, now],
    );

    if (action === 'cancel_order') {
      await client.query(
        `
        UPDATE order_parts
        SET
          status = 'canceled',
          canceled_at = COALESCE(canceled_at, $2),
          updated_at = NOW()
        WHERE order_id = $1
        `,
        [order.id, now],
      );
    } else {
      await client.query(
        `
        UPDATE order_parts
        SET
          status = 'completed',
          completed_at = COALESCE(completed_at, $2),
          updated_at = NOW()
        WHERE order_id = $1
          AND status <> 'canceled'
        `,
        [order.id, now],
      );
    }

    let finalStripeTransferId = null;

    if (finalOrderStatus === 'completed') {
      finalStripeTransferId = await createDashboardCompletionTransfer({
        client,
        order,
        amountCents: finalSellerPayoutCents,
      });
    }

    const orderUpdateResult = await client.query(
      `
      UPDATE orders
      SET
        status = $2,
        payment_status = $3,
        item_refunded_cents = $4,
        total_refunded_cents = total_refunded_cents + $5,
        seller_payout_cents = $6,
        stripe_refund_id = COALESCE($7, stripe_refund_id),
        stripe_transfer_id = COALESCE($9, stripe_transfer_id),
        seller_fee_cents = CASE
          WHEN $2 = 'canceled' THEN 0
          ELSE seller_fee_cents
        END,
        refunded_at = CASE
          WHEN $5::integer > 0 THEN $8
          ELSE refunded_at
        END,
        completed_at = CASE
          WHEN $2 = 'completed' THEN $8
          ELSE completed_at
        END,
        canceled_at = CASE
          WHEN $2 = 'canceled' THEN $8
          ELSE canceled_at
        END,
        finalized_at = $8,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        order.id,
        finalOrderStatus,
        finalPaymentStatus,
        finalItemRefundedCents,
        refundCents,
        finalSellerPayoutCents,
        refundId,
        now,
        finalStripeTransferId,
      ],
    );

    const updatedOrder = orderUpdateResult.rows[0];

    if (action === 'cancel_order') {
      await restoreDashboardCanceledOrderListing({
        client,
        listingId: order.listing_id,
      });
    } else {
      shouldHardDeleteListing = true;
    }

    await createOrderEvent(client, {
      orderId: order.id,
      orderPartId: dispute.order_part_id,
      actorId: null,
      type: labels.eventType,
      title: labels.title,
      body: labels.body,
      metadata: {
        disputeId: dispute.id,
        action,
        resolution: labels.resolution,
        reason,
        refundId,
        refundCents,
        refundPercent: action === 'part_refund' ? Math.round(percent) : null,
        itemTotalCents,
        itemRefundedCents: finalItemRefundedCents,
        sellerPayoutCents: finalSellerPayoutCents,
        feesRefundable: false,
        resolvedAt: now,
      },
    });

    await notifyDashboardDisputeResolved({
      client,
      order: updatedOrder,
      dispute,
      action,
      labels,
      refundCents,
      sellerPayoutCents: finalSellerPayoutCents,
    });

    const payload = await getDashboardDisputeMessagesPayload({
      client,
      disputeId,
    });

    await client.query('COMMIT');

    if (shouldHardDeleteListing) {
      await hardDeleteListingSafely({
        listingId: order.listing_id,
        context: 'dashboard_completed_listing_delete',
      });
    }

    return res.json({
      ok: true,
      action,
      order: {
        id: updatedOrder.id,
        orderNumber: updatedOrder.order_number,
        status: updatedOrder.status,
        paymentStatus: updatedOrder.payment_status,
        itemRefundedCents: updatedOrder.item_refunded_cents,
        totalRefundedCents: updatedOrder.total_refunded_cents,
        sellerPayoutCents: updatedOrder.seller_payout_cents,
        finalizedAt: updatedOrder.finalized_at,
      },
      dispute: payload?.dispute ?? null,
      messages: payload?.messages ?? [],
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }

    console.error('Dashboard resolve dispute error:', error);
    return res.status(500).json({ error: 'Failed to resolve dispute.' });
  } finally {
    client.release();
  }
}

async function getDashboardFeedback(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        fm.id,
        fm.user_id,
        fm.subject,
        fm.message,
        fm.status,
        fm.created_at,
        fm.resolved_at,
        u.username,
        u.email,
        u.full_name,
        u.status AS user_status,
        u.deleted_at
      FROM feedback_messages fm
      LEFT JOIN users u ON u.id = fm.user_id
      ORDER BY fm.created_at DESC
    `);

    return res.json({
      feedback: result.rows.map((row) => {
        const username =
          row.user_status === 'deleted' || row.deleted_at
            ? 'deleted_user'
            : row.username || '';

        return {
          id: row.id,
          subject: row.subject,
          message: row.message,
          status: row.status,
          from: username || 'unknown_user',
          fromUsername: username || null,
          fromEmail: row.email || null,
          fromName: row.full_name || null,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at,
        };
      }),
    });
  } catch (error) {
    console.error('Dashboard get feedback error:', error);
    return res.status(500).json({ error: 'Failed to load feedback.' });
  }
}

async function getDashboardReports(req, res) {
  try {
    const result = await pool.query(`
      SELECT
        r.id,
        r.reporter_id,
        r.target_type,
        r.target_id,
        r.reason,
        r.details,
        r.status,
        r.created_at,
        r.resolved_at,
        u.username AS reporter_username,
        u.email AS reporter_email,
        u.full_name AS reporter_full_name,
        u.status AS reporter_status,
        u.deleted_at AS reporter_deleted_at
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_id
      ORDER BY r.created_at DESC
    `);

    return res.json({
      reports: result.rows.map((row) => {
        const reporterUsername =
          row.reporter_status === 'deleted' || row.reporter_deleted_at
            ? 'deleted_user'
            : row.reporter_username || '';

        return {
          id: row.id,
          targetType: row.target_type,
          targetId: row.target_id,
          reason: row.reason,
          details: row.details,
          status: row.status,
          reporter: reporterUsername || 'unknown_user',
          reporterUsername: reporterUsername || null,
          reporterEmail: row.reporter_email || null,
          reporterName: row.reporter_full_name || null,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at,
        };
      }),
    });
  } catch (error) {
    console.error('Dashboard get reports error:', error);
    return res.status(500).json({ error: 'Failed to load reports.' });
  }
}

module.exports = {
  getDashboardUsers,
  updateUserRestriction,
  getDashboardListings,
  updateListingVisibility,
  getDashboardTransactions,
  getDashboardDisputes,
  getDashboardDisputeMessages,
  createDashboardDisputeMessage,
  resolveDashboardDispute,
  getDashboardFeedback,
  getDashboardReports,
};
