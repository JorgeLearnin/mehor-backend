'use strict';

const pool = require('../db');
const stripe = require('../lib/stripe');
const cloudinary = require('../lib/cloudinary');

const PDFDocument = require('pdfkit');
const {
  calculateOrderPricing,
  roundUpToWholeDollarCents,
} = require('../services/orderPricing.service');
const {
  createStripeItemRefundIfNeeded,
  getRemainingItemRefundableCents,
  getSellerPayoutAfterRefund,
} = require('../services/orderStripeRefund.service');
const {
  createSellerTransferForCompletedOrder,
} = require('../services/orderStripeTransfer.service');
const {
  createOrderEvent,
  getMainSellerDeliveryDueAt,
  getBuyerReviewDueAt,
} = require('../services/orderTimeline.service');
const {
  hardDeleteListingSafely,
} = require('../services/listingDeletion.service');
const {
  createNotificationWithEmail,
} = require('../services/notification.service');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function generateOrderNumber() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

function isEightDigitOrderNumber(value) {
  return /^\d{8}$/.test(String(value ?? ''));
}

function getSafeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function getSafeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function isFirstSaleFreeEligibleSeller(seller) {
  const rank = Number(seller?.first_sale_free_rank);

  return (
    Number.isInteger(rank) &&
    rank >= 1 &&
    rank <= 10 &&
    !seller.first_sale_free_used_at
  );
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isActiveDisputeStatus(value) {
  const status = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  return status === 'open' || status === 'under_review';
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedZipFile(file) {
  if (!file) return false;

  const filename = String(file.originalname ?? '').toLowerCase();
  const mimetype = String(file.mimetype ?? '').toLowerCase();

  const allowedMimeTypes = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
    'multipart/x-zip',
  ]);

  return filename.endsWith('.zip') && allowedMimeTypes.has(mimetype);
}

function uploadOrderZipToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'mehor/orders/deliveries',
        resource_type: 'raw',
      },
      (error, uploadResult) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(uploadResult);
      },
    );

    stream.end(file.buffer);
  });
}

function isAllowedDisputeImage(file) {
  if (!file) return false;

  const mimetype = String(file.mimetype ?? '').toLowerCase();

  const allowedMimeTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ]);

  return allowedMimeTypes.has(mimetype);
}

function uploadOrderDisputeImageToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'mehor/orders/disputes',
        resource_type: 'image',
      },
      (error, uploadResult) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(uploadResult);
      },
    );

    stream.end(file.buffer);
  });
}

async function restoreCanceledOrderListing({ client, listingId }) {
  const normalizedListingId = normalizeUuid(listingId);

  if (!isUuid(normalizedListingId)) return;

  await client.query(
    `
    UPDATE listings
    SET
      status = 'published',
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

async function createCompletionTransfer({ client, order, reason }) {
  const sellerPayoutCents = getSellerPayoutAfterRefund({
    order,
    itemRefundedCents: Number(order.item_refunded_cents || 0),
  });

  const sellerStripeAccountId = await getSellerStripeAccountId(
    client,
    order.seller_id,
  );

  const transferResult = await createSellerTransferForCompletedOrder({
    order,
    sellerStripeAccountId,
    amountCents: sellerPayoutCents,
    idempotencyKey: `order-completion-transfer-${order.id}-${reason}`,
  });

  return {
    sellerPayoutCents,
    stripeTransferId: transferResult.transferId,
  };
}

async function insertDisputeMessageAttachments({
  client,
  messageId,
  files,
  uploadedImages,
}) {
  const attachments = [];

  for (const file of files) {
    const uploadedImage = await uploadOrderDisputeImageToCloudinary(file);
    uploadedImages.push(uploadedImage);

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
        uploadedImage.secure_url,
        uploadedImage.public_id,
        file.originalname || null,
        file.mimetype || null,
        file.size || null,
      ],
    );

    attachments.push(attachmentResult.rows[0]);
  }

  return attachments;
}

function addDaysToIso({ startsAt, days }) {
  const start = startsAt ? new Date(startsAt) : new Date();
  const parsedDays = Number(days);

  if (!Number.isFinite(start.getTime())) return null;
  if (!Number.isFinite(parsedDays) || parsedDays < 0) return null;

  return new Date(
    start.getTime() + parsedDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function getSafeImageDownloadFilename(filename, mimeType) {
  const cleaned = String(filename ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-');

  if (cleaned) return cleaned;

  const mime = String(mimeType ?? '').toLowerCase();

  if (mime.includes('png')) return 'dispute-image.png';
  if (mime.includes('webp')) return 'dispute-image.webp';
  if (mime.includes('gif')) return 'dispute-image.gif';

  return 'dispute-image.jpg';
}

function addExtensionDaysToIso({ startsAt, days }) {
  const start = startsAt ? new Date(startsAt) : null;
  const parsedDays = Number(days);

  if (!start || !Number.isFinite(start.getTime())) return null;
  if (![1, 3, 5].includes(parsedDays)) return null;

  return new Date(
    start.getTime() + parsedDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

const TIME_EXTENSION_STAGE_CONFIG = {
  delivery: {
    partType: 'main',
    target: 'seller_delivery',
    dueColumn: 'seller_delivery_due_at',
    requiredRole: 'seller',
    requiredOrderStatus: 'delivering',
    requiredPartStatus: 'delivering',
    title: 'Delivery time extended',
    body: 'The seller extended the ZIP/repo delivery time.',
  },
  review: {
    partType: 'main',
    target: 'buyer_review',
    dueColumn: 'buyer_review_due_at',
    requiredRole: 'buyer',
    requiredOrderStatus: 'delivered',
    requiredPartStatus: 'reviewing',
    title: 'Review time extended',
    body: 'The buyer extended the ZIP/repo review time.',
  },
  addons: {
    partType: 'addon',
    target: 'seller_delivery',
    dueColumn: 'seller_delivery_due_at',
    requiredRole: 'seller',
    requiredOrderStatus: 'addons_in_progress',
    requiredPartStatus: 'delivering',
    title: 'Add-on time extended',
    body: 'The seller extended the add-ons completion time.',
  },
  addons_review: {
    partType: 'addon',
    target: 'buyer_review',
    dueColumn: 'buyer_review_due_at',
    requiredRole: 'buyer',
    requiredOrderStatus: 'addons_waiting_approval',
    requiredPartStatus: 'reviewing',
    title: 'Review time extended',
    body: 'The buyer extended the add-ons review time.',
  },
};

function formatUsdFromCents(value) {
  const cents = Number(value ?? 0);
  if (!Number.isFinite(cents)) return '$0.00';

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function getRefundedAmountCents(order) {
  const possibleRefundFields = [
    order?.item_refunded_cents,
    order?.total_refunded_cents,
    order?.refunded_total_cents,
    order?.refunded_subtotal_cents,
    order?.refunded_amount_cents,
    order?.refund_amount_cents,
    order?.partial_refund_cents,
    order?.partial_refund_amount_cents,
  ];

  for (const value of possibleRefundFields) {
    const cents = Number(value);
    if (Number.isFinite(cents) && cents > 0) {
      return Math.round(cents);
    }
  }

  return 0;
}

function getReceiptType(order) {
  const status = String(order?.status ?? '')
    .trim()
    .toLowerCase();
  const refundedAmountCents = getRefundedAmountCents(order);

  if (status === 'canceled') return 'canceled_order';

  if (status === 'completed' && refundedAmountCents > 0) {
    return 'completed_part_refunded';
  }

  return 'completed_order';
}

function getReceiptStatusLabel(order) {
  const status = String(order?.status ?? '')
    .trim()
    .toLowerCase();

  const refundedAmountCents = getRefundedAmountCents(order);

  if (status === 'canceled') return 'canceled';

  if (status === 'completed' && refundedAmountCents > 0) {
    return 'part-refunded';
  }

  return 'completed';
}

function getReceiptDeliveryAccessLabel(deliveries = []) {
  const hasZip = deliveries.some((delivery) =>
    Boolean(String(delivery.zip_filename ?? '').trim()),
  );

  const hasRepo = deliveries.some((delivery) =>
    Boolean(String(delivery.repo_link ?? '').trim()),
  );

  if (hasZip && hasRepo) return 'ZIP + Repo Access';
  if (hasZip) return 'ZIP Access';
  if (hasRepo) return 'Repo Access';

  return 'No delivery access recorded';
}

function getSafeReceiptFilename(orderNumber) {
  const safeOrderNumber = String(orderNumber ?? '')
    .trim()
    .replace(/[^\dA-Za-z_-]/g, '');

  return `mehor-receipt-${safeOrderNumber || 'order'}.txt`;
}

function formatReceiptDateEastern(value) {
  if (!value) return '';

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type).value ?? '';

  const weekday = get('weekday');
  const month = get('month');
  const day = get('day');
  const year = get('year');

  return `${weekday} ${month} ${day}, ${year} (eastern time)`;
}

function getSafeDownloadFilename(filename) {
  const cleaned = String(filename ?? 'delivery.zip')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-');

  return cleaned.toLowerCase().endsWith('.zip')
    ? cleaned
    : `${cleaned || 'delivery'}.zip`;
}

function drawReceiptBrandBlock(doc) {
  const pageWidth = doc.page.width;
  const leftMargin = doc.page.margins.left;
  const rightMargin = doc.page.margins.right;

  const logoSize = 44;
  const logoFontSize = 26;
  const logoRadius = 12;
  const top = 54;
  const logoLeft = leftMargin;

  doc
    .roundedRect(logoLeft, top, logoSize, logoSize, logoRadius)
    .fill('#020617');

  const mTop = top + 13;

  doc
    .fillColor('#fff')
    .font('Helvetica-Bold')
    .fontSize(logoFontSize)
    .text('M', logoLeft, mTop, {
      width: logoSize,
      align: 'center',
      lineBreak: false,
    })
    .text('M', logoLeft + 0.35, mTop, {
      width: logoSize,
      align: 'center',
      lineBreak: false,
    })
    .text('M', logoLeft - 0.35, mTop, {
      width: logoSize,
      align: 'center',
      lineBreak: false,
    });

  const brandTextLeft = logoLeft + logoSize + 10;

  doc
    .fillColor('#000')
    .font('Helvetica-Bold')
    .fontSize(14)
    .text('Mehor', brandTextLeft, top + 3, {
      lineBreak: false,
    });

  doc
    .fillColor('#555')
    .font('Helvetica')
    .fontSize(9.5)
    .text('Ready-to-launch websites and mobile apps', brandTextLeft, top + 22, {
      lineBreak: false,
    });

  const contactEmail = 'support@mehor.com';
  const contactWidth = 180;
  const contactLeft = pageWidth - rightMargin - contactWidth;

  doc
    .fillColor('#000')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('Mehor Support', contactLeft, top + 1, {
      width: contactWidth,
      align: 'right',
      lineBreak: false,
    });

  doc
    .fillColor('#555')
    .font('Helvetica')
    .fontSize(9.5)
    .text(contactEmail, contactLeft, top + 15, {
      width: contactWidth,
      align: 'right',
      lineBreak: false,
    });

  doc
    .fillColor('#555')
    .font('Helvetica')
    .fontSize(8.5)
    .text('Order help', contactLeft, top + 29, {
      width: contactWidth,
      align: 'right',
      lineBreak: false,
    })
    .text('Payment questions', contactLeft, top + 41, {
      width: contactWidth,
      align: 'right',
      lineBreak: false,
    })
    .text('Delivery issues', contactLeft, top + 53, {
      width: contactWidth,
      align: 'right',
      lineBreak: false,
    });

  doc.fillColor('#000').font('Helvetica');
}

function buildOrderReceiptPdf({ res, order, addons, deliveries, viewerRole }) {
  const receiptStatusLabel = getReceiptStatusLabel(order);
  const deliveryAccessLabel = getReceiptDeliveryAccessLabel(deliveries);
  const refundedAmountCents = getRefundedAmountCents(order);
  const finalizedAt = formatReceiptDateEastern(
    order.finalized_at ?? order.completed_at ?? order.canceled_at ?? null,
  );

  const isBuyerReceipt = viewerRole === 'buyer';
  const isSellerReceipt = viewerRole === 'seller';

  const orderNumber = String(order.order_number ?? '').trim();
  const orderTitle = orderNumber ? `Order: #${orderNumber}` : 'Order: #';
  const listingTitle = String(order.listing_title ?? 'Untitled listing').trim();

  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 54,
    info: {
      Title: `Mehor Receipt ${orderNumber}`,
      Author: 'Mehor',
      Subject: 'Order receipt',
    },
  });

  doc.pipe(res);

  drawReceiptBrandBlock(doc);

  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top + 72;

  doc.fontSize(26).font('Helvetica-Bold').fillColor('#000').text(orderTitle, {
    align: 'left',
  });

  doc.moveDown(0.18);

  doc.fontSize(13).font('Helvetica').fillColor('#222').text(listingTitle);

  if (finalizedAt) {
    doc.moveDown(0.35);
    doc.fontSize(10).fillColor('#555').text(finalizedAt);
  }

  doc.moveDown(1.25);

  doc.fillColor('#000').fontSize(12);

  const row = (label, value) => {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
    doc.font('Helvetica').text(String(value ?? ''));
  };

  row('Status', receiptStatusLabel);

  doc.moveDown(1.25);
  doc
    .fontSize(15)
    .font('Helvetica-Bold')
    .text('Amounts ', { continued: true })
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#555')
    .text('(fees are non-refundable)');

  doc.fillColor('#000');
  doc.moveDown(0.5);
  doc.fontSize(12).font('Helvetica');

  row('Base price', formatUsdFromCents(order.base_price_cents));
  row('Add-ons total', formatUsdFromCents(order.addons_total_cents));

  if (isBuyerReceipt) {
    row('Buyer fee', formatUsdFromCents(order.buyer_fee_cents));
    row('Total paid', formatUsdFromCents(order.total_paid_cents));
  }

  if (isSellerReceipt) {
    row('Seller fee', formatUsdFromCents(order.seller_fee_cents));
    row('Seller payout', formatUsdFromCents(order.seller_payout_cents));
  }

  if (refundedAmountCents > 0) {
    row('Refunded amount', formatUsdFromCents(refundedAmountCents));
  }

  doc.moveDown(1.25);
  doc.fontSize(15).font('Helvetica-Bold').text('Add-ons');
  doc.moveDown(0.5);
  doc.fontSize(12).font('Helvetica');

  if (addons.length > 0) {
    addons.forEach((addon, index) => {
      doc.text(
        `${index + 1}. ${addon.title ?? 'Add-on'} - ${formatUsdFromCents(
          addon.price_cents,
        )} - ${addon.delivery_days ?? '-'} days`,
      );
    });
  } else {
    doc.text('None');
  }

  doc.moveDown(1.25);
  doc.fontSize(15).font('Helvetica-Bold').text('Delivery method');
  doc.moveDown(0.5);
  doc.fontSize(12).font('Helvetica').text(deliveryAccessLabel);

  doc.moveDown(1.5);

  if (isBuyerReceipt) {
    doc.fontSize(11).fillColor('#000').text('Thank you for your purchase.');
    doc.moveDown(0.75);
  }

  doc.end();
}

function getCloudinaryAttachmentUrl({ publicId, filename, fallbackUrl }) {
  const cleanedPublicId = String(publicId ?? '').trim();

  if (!cleanedPublicId) {
    return fallbackUrl;
  }

  return cloudinary.url(cleanedPublicId, {
    resource_type: 'raw',
    secure: true,
    flags: `attachment:${getSafeDownloadFilename(filename)}`,
  });
}

async function getOrderPayloadForUser({ client = pool, orderId, userId }) {
  const orderResult = await client.query(
    `
    SELECT *
    FROM orders
    WHERE id = $1
    LIMIT 1
    `,
    [orderId],
  );

  const order = orderResult.rows[0];

  if (!order) {
    throw new HttpError(404, 'Order not found');
  }

  const isBuyer = String(order.buyer_id) === String(userId);
  const isSeller = String(order.seller_id) === String(userId);

  if (!isBuyer && !isSeller) {
    throw new HttpError(403, 'Not authorized');
  }

  const [
    partsResult,
    addonsResult,
    deliveriesResult,
    disputesResult,
    disputeMessagesResult,
    disputeMessageAttachmentsResult,
    eventsResult,
    extensionsResult,
  ] = await Promise.all([
    client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
      ORDER BY
        CASE part_type
          WHEN 'main' THEN 1
          WHEN 'addon' THEN 2
          ELSE 3
        END,
        created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT *
      FROM order_addons
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT *
      FROM order_deliveries
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT *
      FROM order_disputes
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT *
      FROM order_dispute_messages
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT
        a.*
      FROM order_dispute_message_attachments a
      INNER JOIN order_dispute_messages m
        ON m.id = a.message_id
      WHERE m.order_id = $1
      ORDER BY a.created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT *
      FROM order_events
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    ),
    client.query(
      `
      SELECT *
      FROM order_time_extensions
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [orderId],
    ),
  ]);

  const attachmentsByMessageId = new Map();

  for (const attachment of disputeMessageAttachmentsResult.rows) {
    const messageId = String(attachment.message_id);

    if (!attachmentsByMessageId.has(messageId)) {
      attachmentsByMessageId.set(messageId, []);
    }

    attachmentsByMessageId.get(messageId).push(attachment);
  }

  const disputeMessages = disputeMessagesResult.rows.map((message) => ({
    ...message,
    attachments: attachmentsByMessageId.get(String(message.id)) ?? [],
  }));

  return {
    order,
    parts: partsResult.rows,
    addons: addonsResult.rows,
    deliveries: deliveriesResult.rows,
    disputes: disputesResult.rows,
    disputeMessages,
    timelineEvents: eventsResult.rows,
    timeExtensions: extensionsResult.rows,
  };
}

function getPublicOrderUrl(orderId) {
  return `/order/${orderId}`;
}

function getOrderLabel(order) {
  const orderNumber = String(order?.order_number ?? '').trim();
  return orderNumber ? `#${orderNumber}` : 'your order';
}

function getDisputeStageLabel(stage) {
  return String(stage) === 'addons' ? 'add-ons review' : 'ZIP/repo review';
}

async function notifyOrderCreated({ client, order }) {
  const orderLabel = getOrderLabel(order);
  const actionUrl = getPublicOrderUrl(order.id);

  await Promise.all([
    createNotificationWithEmail({
      userId: order.buyer_id,
      type: 'order_created',
      title: 'Order created',
      body: `Your order ${orderLabel} was created successfully.`,
      actionUrl,
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        role: 'buyer',
      },
      emailSubject: `Order ${orderLabel} created`,
      emailTitle: 'Your order was created',
      emailBody: `Your order ${orderLabel} was created successfully. You can now track it from your order page.`,
      emailActionLabel: 'View order',
      db: client,
    }),
    createNotificationWithEmail({
      userId: order.seller_id,
      type: 'order_created',
      title: 'New order',
      body: `You received a new order ${orderLabel}.`,
      actionUrl,
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        role: 'seller',
      },
      emailSubject: `New order ${orderLabel}`,
      emailTitle: 'You received a new order',
      emailBody: `You received a new order ${orderLabel}. Please review the order and prepare the ZIP/repo delivery.`,
      emailActionLabel: 'View order',
      db: client,
    }),
  ]);
}

async function notifyDisputeOpened({ client, order, dispute, stage }) {
  const orderLabel = getOrderLabel(order);
  const stageLabel = getDisputeStageLabel(stage);

  await createNotificationWithEmail({
    userId: order.seller_id,
    type: 'order_dispute_opened',
    title: 'Dispute opened',
    body: `A dispute was opened for ${stageLabel} on order ${orderLabel}.`,
    actionUrl: getPublicOrderUrl(order.id),
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      disputeId: dispute.id,
      stage,
    },
    emailSubject: `Dispute opened on order ${orderLabel}`,
    emailTitle: 'A dispute was opened',
    emailBody: `A dispute was opened for ${stageLabel} on order ${orderLabel}. Please review the dispute conversation.`,
    emailActionLabel: 'View dispute',
    db: client,
  });
}

async function notifyDisputeMessageCreated({
  client,
  order,
  dispute,
  message,
  senderRole,
}) {
  const recipientId = senderRole === 'buyer' ? order.seller_id : order.buyer_id;
  const orderLabel = getOrderLabel(order);
  const stage = String(dispute.opened_stage ?? '').trim();
  const stageLabel = getDisputeStageLabel(stage);

  await createNotificationWithEmail({
    userId: recipientId,
    type: 'order_dispute_message_received',
    title: 'New dispute message',
    body: `New message in the ${stageLabel} dispute for order ${orderLabel}.`,
    actionUrl: getPublicOrderUrl(order.id),
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      disputeId: dispute.id,
      messageId: message.id,
      stage,
      senderRole,
    },
    emailSubject: `New dispute message on order ${orderLabel}`,
    emailTitle: 'New dispute message',
    emailBody: `There is a new message in the ${stageLabel} dispute for order ${orderLabel}.`,
    emailActionLabel: 'View dispute',
    db: client,
  });
}

async function notifyOrderFinalized({ client, order, status, reason }) {
  const orderLabel = getOrderLabel(order);
  const isCanceled = status === 'canceled';
  const title = isCanceled ? 'Order canceled' : 'Order completed';
  const body = isCanceled
    ? `Order ${orderLabel} was canceled.`
    : `Order ${orderLabel} was completed.`;

  await Promise.all([
    createNotificationWithEmail({
      userId: order.buyer_id,
      type: isCanceled ? 'order_canceled' : 'order_completed',
      title,
      body,
      actionUrl: getPublicOrderUrl(order.id),
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        reason,
        role: 'buyer',
      },
      emailSubject: `${title}: ${orderLabel}`,
      emailTitle: title,
      emailBody: body,
      emailActionLabel: 'View order',
      db: client,
    }),
    createNotificationWithEmail({
      userId: order.seller_id,
      type: isCanceled ? 'order_canceled' : 'order_completed',
      title,
      body,
      actionUrl: getPublicOrderUrl(order.id),
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
        reason,
        role: 'seller',
      },
      emailSubject: `${title}: ${orderLabel}`,
      emailTitle: title,
      emailBody: body,
      emailActionLabel: 'View order',
      db: client,
    }),
  ]);
}

async function sendDeadlineWarning({
  client,
  order,
  orderPart,
  userId,
  target,
  title,
  body,
}) {
  const insertedResult = await client.query(
    `
    INSERT INTO order_deadline_notifications (
      order_id,
      order_part_id,
      user_id,
      target,
      channel,
      sent_at
    ) VALUES ($1,$2,$3,$4,'in_app_email',NOW())
    ON CONFLICT (order_part_id, user_id, target)
    DO NOTHING
    RETURNING id
    `,
    [order.id, orderPart.id, userId, target],
  );

  if (insertedResult.rowCount !== 1) return false;

  await createNotificationWithEmail({
    userId,
    type: 'order_deadline_10h_remaining',
    title,
    body,
    actionUrl: getPublicOrderUrl(order.id),
    metadata: {
      orderId: order.id,
      orderNumber: order.order_number,
      orderPartId: orderPart.id,
      partType: orderPart.part_type,
      target,
    },
    emailSubject: title,
    emailTitle: title,
    emailBody: body,
    emailActionLabel: 'View order',
    db: client,
  });

  return true;
}

async function getBuyerOrders(req, res) {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `
      SELECT
        id,
        order_number,
        listing_id,
        listing_title,
        listing_type,
        delivery_method,
        status,
        payment_status,
        base_price_cents,
        addons_total_cents,
        total_paid_cents,
        currency,
        seller_id,
        buyer_id,
        created_at
      FROM orders
      WHERE buyer_id = $1
      ORDER BY created_at DESC
      `,
      [userId],
    );

    return res.json({ orders: result.rows });
  } catch (error) {
    console.error('Get buyer orders error:', error);
    return res.status(500).json({ error: 'Failed to load orders' });
  }
}

async function getSellerOrders(req, res) {
  try {
    const userId = req.user.id;

    const [ordersResult, earningsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          id,
          order_number,
          listing_id,
          listing_title,
          listing_type,
          delivery_method,
          status,
          payment_status,
          base_price_cents,
          addons_total_cents,
          total_paid_cents,
          seller_payout_cents,
          currency,
          seller_id,
          buyer_id,
          created_at,
          finalized_at,
          completed_at
        FROM orders
        WHERE seller_id = $1
        ORDER BY created_at DESC
        `,
        [userId],
      ),
      pool.query(
        `
        SELECT COALESCE(SUM(seller_payout_cents), 0)::integer AS total_earnings_cents
        FROM orders
        WHERE seller_id = $1
          AND status = 'completed'
          AND finalized_at IS NOT NULL
        `,
        [userId],
      ),
    ]);

    return res.json({
      orders: ordersResult.rows,
      totalEarningsCents: earningsResult.rows[0]?.total_earnings_cents ?? 0,
    });
  } catch (error) {
    console.error('Get seller orders error:', error);
    return res.status(500).json({ error: 'Failed to load orders' });
  }
}

async function getOrderById(req, res) {
  try {
    const userId = req.user.id;
    const { orderId } = req.params;
    const normalizedOrderId = normalizeUuid(orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    const payload = await getOrderPayloadForUser({
      orderId: normalizedOrderId,
      userId,
    });

    return res.json(payload);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }

    console.error('Get order by id error:', error);
    return res.status(500).json({ error: 'Failed to load order' });
  }
}

async function submitOrderDelivery(req, res) {
  const client = await pool.connect();
  let uploadedZip = null;
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    const repoLink = trimString(req.body?.repoLink);
    const repoEmail = trimString(req.body?.repoEmail);
    const buyerGithubUsername = trimString(req.body?.buyerGithubUsername);
    const repoMessage = trimString(req.body?.repoMessage);
    const zipFile = req.file ?? null;

    if (!zipFile && !repoLink) {
      return res.status(400).json({
        error: 'ZIP file or repository access is required',
      });
    }

    if (zipFile && !isAllowedZipFile(zipFile)) {
      return res.status(400).json({ error: 'Only .zip files are allowed' });
    }

    if (repoLink) {
      if (!isValidHttpUrl(repoLink)) {
        return res.status(400).json({ error: 'Invalid repository link' });
      }

      if (!buyerGithubUsername) {
        return res.status(400).json({
          error: 'Repo username is required when sharing repository access',
        });
      }
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    if (String(order.seller_id) !== String(userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (
      String(order.status) !== 'delivering' ||
      String(order.payment_status) !== 'paid'
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Order is not ready for delivery submission',
      });
    }

    const mainPartResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = 'main'
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const mainPart = mainPartResult.rows[0];

    if (!mainPart) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Main order part not found' });
    }

    if (String(mainPart.status) !== 'delivering') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Main delivery is not accepting submissions',
      });
    }

    if (zipFile) {
      uploadedZip = await uploadOrderZipToCloudinary(zipFile);
    }

    const deliveredAt = new Date().toISOString();
    const buyerReviewDueAt = getBuyerReviewDueAt({ deliveredAt });

    if (!buyerReviewDueAt) {
      throw new Error('Failed to calculate buyer review deadline');
    }

    const hasZip = Boolean(uploadedZip?.secure_url);
    const hasRepo = Boolean(repoLink);

    await client.query(
      `
      INSERT INTO order_deliveries (
        order_id,
        order_part_id,
        zip_url,
        zip_public_id,
        zip_filename,
        zip_size_bytes,
        repo_link,
        repo_email,
        buyer_github_username,
        repo_message
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        normalizedOrderId,
        mainPart.id,
        uploadedZip?.secure_url ?? null,
        uploadedZip?.public_id ?? null,
        zipFile?.originalname ?? null,
        zipFile?.size ?? null,
        repoLink || null,
        repoEmail || null,
        buyerGithubUsername || null,
        repoMessage || null,
      ],
    );

    await client.query(
      `
      UPDATE order_parts
      SET
        status = 'reviewing',
        delivered_at = $2,
        buyer_review_due_at = $3,
        updated_at = NOW()
      WHERE id = $1
      `,
      [mainPart.id, deliveredAt, buyerReviewDueAt],
    );

    await client.query(
      `
      UPDATE orders
      SET
        status = 'delivered',
        updated_at = NOW()
      WHERE id = $1
      `,
      [normalizedOrderId],
    );

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: mainPart.id,
      actorId: userId,
      type: 'main_delivery_submitted',
      title: 'Delivery submitted',
      body: 'The seller submitted the ZIP/repo delivery for buyer review.',
      metadata: {
        hasZip,
        hasRepo,
        buyerReviewDueAt,
      },
    });

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    if (uploadedZip?.public_id) {
      try {
        await cloudinary.uploader.destroy(uploadedZip.public_id, {
          resource_type: 'raw',
        });
      } catch (cleanupError) {
        console.error('Order ZIP cleanup error:', cleanupError);
      }
    }

    console.error('Submit order delivery error:', error);
    return res.status(500).json({ error: 'Failed to submit delivery' });
  } finally {
    client.release();
  }
}

async function approveMainDelivery(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    if (String(order.buyer_id) !== String(userId)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (
      String(order.status) !== 'delivered' ||
      String(order.payment_status) !== 'paid'
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Order is not ready for approval',
      });
    }

    const mainPartResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = 'main'
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const mainPart = mainPartResult.rows[0];

    if (!mainPart) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Main order part not found' });
    }

    if (String(mainPart.status) !== 'reviewing') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Main delivery is not awaiting buyer approval',
      });
    }

    const addonPartResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = 'addon'
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const addonPart = addonPartResult.rows[0] ?? null;

    const addonsResult = await client.query(
      `
      SELECT *
      FROM order_addons
      WHERE order_id = $1
      ORDER BY created_at ASC
      `,
      [normalizedOrderId],
    );

    const addons = addonsResult.rows;
    const hasAddons = Boolean(addonPart && addons.length > 0);
    const approvedAt = new Date().toISOString();
    let shouldDeleteListingImages = false;

    await client.query(
      `
      UPDATE order_parts
      SET
        status = 'completed',
        completed_at = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [mainPart.id, approvedAt],
    );

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: mainPart.id,
      actorId: userId,
      type: 'main_delivery_approved',
      title: 'Delivery approved',
      body: 'The buyer approved the ZIP/repo delivery.',
      metadata: {
        approvedAt,
      },
    });

    if (!hasAddons) {
      const completionTransfer = await createCompletionTransfer({
        client,
        order,
        reason: 'main_delivery_approved',
      });

      await client.query(
        `
        UPDATE orders
        SET
          status = 'completed',
          seller_payout_cents = $3,
          stripe_transfer_id = $4,
          completed_at = $2,
          finalized_at = $2,
          updated_at = NOW()
        WHERE id = $1
        `,
        [
          normalizedOrderId,
          approvedAt,
          completionTransfer.sellerPayoutCents,
          completionTransfer.stripeTransferId,
        ],
      );

      await createOrderEvent(client, {
        orderId: normalizedOrderId,
        orderPartId: mainPart.id,
        actorId: userId,
        type: 'order_completed',
        title: 'Order completed',
        body: 'The order was completed after the buyer approved the ZIP/repo delivery.',
        metadata: {
          completedAt: approvedAt,
          completedReason: 'main_delivery_approved',
        },
      });

      await notifyOrderFinalized({
        client,
        order,
        status: 'completed',
        reason: 'main_delivery_approved',
      });

      shouldDeleteListingImages = true;
    } else {
      const addonTotalDays = addons.reduce((sum, addon) => {
        const days = Number(addon.delivery_days);
        return sum + (Number.isFinite(days) && days > 0 ? days : 0);
      }, 0);

      if (addonTotalDays <= 0) {
        throw new Error('Failed to calculate add-on delivery deadline');
      }

      const addonSellerDeliveryDueAt = addDaysToIso({
        startsAt: approvedAt,
        days: addonTotalDays,
      });

      if (!addonSellerDeliveryDueAt) {
        throw new Error('Failed to calculate add-on delivery deadline');
      }

      await client.query(
        `
        UPDATE order_parts
        SET
          status = 'delivering',
          seller_delivery_due_at = $2,
          updated_at = NOW()
        WHERE id = $1
        `,
        [addonPart.id, addonSellerDeliveryDueAt],
      );

      await client.query(
        `
        UPDATE orders
        SET
          status = 'addons_in_progress',
          updated_at = NOW()
        WHERE id = $1
        `,
        [normalizedOrderId],
      );

      await createOrderEvent(client, {
        orderId: normalizedOrderId,
        orderPartId: addonPart.id,
        actorId: userId,
        type: 'addons_started',
        title: 'Add-ons started',
        body: 'The buyer approved the ZIP/repo delivery, so selected add-ons are now in progress.',
        metadata: {
          addonCount: addons.length,
          sellerDeliveryDueAt: addonSellerDeliveryDueAt,
        },
      });
    }

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    if (shouldDeleteListingImages) {
      await hardDeleteListingSafely({
        listingId: order.listing_id,
        context: 'order_completed_listing_delete',
      });
    }

    return res.json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    console.error('Approve main delivery error:', error);
    return res.status(500).json({ error: 'Failed to approve delivery' });
  } finally {
    client.release();
  }
}

async function completeAddonsDelivery(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    if (String(order.seller_id) !== String(userId)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (
      String(order.status) !== 'addons_in_progress' ||
      String(order.payment_status) !== 'paid'
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Order add-ons are not ready to be marked complete',
      });
    }

    const addonPartResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = 'addon'
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const addonPart = addonPartResult.rows[0];

    if (!addonPart) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Add-on order part not found' });
    }

    if (String(addonPart.status) !== 'delivering') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Add-ons are not accepting completion',
      });
    }

    const completedAt = new Date().toISOString();
    const buyerReviewDueAt = getBuyerReviewDueAt({ deliveredAt: completedAt });

    if (!buyerReviewDueAt) {
      throw new Error('Failed to calculate add-on review deadline');
    }

    await client.query(
      `
      UPDATE order_parts
      SET
        status = 'reviewing',
        delivered_at = $2,
        buyer_review_due_at = $3,
        updated_at = NOW()
      WHERE id = $1
      `,
      [addonPart.id, completedAt, buyerReviewDueAt],
    );

    await client.query(
      `
      UPDATE orders
      SET
        status = 'addons_waiting_approval',
        updated_at = NOW()
      WHERE id = $1
      `,
      [normalizedOrderId],
    );

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: addonPart.id,
      actorId: userId,
      type: 'addons_completed',
      title: 'Add-ons completed',
      body: 'The seller marked the selected add-ons as complete for buyer review.',
      metadata: {
        completedAt,
        buyerReviewDueAt,
      },
    });

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    return res.json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    console.error('Complete add-ons delivery error:', error);
    return res.status(500).json({ error: 'Failed to mark add-ons complete' });
  } finally {
    client.release();
  }
}

async function approveAddonsDelivery(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    if (String(order.buyer_id) !== String(userId)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (
      String(order.status) !== 'addons_waiting_approval' ||
      String(order.payment_status) !== 'paid'
    ) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Add-ons are not ready for approval',
      });
    }

    const addonPartResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = 'addon'
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const addonPart = addonPartResult.rows[0];

    if (!addonPart) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Add-on order part not found' });
    }

    if (String(addonPart.status) !== 'reviewing') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Add-ons are not awaiting buyer approval',
      });
    }

    const approvedAt = new Date().toISOString();

    await client.query(
      `
      UPDATE order_parts
      SET
        status = 'completed',
        completed_at = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [addonPart.id, approvedAt],
    );

    const completionTransfer = await createCompletionTransfer({
      client,
      order,
      reason: 'addons_approved',
    });

    await client.query(
      `
      UPDATE orders
      SET
        status = 'completed',
        seller_payout_cents = $3,
        stripe_transfer_id = $4,
        completed_at = $2,
        finalized_at = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        normalizedOrderId,
        approvedAt,
        completionTransfer.sellerPayoutCents,
        completionTransfer.stripeTransferId,
      ],
    );

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: addonPart.id,
      actorId: userId,
      type: 'addons_approved',
      title: 'Add-ons approved',
      body: 'The buyer approved the selected add-ons.',
      metadata: {
        approvedAt,
      },
    });

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: addonPart.id,
      actorId: userId,
      type: 'order_completed',
      title: 'Order completed',
      body: 'The order was completed after the buyer approved the selected add-ons.',
      metadata: {
        completedAt: approvedAt,
        completedReason: 'addons_approved',
      },
    });

    await notifyOrderFinalized({
      client,
      order,
      status: 'completed',
      reason: 'addons_approved',
    });

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    await hardDeleteListingSafely({
      listingId: order.listing_id,
      context: 'order_completed_listing_delete',
    });

    return res.json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    console.error('Approve add-ons delivery error:', error);
    return res.status(500).json({ error: 'Failed to approve add-ons' });
  } finally {
    client.release();
  }
}

async function extendOrderTime(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    const stage = String(req.body?.stage ?? '')
      .trim()
      .toLowerCase();

    const extensionDays = Number(req.body?.days);

    const config = TIME_EXTENSION_STAGE_CONFIG[stage];

    if (!config) {
      return res.status(400).json({ error: 'Invalid extension stage' });
    }

    if (![1, 3, 5].includes(extensionDays)) {
      return res
        .status(400)
        .json({ error: 'Extension must be 1, 3, or 5 days' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    const isBuyer = String(order.buyer_id) === String(userId);
    const isSeller = String(order.seller_id) === String(userId);
    const requesterRole = isBuyer ? 'buyer' : isSeller ? 'seller' : null;

    if (!requesterRole) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (requesterRole !== config.requiredRole) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({
        error:
          config.requiredRole === 'seller'
            ? 'Only the seller can extend this time window'
            : 'Only the buyer can extend this time window',
      });
    }

    if (String(order.payment_status) !== 'paid') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Order is not paid' });
    }

    if (String(order.status) !== config.requiredOrderStatus) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'This time window is not active' });
    }

    const partResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = $2
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId, config.partType],
    );

    const orderPart = partResult.rows[0];

    if (!orderPart) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Order part not found' });
    }

    if (String(orderPart.status) !== config.requiredPartStatus) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'This time window is not active' });
    }

    if (orderPart.disputed_at) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Time cannot be extended while this order part is disputed',
      });
    }

    const openDisputeResult = await client.query(
      `
      SELECT id
      FROM order_disputes
      WHERE order_part_id = $1
        AND status IN ('open', 'under review')
      LIMIT 1
      `,
      [orderPart.id],
    );

    if (openDisputeResult.rows[0]) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'Time cannot be extended while this order part is disputed',
      });
    }

    const previousDueAt = orderPart[config.dueColumn];

    if (!previousDueAt) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'No active due date found' });
    }

    const extensionCountResult = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM order_time_extensions
      WHERE order_part_id = $1
        AND target = $2
      `,
      [orderPart.id, config.target],
    );

    const previousExtensionCount = Number(
      extensionCountResult.rows[0]?.count ?? 0,
    );

    if (previousExtensionCount >= 2) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'This time window has already been extended twice',
      });
    }

    const extensionNumber = previousExtensionCount + 1;

    const newDueAt = addExtensionDaysToIso({
      startsAt: previousDueAt,
      days: extensionDays,
    });

    if (!newDueAt) {
      throw new Error('Failed to calculate new due date');
    }

    await client.query(
      `
      UPDATE order_parts
      SET
        ${config.dueColumn} = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [orderPart.id, newDueAt],
    );

    await client.query(
      `
      INSERT INTO order_time_extensions (
        order_id,
        order_part_id,
        requested_by,
        requester_role,
        target,
        extension_number,
        extension_days,
        previous_due_at,
        new_due_at,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      `,
      [
        normalizedOrderId,
        orderPart.id,
        userId,
        requesterRole,
        config.target,
        extensionNumber,
        extensionDays,
        previousDueAt,
        newDueAt,
      ],
    );

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: orderPart.id,
      actorId: userId,
      type: 'time_extended',
      title: config.title,
      body: config.body,
      metadata: {
        stage,
        target: config.target,
        extensionNumber,
        extensionDays,
        previousDueAt,
        newDueAt,
      },
    });

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    return res.json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    console.error('Extend order time error:', error);
    return res.status(500).json({ error: 'Failed to extend time' });
  } finally {
    client.release();
  }
}

async function downloadOrderReceipt(req, res) {
  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    const orderResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const isBuyer = String(order.buyer_id) === String(userId);
    const isSeller = String(order.seller_id) === String(userId);

    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const status = String(order.status ?? '')
      .trim()
      .toLowerCase();

    if (status !== 'completed' && status !== 'canceled') {
      return res.status(400).json({
        error: 'Receipt is available only after the order is finalized',
      });
    }

    const [addonsResult, deliveriesResult] = await Promise.all([
      pool.query(
        `
        SELECT *
        FROM order_addons
        WHERE order_id = $1
        ORDER BY created_at ASC
        `,
        [normalizedOrderId],
      ),
      pool.query(
        `
        SELECT *
        FROM order_deliveries
        WHERE order_id = $1
        ORDER BY created_at ASC
        `,
        [normalizedOrderId],
      ),
    ]);

    const filename = getSafeReceiptFilename(order.order_number).replace(
      /\.txt$/i,
      '.pdf',
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return buildOrderReceiptPdf({
      res,
      order,
      addons: addonsResult.rows,
      deliveries: deliveriesResult.rows,
      viewerRole: isBuyer ? 'buyer' : 'seller',
    });
  } catch (error) {
    console.error('Download order receipt error:', error);
    return res.status(500).json({ error: 'Failed to download receipt' });
  }
}

async function downloadOrderDeliveryZip(req, res) {
  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);
    const normalizedDeliveryId = normalizeUuid(req.params.deliveryId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    if (!isUuid(normalizedDeliveryId)) {
      return res.status(400).json({ error: 'Invalid deliveryId' });
    }

    const orderResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const isBuyer = String(order.buyer_id) === String(userId);
    const isSeller = String(order.seller_id) === String(userId);

    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const deliveryResult = await pool.query(
      `
      SELECT *
      FROM order_deliveries
      WHERE id = $1
        AND order_id = $2
      LIMIT 1
      `,
      [normalizedDeliveryId, normalizedOrderId],
    );

    const delivery = deliveryResult.rows[0];

    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const zipUrl = String(delivery.zip_url ?? '').trim();

    if (!zipUrl) {
      return res.status(404).json({ error: 'ZIP file not found' });
    }

    const filename = getSafeDownloadFilename(delivery.zip_filename);

    const upstream = await fetch(zipUrl);

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'ZIP file could not be loaded' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const arrayBuffer = await upstream.arrayBuffer();

    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Download order ZIP error:', error);
    return res.status(500).json({ error: 'Failed to download ZIP' });
  }
}

async function downloadOrderDisputeAttachment(req, res) {
  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);
    const normalizedAttachmentId = normalizeUuid(req.params.attachmentId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    if (!isUuid(normalizedAttachmentId)) {
      return res.status(400).json({ error: 'Invalid attachmentId' });
    }

    const attachmentResult = await pool.query(
      `
      SELECT
        a.*,
        m.order_id,
        o.buyer_id,
        o.seller_id
      FROM order_dispute_message_attachments a
      INNER JOIN order_dispute_messages m
        ON m.id = a.message_id
      INNER JOIN orders o
        ON o.id = m.order_id
      WHERE a.id = $1
        AND m.order_id = $2
      LIMIT 1
      `,
      [normalizedAttachmentId, normalizedOrderId],
    );

    const attachment = attachmentResult.rows[0];

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const isBuyer = String(attachment.buyer_id) === String(userId);
    const isSeller = String(attachment.seller_id) === String(userId);

    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const imageUrl = String(attachment.url ?? '').trim();

    if (!imageUrl) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const upstream = await fetch(imageUrl);

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Image could not be loaded' });
    }

    const contentType =
      String(attachment.mime_type ?? '').trim() ||
      upstream.headers.get('content-type') ||
      'application/octet-stream';

    const filename = getSafeImageDownloadFilename(
      attachment.file_name,
      contentType,
    );

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    const arrayBuffer = await upstream.arrayBuffer();

    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Download dispute attachment error:', error);
    return res.status(500).json({ error: 'Failed to download attachment' });
  }
}

async function openOrderDispute(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;
  const uploadedImages = [];

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    const stage = String(req.body?.stage ?? '')
      .trim()
      .toLowerCase();
    const reason = trimString(req.body?.reason);
    const message = trimString(req.body?.message);

    const screenshots = Array.isArray(req.files) ? req.files : [];

    if (screenshots.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 screenshots allowed' });
    }

    for (const file of screenshots) {
      if (!isAllowedDisputeImage(file)) {
        return res.status(400).json({
          error: 'Only JPG, PNG, WEBP, or GIF screenshots are allowed',
        });
      }
    }

    if (stage !== 'delivery' && stage !== 'addons') {
      return res.status(400).json({ error: 'Invalid dispute stage' });
    }

    if (!reason) {
      return res.status(400).json({ error: 'Dispute reason is required' });
    }

    if (!message) {
      return res.status(400).json({ error: 'Dispute details are required' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    if (String(order.buyer_id) !== String(userId)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res
        .status(403)
        .json({ error: 'Only the buyer can open a dispute' });
    }

    if (String(order.payment_status) !== 'paid') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Order is not paid' });
    }

    const expectedOrderStatus =
      stage === 'delivery' ? 'delivered' : 'addons_waiting_approval';

    if (String(order.status) !== expectedOrderStatus) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error:
          stage === 'delivery'
            ? 'Main delivery is not available for dispute'
            : 'Add-ons are not available for dispute',
      });
    }

    const expectedPartType = stage === 'delivery' ? 'main' : 'addon';

    const partResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE order_id = $1
        AND part_type = $2
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId, expectedPartType],
    );

    const orderPart = partResult.rows[0];

    if (!orderPart) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error:
          stage === 'delivery'
            ? 'Main order part not found'
            : 'Add-on order part not found',
      });
    }

    if (String(orderPart.status) !== 'reviewing') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error:
          stage === 'delivery'
            ? 'Main delivery is not in buyer review'
            : 'Add-ons are not in buyer review',
      });
    }

    const existingDisputeResult = await client.query(
      `
      SELECT *
      FROM order_disputes
      WHERE order_part_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [orderPart.id],
    );

    const existingDispute = existingDisputeResult.rows[0] ?? null;

    if (existingDispute) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({
        error:
          stage === 'delivery'
            ? 'A ZIP/repo dispute already exists for this order'
            : 'An add-ons dispute already exists for this order',
      });
    }

    const openedAt = new Date().toISOString();

    await client.query(
      `
      UPDATE order_parts
      SET
        disputed_at = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [orderPart.id, openedAt],
    );

    const disputeResult = await client.query(
      `
      INSERT INTO order_disputes (
        order_id,
        order_part_id,
        opened_by,
        status,
        opened_stage,
        opened_at,
        created_at,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
      RETURNING *
      `,
      [normalizedOrderId, orderPart.id, userId, 'open', stage, openedAt],
    );

    const dispute = disputeResult.rows[0];

    const initialMessageResult = await client.query(
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
      RETURNING *
      `,
      [
        normalizedOrderId,
        dispute.id,
        userId,
        'buyer',
        message,
        true,
        reason,
        stage,
      ],
    );

    const initialMessage = initialMessageResult.rows[0];

    await insertDisputeMessageAttachments({
      client,
      messageId: initialMessage.id,
      files: screenshots,
      uploadedImages,
    });

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: orderPart.id,
      actorId: userId,
      type: stage === 'delivery' ? 'main_delivery_disputed' : 'addons_disputed',
      title: 'Dispute opened',
      body:
        stage === 'delivery'
          ? 'The buyer opened a dispute for the ZIP/repo delivery.'
          : 'The buyer opened a dispute for the add-ons delivery.',
      metadata: {
        disputeId: dispute.id,
        initialMessageId: initialMessage.id,
        openedStage: stage,
        reason,
        openedAt,
      },
    });

    await notifyDisputeOpened({
      client,
      order,
      dispute,
      stage,
    });

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    for (const uploadedImage of uploadedImages) {
      if (!uploadedImage?.public_id) continue;

      try {
        await cloudinary.uploader.destroy(uploadedImage.public_id, {
          resource_type: 'image',
        });
      } catch (cleanupError) {
        console.error('Dispute screenshot cleanup error:', cleanupError);
      }
    }

    console.error('Open order dispute error:', error);
    return res.status(500).json({ error: 'Failed to open dispute' });
  } finally {
    client.release();
  }
}

async function replyToOrderDispute(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;
  const uploadedImages = [];

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);
    const normalizedDisputeId = normalizeUuid(req.params.disputeId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    if (!isUuid(normalizedDisputeId)) {
      return res.status(400).json({ error: 'Invalid disputeId' });
    }

    const message = trimString(req.body?.message);
    const attachments = Array.isArray(req.files) ? req.files : [];

    if (attachments.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 attachments allowed' });
    }

    for (const file of attachments) {
      if (!isAllowedDisputeImage(file)) {
        return res.status(400).json({
          error: 'Only JPG, PNG, WEBP, or GIF attachments are allowed',
        });
      }
    }

    if (!message && attachments.length === 0) {
      return res.status(400).json({
        error: 'A dispute reply requires a message or at least one attachment',
      });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    const isBuyer = String(order.buyer_id) === String(userId);
    const isSeller = String(order.seller_id) === String(userId);

    if (!isBuyer && !isSeller) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Not authorized' });
    }

    const disputeResult = await client.query(
      `
      SELECT *
      FROM order_disputes
      WHERE id = $1
        AND order_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedDisputeId, normalizedOrderId],
    );

    const dispute = disputeResult.rows[0];

    if (!dispute) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Dispute not found' });
    }

    if (String(dispute.status) !== 'open') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Dispute is not open' });
    }

    const senderRole = isBuyer ? 'buyer' : 'seller';

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
        normalizedOrderId,
        normalizedDisputeId,
        userId,
        senderRole,
        message || null,
        false,
        null,
      ],
    );

    const disputeMessage = messageResult.rows[0];

    await insertDisputeMessageAttachments({
      client,
      messageId: disputeMessage.id,
      files: attachments,
      uploadedImages,
    });

    await notifyDisputeMessageCreated({
      client,
      order,
      dispute,
      message: disputeMessage,
      senderRole,
    });

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    for (const uploadedImage of uploadedImages) {
      if (!uploadedImage?.public_id) continue;

      try {
        await cloudinary.uploader.destroy(uploadedImage.public_id, {
          resource_type: 'image',
        });
      } catch (cleanupError) {
        console.error('Dispute reply attachment cleanup error:', cleanupError);
      }
    }

    console.error('Reply to order dispute error:', error);
    return res.status(500).json({ error: 'Failed to send dispute reply' });
  } finally {
    client.release();
  }
}

async function approveDisputedDelivery(req, res) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const userId = req.user.id;
    const normalizedOrderId = normalizeUuid(req.params.orderId);
    const normalizedDisputeId = normalizeUuid(req.params.disputeId);

    if (!isUuid(normalizedOrderId)) {
      return res.status(400).json({ error: 'Invalid orderId' });
    }

    if (!isUuid(normalizedDisputeId)) {
      return res.status(400).json({ error: 'Invalid disputeId' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedOrderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Order not found' });
    }

    if (String(order.buyer_id) !== String(userId)) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({
        error: 'Only the buyer can approve a disputed delivery',
      });
    }

    if (String(order.payment_status) !== 'paid') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Order is not paid' });
    }

    const disputeResult = await client.query(
      `
      SELECT *
      FROM order_disputes
      WHERE id = $1
        AND order_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedDisputeId, normalizedOrderId],
    );

    const dispute = disputeResult.rows[0];

    if (!dispute) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Dispute not found' });
    }

    const disputeStatus = String(dispute.status ?? '')
      .trim()
      .toLowerCase();

    if (disputeStatus !== 'open' && disputeStatus !== 'under review') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Dispute is not open' });
    }

    const stage = String(dispute.opened_stage ?? '')
      .trim()
      .toLowerCase();

    if (stage !== 'delivery' && stage !== 'addons') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Invalid dispute stage' });
    }

    const expectedOrderStatus =
      stage === 'delivery' ? 'delivered' : 'addons_waiting_approval';

    if (String(order.status) !== expectedOrderStatus) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error:
          stage === 'delivery'
            ? 'Main delivery dispute is not ready for approval'
            : 'Add-ons dispute is not ready for approval',
      });
    }

    const expectedPartType = stage === 'delivery' ? 'main' : 'addon';

    const partResult = await client.query(
      `
      SELECT *
      FROM order_parts
      WHERE id = $1
        AND order_id = $2
        AND part_type = $3
      LIMIT 1
      FOR UPDATE
      `,
      [dispute.order_part_id, normalizedOrderId, expectedPartType],
    );

    const orderPart = partResult.rows[0];

    if (!orderPart) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error:
          stage === 'delivery'
            ? 'Main order part not found'
            : 'Add-on order part not found',
      });
    }

    if (String(orderPart.status) !== 'reviewing') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error:
          stage === 'delivery'
            ? 'Main delivery is not in buyer review'
            : 'Add-ons are not in buyer review',
      });
    }

    const approvedAt = new Date().toISOString();
    let shouldDeleteListingImages = false;

    await client.query(
      `
      UPDATE order_disputes
      SET
        status = 'resolved',
        resolution = $2,
        resolved_by = $3,
        resolved_at = $4,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        dispute.id,
        stage === 'delivery'
          ? 'buyer_approved_main_delivery'
          : 'buyer_approved_addons_delivery',
        userId,
        approvedAt,
      ],
    );

    await client.query(
      `
      UPDATE order_parts
      SET
        status = 'completed',
        completed_at = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [orderPart.id, approvedAt],
    );

    await createOrderEvent(client, {
      orderId: normalizedOrderId,
      orderPartId: orderPart.id,
      actorId: userId,
      type:
        stage === 'delivery'
          ? 'main_delivery_dispute_resolved'
          : 'addons_dispute_resolved',
      title: 'Dispute resolved',
      body:
        stage === 'delivery'
          ? 'The buyer approved the ZIP/repo delivery and resolved the dispute.'
          : 'The buyer approved the add-ons delivery and resolved the dispute.',
      metadata: {
        disputeId: dispute.id,
        openedStage: stage,
        resolvedAt: approvedAt,
        resolution:
          stage === 'delivery'
            ? 'buyer_approved_main_delivery'
            : 'buyer_approved_addons_delivery',
      },
    });

    if (stage === 'delivery') {
      const addonPartResult = await client.query(
        `
        SELECT *
        FROM order_parts
        WHERE order_id = $1
          AND part_type = 'addon'
        LIMIT 1
        FOR UPDATE
        `,
        [normalizedOrderId],
      );

      const addonPart = addonPartResult.rows[0] ?? null;

      const addonsResult = await client.query(
        `
        SELECT *
        FROM order_addons
        WHERE order_id = $1
        ORDER BY created_at ASC
        `,
        [normalizedOrderId],
      );

      const addons = addonsResult.rows;
      const hasAddons = Boolean(addonPart && addons.length > 0);

      if (!hasAddons) {
        const completionTransfer = await createCompletionTransfer({
          client,
          order,
          reason: 'disputed_main_delivery_approved',
        });

        await client.query(
          `
          UPDATE orders
          SET
            status = 'completed',
            seller_payout_cents = $3,
            stripe_transfer_id = $4,
            completed_at = $2,
            finalized_at = $2,
            updated_at = NOW()
          WHERE id = $1
          `,
          [
            normalizedOrderId,
            approvedAt,
            completionTransfer.sellerPayoutCents,
            completionTransfer.stripeTransferId,
          ],
        );

        await createOrderEvent(client, {
          orderId: normalizedOrderId,
          orderPartId: orderPart.id,
          actorId: userId,
          type: 'order_completed',
          title: 'Order completed',
          body: 'The order was completed after the buyer approved the disputed ZIP/repo delivery.',
          metadata: {
            completedAt: approvedAt,
            completedReason: 'disputed_main_delivery_approved',
          },
        });

        await notifyOrderFinalized({
          client,
          order,
          status: 'completed',
          reason: 'disputed_main_delivery_approved',
        });

        shouldDeleteListingImages = true;
      } else {
        const addonTotalDays = addons.reduce((sum, addon) => {
          const days = Number(addon.delivery_days);
          return sum + (Number.isFinite(days) && days > 0 ? days : 0);
        }, 0);

        if (addonTotalDays <= 0) {
          throw new Error('Failed to calculate add-on delivery deadline');
        }

        const addonSellerDeliveryDueAt = addDaysToIso({
          startsAt: approvedAt,
          days: addonTotalDays,
        });

        if (!addonSellerDeliveryDueAt) {
          throw new Error('Failed to calculate add-on delivery deadline');
        }

        await client.query(
          `
          UPDATE order_parts
          SET
            status = 'delivering',
            seller_delivery_due_at = $2,
            updated_at = NOW()
          WHERE id = $1
          `,
          [addonPart.id, addonSellerDeliveryDueAt],
        );

        await client.query(
          `
          UPDATE orders
          SET
            status = 'addons_in_progress',
            updated_at = NOW()
          WHERE id = $1
          `,
          [normalizedOrderId],
        );

        await createOrderEvent(client, {
          orderId: normalizedOrderId,
          orderPartId: addonPart.id,
          actorId: userId,
          type: 'addons_started',
          title: 'Add-ons started',
          body: 'The buyer approved the disputed ZIP/repo delivery, so selected add-ons are now in progress.',
          metadata: {
            addonCount: addons.length,
            sellerDeliveryDueAt: addonSellerDeliveryDueAt,
            startedReason: 'disputed_main_delivery_approved',
          },
        });
      }
    }

    if (stage === 'addons') {
      const completionTransfer = await createCompletionTransfer({
        client,
        order,
        reason: 'disputed_addons_delivery_approved',
      });

      await client.query(
        `
        UPDATE orders
        SET
          status = 'completed',
          seller_payout_cents = $3,
          stripe_transfer_id = $4,
          completed_at = $2,
          finalized_at = $2,
          updated_at = NOW()
        WHERE id = $1
        `,
        [
          normalizedOrderId,
          approvedAt,
          completionTransfer.sellerPayoutCents,
          completionTransfer.stripeTransferId,
        ],
      );

      await createOrderEvent(client, {
        orderId: normalizedOrderId,
        orderPartId: orderPart.id,
        actorId: userId,
        type: 'order_completed',
        title: 'Order completed',
        body: 'The order was completed after the buyer approved the disputed add-ons delivery.',
        metadata: {
          completedAt: approvedAt,
          completedReason: 'disputed_addons_delivery_approved',
        },
      });

      await notifyOrderFinalized({
        client,
        order,
        status: 'completed',
        reason: 'disputed_addons_delivery_approved',
      });

      shouldDeleteListingImages = true;
    }

    const payload = await getOrderPayloadForUser({
      client,
      orderId: normalizedOrderId,
      userId,
    });

    await client.query('COMMIT');
    transactionStarted = false;

    if (shouldDeleteListingImages) {
      await hardDeleteListingSafely({
        listingId: order.listing_id,
        context: 'order_completed_listing_delete',
      });
    }

    return res.json(payload);
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    console.error('Approve disputed delivery error:', error);
    return res.status(500).json({
      error: 'Failed to approve disputed delivery',
    });
  } finally {
    client.release();
  }
}

async function cancelExpiredOrderDelivery({
  client,
  order,
  orderPart,
  finalizedAt,
}) {
  const reason =
    String(orderPart.part_type) === 'addon'
      ? 'seller_addons_delivery_expired'
      : 'seller_main_delivery_expired';

  const refundResult = await createStripeItemRefundIfNeeded({
    order,
    amountCents: getRemainingItemRefundableCents(order),
    reason,
    idempotencyKey: `order-auto-cancel-${order.id}`,
  });

  await client.query(
    `
    UPDATE order_parts
    SET
      status = 'canceled',
      canceled_at = $2,
      updated_at = NOW()
    WHERE order_id = $1
      AND status <> 'completed'
    `,
    [order.id, finalizedAt],
  );

  await client.query(
    `
    UPDATE orders
    SET
      status = 'canceled',
      payment_status = CASE
        WHEN $4::integer > 0 THEN 'refunded'
        ELSE payment_status
      END,
      stripe_refund_id = COALESCE($5, stripe_refund_id),
      item_refunded_cents = item_refunded_cents + $4,
      total_refunded_cents = total_refunded_cents + $4,
      seller_fee_cents = 0,
      seller_payout_cents = 0,
      refunded_at = CASE
        WHEN $4::integer > 0 THEN $2
        ELSE refunded_at
      END,
      finalized_at = $2,
      finalized_reason = $3,
      canceled_at = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [
      order.id,
      finalizedAt,
      reason,
      refundResult.refundedCents,
      refundResult.refundId,
    ],
  );

  await restoreCanceledOrderListing({
    client,
    listingId: order.listing_id,
  });

  await createOrderEvent(client, {
    orderId: order.id,
    orderPartId: orderPart.id,
    actorId: null,
    type:
      String(orderPart.part_type) === 'addon'
        ? 'addons_delivery_auto_canceled'
        : 'main_delivery_auto_canceled',
    title: 'Order canceled automatically',
    body:
      String(orderPart.part_type) === 'addon'
        ? 'The order was canceled because the seller did not complete the add-ons before the deadline.'
        : 'The order was canceled because the seller did not submit the ZIP/repo delivery before the deadline.',
    metadata: {
      finalizedAt,
      finalizedReason: reason,
      expiredDueAt: orderPart.seller_delivery_due_at,
      orderPartId: orderPart.id,
      partType: orderPart.part_type,
    },
  });

  await notifyOrderFinalized({
    client,
    order,
    status: 'canceled',
    reason,
  });
}

async function completeExpiredMainReview({
  client,
  order,
  orderPart,
  finalizedAt,
}) {
  await client.query(
    `
    UPDATE order_parts
    SET
      status = 'completed',
      completed_at = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [orderPart.id, finalizedAt],
  );

  await createOrderEvent(client, {
    orderId: order.id,
    orderPartId: orderPart.id,
    actorId: null,
    type: 'main_review_auto_completed',
    title: 'Review auto-completed',
    body: 'The ZIP/repo delivery was automatically approved because the buyer review window expired.',
    metadata: {
      completedAt: finalizedAt,
      completedReason: 'buyer_main_review_expired',
      expiredDueAt: orderPart.buyer_review_due_at,
      orderPartId: orderPart.id,
    },
  });

  const addonPartResult = await client.query(
    `
    SELECT *
    FROM order_parts
    WHERE order_id = $1
      AND part_type = 'addon'
    LIMIT 1
    FOR UPDATE
    `,
    [order.id],
  );

  const addonPart = addonPartResult.rows[0] ?? null;

  const addonsResult = await client.query(
    `
    SELECT *
    FROM order_addons
    WHERE order_id = $1
    ORDER BY created_at ASC
    `,
    [order.id],
  );

  const addons = addonsResult.rows;
  const hasAddons = Boolean(addonPart && addons.length > 0);

  if (!hasAddons) {
    const completionTransfer = await createCompletionTransfer({
      client,
      order,
      reason: 'buyer_main_review_expired',
    });

    await client.query(
      `
      UPDATE orders
      SET
        status = 'completed',
        seller_payout_cents = $3,
        stripe_transfer_id = $4,
        completed_at = $2,
        finalized_at = $2,
        finalized_reason = 'buyer_main_review_expired',
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        order.id,
        finalizedAt,
        completionTransfer.sellerPayoutCents,
        completionTransfer.stripeTransferId,
      ],
    );

    await createOrderEvent(client, {
      orderId: order.id,
      orderPartId: orderPart.id,
      actorId: null,
      type: 'order_auto_completed',
      title: 'Order completed automatically',
      body: 'The order was completed because the buyer review window expired.',
      metadata: {
        completedAt: finalizedAt,
        completedReason: 'buyer_main_review_expired',
      },
    });

    await notifyOrderFinalized({
      client,
      order,
      status: 'completed',
      reason: 'buyer_main_review_expired',
    });

    return true;
  }

  const addonTotalDays = addons.reduce((sum, addon) => {
    const days = Number(addon.delivery_days);
    return sum + (Number.isFinite(days) && days > 0 ? days : 0);
  }, 0);

  if (addonTotalDays <= 0) {
    throw new Error('Failed to calculate add-on delivery deadline');
  }

  const addonSellerDeliveryDueAt = addDaysToIso({
    startsAt: finalizedAt,
    days: addonTotalDays,
  });

  if (!addonSellerDeliveryDueAt) {
    throw new Error('Failed to calculate add-on delivery deadline');
  }

  await client.query(
    `
    UPDATE order_parts
    SET
      status = 'delivering',
      seller_delivery_due_at = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [addonPart.id, addonSellerDeliveryDueAt],
  );

  await client.query(
    `
    UPDATE orders
    SET
      status = 'addons_in_progress',
      updated_at = NOW()
    WHERE id = $1
    `,
    [order.id],
  );

  await createOrderEvent(client, {
    orderId: order.id,
    orderPartId: addonPart.id,
    actorId: null,
    type: 'addons_started',
    title: 'Add-ons started',
    body: 'The buyer review window expired, so the ZIP/repo delivery was auto-approved and selected add-ons are now in progress.',
    metadata: {
      addonCount: addons.length,
      sellerDeliveryDueAt: addonSellerDeliveryDueAt,
      startedReason: 'buyer_main_review_expired',
    },
  });

  return false;
}

async function completeExpiredAddonReview({
  client,
  order,
  orderPart,
  finalizedAt,
}) {
  await client.query(
    `
    UPDATE order_parts
    SET
      status = 'completed',
      completed_at = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [orderPart.id, finalizedAt],
  );

  const completionTransfer = await createCompletionTransfer({
    client,
    order,
    reason: 'buyer_addons_review_expired',
  });

  await client.query(
    `
    UPDATE orders
    SET
      status = 'completed',
      seller_payout_cents = $3,
      stripe_transfer_id = $4,
      completed_at = $2,
      finalized_at = $2,
      finalized_reason = 'buyer_addons_review_expired',
      updated_at = NOW()
    WHERE id = $1
    `,
    [
      order.id,
      finalizedAt,
      completionTransfer.sellerPayoutCents,
      completionTransfer.stripeTransferId,
    ],
  );

  await createOrderEvent(client, {
    orderId: order.id,
    orderPartId: orderPart.id,
    actorId: null,
    type: 'addons_review_auto_completed',
    title: 'Add-ons review auto-completed',
    body: 'The selected add-ons were automatically approved because the buyer review window expired.',
    metadata: {
      completedAt: finalizedAt,
      completedReason: 'buyer_addons_review_expired',
      expiredDueAt: orderPart.buyer_review_due_at,
      orderPartId: orderPart.id,
    },
  });

  await createOrderEvent(client, {
    orderId: order.id,
    orderPartId: orderPart.id,
    actorId: null,
    type: 'order_auto_completed',
    title: 'Order completed automatically',
    body: 'The order was completed because the add-ons review window expired.',
    metadata: {
      completedAt: finalizedAt,
      completedReason: 'buyer_addons_review_expired',
    },
  });

  await notifyOrderFinalized({
    client,
    order,
    status: 'completed',
    reason: 'buyer_addons_review_expired',
  });

  return true;
}

async function processOrderDeadlineWarnings({ limit = 50 } = {}) {
  const client = await pool.connect();
  let processed = 0;

  try {
    await client.query('BEGIN');

    const sellerDeadlineResult = await client.query(
      `
      SELECT
        p.*,
        o.order_number,
        o.buyer_id,
        o.seller_id,
        o.status AS order_status,
        o.payment_status,
        o.finalized_at
      FROM order_parts p
      INNER JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'delivering'
        AND p.seller_delivery_due_at IS NOT NULL
        AND p.seller_delivery_due_at > NOW()
        AND p.seller_delivery_due_at <= NOW() + INTERVAL '10 hours'
        AND p.disputed_at IS NULL
        AND o.payment_status = 'paid'
        AND o.finalized_at IS NULL
        AND (
          (p.part_type = 'main' AND o.status = 'delivering')
          OR
          (p.part_type = 'addon' AND o.status = 'addons_in_progress')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM order_disputes d
          WHERE d.order_part_id = p.id
            AND d.status IN ('open', 'under_review', 'under review')
        )
      ORDER BY p.seller_delivery_due_at ASC
      LIMIT $1
      FOR UPDATE OF p SKIP LOCKED
      `,
      [limit],
    );

    for (const orderPart of sellerDeadlineResult.rows) {
      const order = {
        id: orderPart.order_id,
        order_number: orderPart.order_number,
        buyer_id: orderPart.buyer_id,
        seller_id: orderPart.seller_id,
      };

      const isAddon = String(orderPart.part_type) === 'addon';

      const sent = await sendDeadlineWarning({
        client,
        order,
        orderPart,
        userId: order.seller_id,
        target: 'seller_delivery_10h',
        title: isAddon
          ? '10 hours left to complete add-ons'
          : '10 hours left to deliver ZIP/repo',
        body: isAddon
          ? `You have 10 hours left to complete the add-ons for order ${getOrderLabel(order)}.`
          : `You have 10 hours left to deliver the ZIP/repo for order ${getOrderLabel(order)}.`,
      });

      if (sent) processed += 1;
    }

    const remainingLimit = Math.max(0, limit - processed);

    if (remainingLimit > 0) {
      const buyerDeadlineResult = await client.query(
        `
        SELECT
          p.*,
          o.order_number,
          o.buyer_id,
          o.seller_id,
          o.status AS order_status,
          o.payment_status,
          o.finalized_at
        FROM order_parts p
        INNER JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'reviewing'
          AND p.buyer_review_due_at IS NOT NULL
          AND p.buyer_review_due_at > NOW()
          AND p.buyer_review_due_at <= NOW() + INTERVAL '10 hours'
          AND p.disputed_at IS NULL
          AND o.payment_status = 'paid'
          AND o.finalized_at IS NULL
          AND (
            (p.part_type = 'main' AND o.status = 'delivered')
            OR
            (p.part_type = 'addon' AND o.status = 'addons_waiting_approval')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM order_disputes d
            WHERE d.order_part_id = p.id
              AND d.status IN ('open', 'under_review', 'under review')
          )
        ORDER BY p.buyer_review_due_at ASC
        LIMIT $1
        FOR UPDATE OF p SKIP LOCKED
        `,
        [remainingLimit],
      );

      for (const orderPart of buyerDeadlineResult.rows) {
        const order = {
          id: orderPart.order_id,
          order_number: orderPart.order_number,
          buyer_id: orderPart.buyer_id,
          seller_id: orderPart.seller_id,
        };

        const isAddon = String(orderPart.part_type) === 'addon';

        const sent = await sendDeadlineWarning({
          client,
          order,
          orderPart,
          userId: order.buyer_id,
          target: 'buyer_review_10h',
          title: isAddon
            ? '10 hours left to review add-ons'
            : '10 hours left to review ZIP/repo',
          body: isAddon
            ? `You have 10 hours left to review the add-ons for order ${getOrderLabel(order)}.`
            : `You have 10 hours left to review the ZIP/repo delivery for order ${getOrderLabel(order)}.`,
        });

        if (sent) processed += 1;
      }
    }

    await client.query('COMMIT');
    return processed;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }

    throw error;
  } finally {
    client.release();
  }
}

async function processExpiredSellerDeliveryWindows({ limit = 25 } = {}) {
  const client = await pool.connect();
  let processed = 0;

  try {
    await client.query('BEGIN');

    const expiredResult = await client.query(
      `
      SELECT
        p.*,
        o.order_number,
        o.status AS order_status,
        o.payment_status,
        o.finalized_at,
        o.buyer_id,
        o.seller_id,
        o.listing_id,
        o.base_price_cents,
        o.addons_total_cents,
        o.item_refunded_cents,
        o.total_refunded_cents,
        o.seller_fee_cents,
        o.stripe_payment_intent_id,
        o.stripe_charge_id,
        o.stripe_refund_id
      FROM order_parts p
      INNER JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'delivering'
        AND p.seller_delivery_due_at IS NOT NULL
        AND p.seller_delivery_due_at <= NOW()
        AND p.disputed_at IS NULL
        AND o.payment_status = 'paid'
        AND o.finalized_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM order_disputes d
          WHERE d.order_part_id = p.id
            AND d.status IN ('open', 'under_review', 'under review')
        )
        AND (
          (p.part_type = 'main' AND o.status = 'delivering')
          OR
          (p.part_type = 'addon' AND o.status = 'addons_in_progress')
        )
      ORDER BY p.seller_delivery_due_at ASC
      LIMIT $1
      FOR UPDATE OF p SKIP LOCKED
      `,
      [limit],
    );

    for (const orderPart of expiredResult.rows) {
      const order = {
        id: orderPart.order_id,
        order_number: orderPart.order_number,
        status: orderPart.order_status,
        payment_status: orderPart.payment_status,
        finalized_at: orderPart.finalized_at,
        buyer_id: orderPart.buyer_id,
        seller_id: orderPart.seller_id,
        listing_id: orderPart.listing_id,
        base_price_cents: orderPart.base_price_cents,
        addons_total_cents: orderPart.addons_total_cents,
        item_refunded_cents: orderPart.item_refunded_cents,
        total_refunded_cents: orderPart.total_refunded_cents,
        seller_fee_cents: orderPart.seller_fee_cents,
        stripe_payment_intent_id: orderPart.stripe_payment_intent_id,
        stripe_charge_id: orderPart.stripe_charge_id,
        stripe_refund_id: orderPart.stripe_refund_id,
      };

      const finalizedAt = new Date().toISOString();

      await cancelExpiredOrderDelivery({
        client,
        order,
        orderPart,
        finalizedAt,
      });

      processed += 1;
    }

    await client.query('COMMIT');

    return processed;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }

    throw error;
  } finally {
    client.release();
  }
}

async function processExpiredBuyerReviewWindows({ limit = 25 } = {}) {
  const client = await pool.connect();
  let processed = 0;

  const completedListingIds = new Set();

  try {
    await client.query('BEGIN');

    const expiredResult = await client.query(
      `
      SELECT
        p.*,
        o.order_number,
        o.status AS order_status,
        o.payment_status,
        o.finalized_at,
        o.buyer_id,
        o.seller_id,
        o.listing_id,
        o.base_price_cents,
        o.addons_total_cents,
        o.item_refunded_cents,
        o.seller_fee_cents,
        o.currency,
        o.stripe_transfer_id,
        o.stripe_charge_id
      FROM order_parts p
      INNER JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'reviewing'
        AND p.buyer_review_due_at IS NOT NULL
        AND p.buyer_review_due_at <= NOW()
        AND p.disputed_at IS NULL
        AND o.payment_status = 'paid'
        AND o.finalized_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM order_disputes d
          WHERE d.order_part_id = p.id
            AND d.status IN ('open', 'under_review', 'under review')
        )
        AND (
          (p.part_type = 'main' AND o.status = 'delivered')
          OR
          (p.part_type = 'addon' AND o.status = 'addons_waiting_approval')
        )
      ORDER BY p.buyer_review_due_at ASC
      LIMIT $1
      FOR UPDATE OF p SKIP LOCKED
      `,
      [limit],
    );

    for (const orderPart of expiredResult.rows) {
      const order = {
        id: orderPart.order_id,
        order_number: orderPart.order_number,
        status: orderPart.order_status,
        payment_status: orderPart.payment_status,
        finalized_at: orderPart.finalized_at,
        buyer_id: orderPart.buyer_id,
        seller_id: orderPart.seller_id,
        listing_id: orderPart.listing_id,
        base_price_cents: orderPart.base_price_cents,
        addons_total_cents: orderPart.addons_total_cents,
        item_refunded_cents: orderPart.item_refunded_cents,
        seller_fee_cents: orderPart.seller_fee_cents,
        currency: orderPart.currency,
        stripe_transfer_id: orderPart.stripe_transfer_id,
        stripe_charge_id: orderPart.stripe_charge_id,
      };

      const finalizedAt = new Date().toISOString();

      if (String(orderPart.part_type) === 'main') {
        const completed = await completeExpiredMainReview({
          client,
          order,
          orderPart,
          finalizedAt,
        });

        if (completed) {
          completedListingIds.add(order.listing_id);
        }
      }

      if (String(orderPart.part_type) === 'addon') {
        const completed = await completeExpiredAddonReview({
          client,
          order,
          orderPart,
          finalizedAt,
        });

        if (completed) {
          completedListingIds.add(order.listing_id);
        }
      }

      processed += 1;
    }

    await client.query('COMMIT');

    for (const listingId of completedListingIds) {
      await hardDeleteListingSafely({
        listingId,
        context: 'order_auto_completed_listing_delete',
      });
    }

    return processed;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }

    throw error;
  } finally {
    client.release();
  }
}

async function processExpiredOrderWindows() {
  const deadlineWarningsProcessed = await processOrderDeadlineWarnings();
  const sellerDeliveryProcessed = await processExpiredSellerDeliveryWindows();
  const buyerReviewProcessed = await processExpiredBuyerReviewWindows();

  return {
    deadlineWarningsProcessed,
    sellerDeliveryProcessed,
    buyerReviewProcessed,
    totalProcessed:
      deadlineWarningsProcessed +
      sellerDeliveryProcessed +
      buyerReviewProcessed,
  };
}

async function createPaymentIntent(req, res) {
  try {
    const buyerId = req.user.id;
    const { listingId, addonIds } = req.body ?? {};

    const normalizedListingId = normalizeUuid(listingId);

    if (!isUuid(normalizedListingId)) {
      return res.status(400).json({ error: 'Invalid listingId' });
    }

    const selectedAddonIds = Array.isArray(addonIds)
      ? addonIds.map(normalizeUuid).filter(Boolean)
      : [];

    if (selectedAddonIds.some((id) => !isUuid(id))) {
      return res.status(400).json({ error: 'Invalid addonIds' });
    }

    const uniqueAddonIds = Array.from(new Set(selectedAddonIds));

    const listingResult = await pool.query(
      `
      SELECT
        l.id,
        l.seller_id,
        l.title,
        l.listing_type,
        l.delivery_method,
        l.base_price_cents,
        l.status,
        u.stripe_account_id,
        u.stripe_onboarding_complete,
        u.stripe_charges_enabled,
        u.stripe_payouts_enabled,
        u.first_sale_free_rank,
        u.first_sale_free_used_at
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      WHERE l.id = $1
      LIMIT 1
      `,
      [normalizedListingId],
    );

    const listing = listingResult.rows[0];

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (String(listing.status) !== 'published') {
      return res.status(400).json({ error: 'Listing is not available' });
    }

    if (String(listing.seller_id) === String(buyerId)) {
      return res.status(403).json({ error: 'Cannot buy your own listing' });
    }

    if (
      !listing.stripe_account_id ||
      listing.stripe_onboarding_complete !== true ||
      listing.stripe_charges_enabled !== true ||
      listing.stripe_payouts_enabled !== true
    ) {
      return res
        .status(400)
        .json({ error: 'Seller is not ready to receive payments' });
    }

    let selectedAddons = [];

    if (uniqueAddonIds.length > 0) {
      const addonsResult = await pool.query(
        `
        SELECT
          id,
          title,
          price_cents,
          delivery_days
        FROM listing_addons
        WHERE listing_id = $1
          AND id = ANY($2::uuid[])
        `,
        [normalizedListingId, uniqueAddonIds],
      );

      selectedAddons = addonsResult.rows.map((addon) => ({
        ...addon,
        price_cents: roundUpToWholeDollarCents(addon.price_cents),
      }));

      if (selectedAddons.length !== uniqueAddonIds.length) {
        return res.status(400).json({ error: 'Invalid addonIds for listing' });
      }
    }

    const sellerFirstSaleUseResult = await pool.query(
      `
      SELECT id
      FROM orders
      WHERE seller_id = $1
        AND payment_status = 'paid'
      LIMIT 1
      `,
      [listing.seller_id],
    );

    const activeWaivedAttemptResult = await pool.query(
      `
      SELECT id
      FROM order_payment_attempts
      WHERE seller_id = $1
        AND status IN ('requires_payment', 'processing')
        AND pricing_snapshot->>'seller_fee_waived_reason' = 'first_sale_free'
        AND created_at > NOW() - INTERVAL '30 minutes'
      LIMIT 1
      `,
      [listing.seller_id],
    );

    const sellerFeeWaived =
      isFirstSaleFreeEligibleSeller(listing) &&
      sellerFirstSaleUseResult.rows.length === 0 &&
      activeWaivedAttemptResult.rows.length === 0;

    const pricing = calculateOrderPricing({
      basePriceCents: listing.base_price_cents,
      addons: selectedAddons,
      sellerFeeWaived,
    });

    if (pricing.total_paid_cents <= 0) {
      return res.status(400).json({ error: 'Invalid payment amount' });
    }

    const selectedAddonsSnapshot = selectedAddons.map((addon) => ({
      id: addon.id,
      title: addon.title,
      price_cents: roundUpToWholeDollarCents(addon.price_cents),
      delivery_days: addon.delivery_days,
    }));

    const pricingSnapshot = {
      base_price_cents: pricing.base_price_cents,
      addons_total_cents: pricing.addons_total_cents,
      buyer_fee_cents: pricing.buyer_fee_cents,
      seller_fee_cents: pricing.seller_fee_cents,
      standard_seller_fee_cents: pricing.standard_seller_fee_cents,
      seller_fee_waived: pricing.seller_fee_waived,
      seller_fee_waived_reason: pricing.seller_fee_waived_reason,
      total_paid_cents: pricing.total_paid_cents,
      seller_payout_cents: pricing.seller_payout_cents,
      currency: pricing.currency,
      fees_refundable: pricing.fees_refundable,
    };

    const listingSnapshot = {
      id: listing.id,
      seller_id: listing.seller_id,
      title: listing.title,
      listing_type: listing.listing_type,
      delivery_method: listing.delivery_method,
      base_price_cents: listing.base_price_cents,
      stripe_account_id: listing.stripe_account_id,
    };

    const paymentIntent = await stripe.paymentIntents.create({
      amount: pricing.total_paid_cents,
      currency: pricing.currency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        buyer_id: String(buyerId),
        seller_id: String(listing.seller_id),
        listing_id: String(listing.id),
        buyer_fee_cents: String(pricing.buyer_fee_cents),
        seller_fee_cents: String(pricing.seller_fee_cents),
      },
    });

    await pool.query(
      `
      INSERT INTO order_payment_attempts (
        stripe_payment_intent_id,
        stripe_payment_intent_client_secret,
        buyer_id,
        seller_id,
        listing_id,
        selected_addons,
        pricing_snapshot,
        listing_snapshot,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        paymentIntent.id,
        paymentIntent.client_secret,
        buyerId,
        listing.seller_id,
        listing.id,
        JSON.stringify(selectedAddonsSnapshot),
        JSON.stringify(pricingSnapshot),
        JSON.stringify(listingSnapshot),
        'requires_payment',
      ],
    );

    return res.status(201).json({
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Create payment intent error:', error);
    return res.status(500).json({ error: 'Failed to create payment intent' });
  }
}

async function getPaymentIntentOrderStatus(req, res) {
  try {
    const userId = req.user.id;
    const { paymentIntentId } = req.params;

    if (!paymentIntentId || !String(paymentIntentId).startsWith('pi_')) {
      return res.status(400).json({ error: 'Invalid paymentIntentId' });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        status,
        order_id,
        stripe_payment_intent_id
      FROM order_payment_attempts
      WHERE stripe_payment_intent_id = $1
        AND buyer_id = $2
      LIMIT 1
      `,
      [paymentIntentId, userId],
    );

    const attempt = result.rows[0];

    if (!attempt) {
      return res.status(404).json({ error: 'Payment attempt not found' });
    }

    return res.json({
      paymentAttemptId: attempt.id,
      paymentIntentId: attempt.stripe_payment_intent_id,
      status: attempt.status,
      orderId: attempt.order_id,
    });
  } catch (error) {
    console.error('Get payment intent order status error:', error);
    return res.status(500).json({ error: 'Failed to load payment status' });
  }
}

async function createOrderAfterPaymentSuccess({
  stripePaymentIntentId,
  stripeChargeId = null,
}) {
  const client = await pool.connect();
  let transactionStarted = false;
  let refundPaymentIntentId = null;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    const attemptResult = await client.query(
      `
      SELECT *
      FROM order_payment_attempts
      WHERE stripe_payment_intent_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [stripePaymentIntentId],
    );

    const attempt = attemptResult.rows[0];

    if (!attempt) {
      await client.query('COMMIT');
      transactionStarted = false;
      return { created: false, reason: 'payment_attempt_not_found' };
    }

    if (attempt.order_id) {
      await client.query('COMMIT');
      transactionStarted = false;
      return {
        created: false,
        reason: 'order_already_created',
        orderId: attempt.order_id,
      };
    }

    if (attempt.status === 'paid') {
      await client.query('COMMIT');
      transactionStarted = false;
      return { created: false, reason: 'payment_attempt_already_paid' };
    }

    if (attempt.status === 'canceled') {
      await client.query('COMMIT');
      transactionStarted = false;
      return { created: false, reason: 'payment_attempt_canceled' };
    }

    const listingResult = await client.query(
      `
      SELECT id, status
      FROM listings
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [attempt.listing_id],
    );

    const listing = listingResult.rows[0];

    if (!listing || String(listing.status) !== 'published') {
      await client.query(
        `
        UPDATE order_payment_attempts
        SET
          status = 'failed',
          failed_at = NOW()
        WHERE id = $1
        `,
        [attempt.id],
      );

      refundPaymentIntentId = stripePaymentIntentId;

      await client.query('COMMIT');
      transactionStarted = false;

      return {
        created: false,
        reason: 'listing_no_longer_available',
        refundPaymentIntentId,
      };
    }

    const selectedAddons = getSafeJsonArray(attempt.selected_addons);
    const pricing = getSafeJsonObject(attempt.pricing_snapshot);
    const listingSnapshot = getSafeJsonObject(attempt.listing_snapshot);

    let createdOrder = null;

    for (let attemptNumber = 0; attemptNumber < 5; attemptNumber++) {
      const orderNumber = generateOrderNumber();

      if (!isEightDigitOrderNumber(orderNumber)) {
        throw new Error('Generated order number must be exactly 8 digits.');
      }

      try {
        const orderResult = await client.query(
          `
          INSERT INTO orders (
            order_number,
            buyer_id,
            seller_id,
            listing_id,
            listing_title,
            listing_type,
            delivery_method,
            base_price_cents,
            addons_total_cents,
            buyer_fee_cents,
            seller_fee_cents,
            standard_seller_fee_cents,
            seller_fee_waived,
            seller_fee_waived_reason,
            total_paid_cents,
            seller_payout_cents,
            currency,
            fees_refundable,
            status,
            payment_status,
            stripe_payment_intent_id,
            stripe_charge_id
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
          )
          RETURNING *
          `,
          [
            orderNumber,
            attempt.buyer_id,
            attempt.seller_id,
            attempt.listing_id,
            listingSnapshot.title,
            listingSnapshot.listing_type,
            listingSnapshot.delivery_method,
            pricing.base_price_cents,
            pricing.addons_total_cents,
            pricing.buyer_fee_cents,
            pricing.seller_fee_cents,
            pricing.standard_seller_fee_cents,
            pricing.seller_fee_waived === true,
            pricing.seller_fee_waived_reason || null,
            pricing.total_paid_cents,
            0,
            pricing.currency,
            pricing.fees_refundable,
            'delivering',
            'paid',
            stripePaymentIntentId,
            stripeChargeId,
          ],
        );

        createdOrder = orderResult.rows[0];
        break;
      } catch (error) {
        const canRetry =
          error &&
          error.code === '23505' &&
          error.constraint === 'orders_order_number_key';

        if (canRetry) {
          continue;
        }

        if (
          error &&
          error.code === '23505' &&
          error.constraint === 'orders_one_order_per_listing_idx'
        ) {
          await client.query(
            `
            UPDATE order_payment_attempts
            SET
              status = 'failed',
              failed_at = NOW()
            WHERE id = $1
            `,
            [attempt.id],
          );

          refundPaymentIntentId = stripePaymentIntentId;

          await client.query('COMMIT');
          transactionStarted = false;

          return {
            created: false,
            reason: 'listing_already_sold',
            refundPaymentIntentId,
          };
        }

        throw error;
      }
    }

    if (!createdOrder) {
      throw new Error('Failed to generate unique order number');
    }

    const orderId = createdOrder.id;

    if (pricing.seller_fee_waived_reason === 'first_sale_free') {
      const firstSaleFreeResult = await client.query(
        `
        UPDATE users
        SET
          first_sale_free_used_at = NOW(),
          first_sale_free_used_order_id = $2
        WHERE id = $1
          AND first_sale_free_rank BETWEEN 1 AND 10
          AND first_sale_free_used_at IS NULL
        RETURNING id
        `,
        [attempt.seller_id, orderId],
      );

      if (firstSaleFreeResult.rowCount !== 1) {
        throw new Error('Failed to mark first sale free benefit as used');
      }
    }

    const createdAt = createdOrder.created_at || new Date().toISOString();

    const mainSellerDeliveryDueAt = getMainSellerDeliveryDueAt({
      startsAt: createdAt,
    });

    if (!mainSellerDeliveryDueAt) {
      throw new Error('Failed to calculate main seller delivery deadline');
    }

    const mainPartResult = await client.query(
      `
      INSERT INTO order_parts (
        order_id,
        part_type,
        status,
        seller_delivery_due_at
      ) VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [orderId, 'main', 'delivering', mainSellerDeliveryDueAt],
    );

    const mainPart = mainPartResult.rows[0];

    let addonPart = null;

    if (selectedAddons.length > 0) {
      const addonPartResult = await client.query(
        `
        INSERT INTO order_parts (
          order_id,
          part_type,
          status,
          seller_delivery_due_at
        ) VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [orderId, 'addon', 'pending', null],
      );

      addonPart = addonPartResult.rows[0];

      for (const addon of selectedAddons) {
        await client.query(
          `
          INSERT INTO order_addons (
            order_id,
            order_part_id,
            listing_addon_id,
            title,
            price_cents,
            delivery_days
          ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            orderId,
            addonPart.id,
            addon.id,
            addon.title,
            addon.price_cents,
            addon.delivery_days,
          ],
        );
      }
    }

    const soldListingResult = await client.query(
      `
      UPDATE listings
      SET
        status = 'sold',
        sold_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND status = 'published'
      RETURNING id
      `,
      [attempt.listing_id],
    );

    if (soldListingResult.rowCount !== 1) {
      throw new Error('Failed to mark listing as sold');
    }

    await createOrderEvent(client, {
      orderId,
      actorId: attempt.buyer_id,
      type: 'order_created',
      title: 'Order created',
      body: 'Order was created after successful payment.',
      metadata: {
        orderNumber: createdOrder.order_number,
      },
    });

    await createOrderEvent(client, {
      orderId,
      actorId: attempt.buyer_id,
      type: 'payment_succeeded',
      title: 'Payment succeeded',
      body: 'Payment was completed successfully.',
      metadata: {
        paymentStatus: 'paid',
        totalPaidCents: createdOrder.total_paid_cents,
        currency: createdOrder.currency,
      },
    });

    await createOrderEvent(client, {
      orderId,
      orderPartId: mainPart.id,
      actorId: attempt.buyer_id,
      type: 'main_delivery_started',
      title: 'ZIP/repo delivery started',
      body: 'The seller can now deliver the ZIP/repo.',
      metadata: {
        sellerDeliveryDueAt: mainPart.seller_delivery_due_at,
      },
    });

    await notifyOrderCreated({
      client,
      order: createdOrder,
    });

    if (addonPart) {
      await createOrderEvent(client, {
        orderId,
        orderPartId: addonPart.id,
        actorId: attempt.buyer_id,
        type: 'addon_pending',
        title: 'Add-ons waiting',
        body: 'Add-on work will start after the ZIP/repo part is completed.',
        metadata: {
          selectedAddonCount: selectedAddons.length,
        },
      });
    }

    await client.query(
      `
      UPDATE order_payment_attempts
      SET
        status = 'paid',
        order_id = $2,
        paid_at = NOW()
      WHERE id = $1
      `,
      [attempt.id, orderId],
    );

    await client.query('COMMIT');
    transactionStarted = false;

    return { created: true, orderId };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function refundUnavailablePayment(paymentIntentId) {
  if (!paymentIntentId) return;

  try {
    await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer',
    });
  } catch (error) {
    console.error('Refund unavailable payment error:', error);
  }
}

async function handleStripeWebhook(req, res) {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    return res.status(500).json({ error: 'Stripe webhook is not configured' });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature error:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'payment_intent.processing') {
      const paymentIntent = event.data.object;

      await pool.query(
        `
        UPDATE order_payment_attempts
        SET status = 'processing'
        WHERE stripe_payment_intent_id = $1
          AND status = 'requires_payment'
        `,
        [paymentIntent.id],
      );
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;

      await pool.query(
        `
        UPDATE order_payment_attempts
        SET
          status = 'failed',
          failed_at = NOW()
        WHERE stripe_payment_intent_id = $1
          AND status <> 'paid'
        `,
        [paymentIntent.id],
      );
    }

    if (event.type === 'payment_intent.canceled') {
      const paymentIntent = event.data.object;

      await pool.query(
        `
        UPDATE order_payment_attempts
        SET
          status = 'canceled',
          canceled_at = NOW()
        WHERE stripe_payment_intent_id = $1
          AND status <> 'paid'
        `,
        [paymentIntent.id],
      );
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const latestCharge =
        typeof paymentIntent.latest_charge === 'string'
          ? paymentIntent.latest_charge
          : paymentIntent.latest_charge?.id || null;

      const result = await createOrderAfterPaymentSuccess({
        stripePaymentIntentId: paymentIntent.id,
        stripeChargeId: latestCharge,
      });

      if (result.refundPaymentIntentId) {
        await refundUnavailablePayment(result.refundPaymentIntentId);
      }
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handling error:', error);
    return res.status(500).json({ error: 'Webhook handling failed' });
  }
}

module.exports = {
  getBuyerOrders,
  getSellerOrders,
  getOrderById,
  submitOrderDelivery,
  approveMainDelivery,
  completeAddonsDelivery,
  approveAddonsDelivery,
  approveDisputedDelivery,
  openOrderDispute,
  replyToOrderDispute,
  extendOrderTime,
  downloadOrderDisputeAttachment,
  downloadOrderReceipt,
  downloadOrderDeliveryZip,
  createPaymentIntent,
  getPaymentIntentOrderStatus,
  handleStripeWebhook,
  processExpiredOrderWindows,
};
