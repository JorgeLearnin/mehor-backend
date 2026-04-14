'use strict';

const { db } = require('../db/db');
const crypto = require('crypto');
const Stripe = require('stripe');
const http = require('http');
const https = require('https');
const {
  uploadOrderDeliveryZipBuffer,
  createSignedRawUploadParams,
  renameRawResource,
  deleteRawResourceByPublicId,
} = require('../utils/cloudinary');
const { createNotification } = require('./notifications.controller');
const { deleteCloudinaryResourcesByPrefix } = require('../utils/cloudinary');
const {
  safeJsonParse,
  toInt,
  computeOrderTotals,
  generateUniqueOrderNumber,
  completeExpiredReviewOrders,
} = require('../utils/order');
const {
  computeFeeUsd,
  getSellerPlatformFeeBps,
  getBuyerServiceFeeBps,
} = require('../utils/fees');

const { scanUrlWithClamAV, scanBufferWithClamAV } = require('../utils/clamav');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

function newId(prefix = '') {
  const p = String(prefix || '').trim();
  try {
    const id = crypto.randomUUID();
    return p ? `${p}_${id}` : id;
  } catch {
    const id = crypto.randomBytes(16).toString('hex');
    return p ? `${p}_${id}` : id;
  }
}

function toMoreTimeStageKey(input) {
  const v = String(input || '')
    .trim()
    .toLowerCase();
  if (
    v === 'delivery' ||
    v === 'review' ||
    v === 'addons' ||
    v === 'addons_review'
  ) {
    return v;
  }
  return null;
}

function toMoreTimeRequestStatus(input) {
  const v = String(input || '')
    .trim()
    .toLowerCase();
  if (
    v === 'applied' ||
    v === 'pending' ||
    v === 'approved' ||
    v === 'declined'
  ) {
    return v;
  }
  return null;
}

function getMoreTimeApproverRole(stage) {
  const s = toMoreTimeStageKey(stage);
  if (!s) return null;
  // Delivery + add-ons extensions are approved by the buyer.
  // Review extensions are approved by the seller.
  return s === 'review' || s === 'addons_review' ? 'seller' : 'buyer';
}

function getMoreTimeRequesterRole(stage) {
  const s = toMoreTimeStageKey(stage);
  if (!s) return null;
  return s === 'review' || s === 'addons_review' ? 'buyer' : 'seller';
}

const DELIVERY_REVIEW_WINDOW_HOURS = 48;
const ADDONS_REVIEW_WINDOW_HOURS = 48;

function computeFullRefundAmounts(row) {
  const listingPriceUsd = Math.max(0, Number(row?.listingPriceUsd ?? 0));
  const addOnsTotalUsd = Math.max(0, Number(row?.addOnsTotalUsd ?? 0));
  const subtotalUsd = listingPriceUsd + addOnsTotalUsd;
  return {
    refundedSubtotalUsd: subtotalUsd,
    refundedUsd: subtotalUsd,
  };
}

function listMoreTimeRequests(orderId) {
  const oid = String(orderId || '').trim();
  if (!oid) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id,
                stage,
                requester_id AS requesterId,
                requester_role AS requesterRole,
                hours,
                status,
                created_at AS createdAt,
                decided_at AS decidedAt,
                decided_by_id AS decidedById,
                decided_by_role AS decidedByRole,
                applied_at AS appliedAt,
                deadline_before_iso AS deadlineBeforeIso,
                deadline_after_iso AS deadlineAfterIso
           FROM order_more_time_requests
          WHERE order_id = ?
          ORDER BY created_at ASC`,
      )
      .all(oid);

    return Array.isArray(rows)
      ? rows.map((r) => ({
          id: r.id,
          stage: r.stage,
          requesterId: r.requesterId,
          requesterRole: r.requesterRole,
          hours: r.hours,
          status: r.status,
          createdAt: r.createdAt,
          decidedAt: r.decidedAt ?? null,
          decidedById: r.decidedById ?? null,
          decidedByRole: r.decidedByRole ?? null,
          appliedAt: r.appliedAt ?? null,
          deadlineBeforeIso: r.deadlineBeforeIso ?? null,
          deadlineAfterIso: r.deadlineAfterIso ?? null,
        }))
      : [];
  } catch {
    return [];
  }
}

function formatUsd(usdInt) {
  const n = Number(usdInt);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function toSafePdfFilename(filename, fallback = 'receipt.pdf') {
  const raw = String(filename || '').trim();
  const base = raw
    ? raw.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200)
    : fallback;
  const withExt = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
  return withExt || fallback;
}

function getReceiptLogoSvgString() {
  // Use the existing favicon as the receipt logo.
  // Path is resolved from backend/src/controllers -> repo root -> website/public/favicon.svg
  const svgPath = path.resolve(
    __dirname,
    '../../..',
    'website',
    'public',
    'favicon.svg',
  );
  try {
    if (!fs.existsSync(svgPath)) return null;
    return fs.readFileSync(svgPath, 'utf8');
  } catch {
    return null;
  }
}

function isClamScanUnavailable(err) {
  const code = String(err?.code || '').trim();
  return code === 'CLAMAV_NOT_AVAILABLE' || code === 'CLAMAV_ERROR';
}

function toScanErrorMessage(err) {
  const code = String(err?.code || '').trim();
  if (code === 'TOO_LARGE') return 'ZIP is too large to scan';
  if (code === 'DOWNLOAD_TIMEOUT') return 'ZIP scan timed out';
  if (code === 'DOWNLOAD_FAILED') return 'Could not download ZIP for scanning';
  if (code === 'INVALID_URL') return 'Invalid ZIP URL';
  if (isClamScanUnavailable(err))
    return 'Virus scanning is temporarily unavailable';
  return 'ZIP scan failed';
}

function shouldBlockDeliveryForScanError(err) {
  // "Not strict": block only on confirmed infection.
  // Any scanner error/unavailability/timeout is treated as non-blocking.
  // (We still log it in markDelivered.)
  return false;
}

async function refundStripePaymentIntentBestEffort({
  paymentIntentId,
  amountUsd,
}) {
  const id = String(paymentIntentId || '').trim();
  if (!id)
    return { ok: false, skipped: true, reason: 'missing_payment_intent' };

  const refundAmountUsd = Math.max(0, Number(amountUsd ?? 0));
  if (refundAmountUsd <= 0) {
    return { ok: false, skipped: true, reason: 'missing_refund_amount' };
  }

  let stripe;
  try {
    stripe = getStripe();
  } catch (e) {
    return { ok: false, skipped: true, reason: 'stripe_not_configured' };
  }

  // Best-effort: if this was a Connect destination charge, attempt to reverse
  // transfer + refund application fee. If Stripe rejects params, retry.
  try {
    const r = await stripe.refunds.create({
      payment_intent: id,
      amount: toCentsUsd(refundAmountUsd),
      reason: 'requested_by_customer',
      reverse_transfer: true,
    });
    return { ok: true, refundId: r?.id || null };
  } catch (e) {
    try {
      const r = await stripe.refunds.create({
        payment_intent: id,
        amount: toCentsUsd(refundAmountUsd),
        reason: 'requested_by_customer',
      });
      return { ok: true, refundId: r?.id || null };
    } catch (e2) {
      return {
        ok: false,
        error: e2 instanceof Error ? e2.message : 'refund_failed',
      };
    }
  }
}

async function cancelOverduePaidOrdersAndRefund({ nowIso, limit = 25 } = {}) {
  const now = String(nowIso || new Date().toISOString()).trim();
  const max = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(100, Number(limit)))
    : 25;

  const rows = db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.listing_id AS listingId,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.total_usd AS totalUsd,
              o.stripe_payment_intent_id AS stripePaymentIntentId,
              l.title AS listingTitle
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.status = 'paid'
          AND o.delivered_at IS NULL
          AND o.delivery_due_at IS NOT NULL
          AND o.delivery_due_at <= ?
          AND COALESCE(o.refunded_usd, 0) = 0
          AND o.dispute_opened_at IS NULL
        ORDER BY o.delivery_due_at ASC
        LIMIT ?`,
    )
    .all(now, max);

  if (!rows?.length) return { canceledCount: 0 };

  let canceledCount = 0;
  for (const r of rows) {
    const orderId = String(r.id || '').trim();
    if (!orderId) continue;

    const { refundedSubtotalUsd, refundedUsd } = computeFullRefundAmounts(r);

    const refund = await refundStripePaymentIntentBestEffort({
      paymentIntentId: r.stripePaymentIntentId,
      amountUsd: refundedSubtotalUsd,
    });

    if (!refund.ok && !refund.skipped) {
      // Don't change DB status if we couldn't refund.
      console.warn(
        'Auto-refund failed for overdue order:',
        orderId,
        refund.error,
      );
      continue;
    }

    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE orders
              SET status = 'canceled',
                  refunded_subtotal_usd = ?,
                  refunded_usd = ?,
                  finalized_reason = COALESCE(finalized_reason, 'seller_deadline_missed'),
                  finalized_at = COALESCE(finalized_at, ?),
                  updated_at = ?
            WHERE id = ?
              AND status = 'paid'
              AND delivered_at IS NULL
              AND COALESCE(refunded_usd, 0) = 0`,
        )
        .run(refundedSubtotalUsd, refundedUsd, now, now, orderId);

      if (Number(result?.changes ?? 0) <= 0) return false;

      // Make listing purchasable again.
      db.prepare(
        `UPDATE listings
            SET status = 'active', updated_at = ?
          WHERE id = ? AND status = 'in_progress'`,
      ).run(now, String(r.listingId));

      // Notifications (best-effort; these only create DB rows).
      const title = String(r.listingTitle || 'Listing');
      const orderNumber = r.orderNumber ? String(r.orderNumber) : null;

      createNotification({
        userId: String(r.buyerId),
        type: 'buyer.order_refunded',
        title: 'Order refunded',
        detail: `The seller missed the delivery deadline for “${title}”. You’ve been refunded.`,
        entityType: 'order',
        entityId: orderId,
        data: { orderId, orderNumber },
      });

      createNotification({
        userId: String(r.sellerId),
        type: 'seller.order_canceled',
        title: 'Order canceled',
        detail: `Delivery deadline missed for “${title}”. The buyer was refunded.`,
        entityType: 'order',
        entityId: orderId,
        data: { orderId, orderNumber },
      });

      return true;
    });

    try {
      const didCancel = tx();
      if (didCancel) canceledCount += 1;
    } catch (e) {
      console.warn('Auto-cancel transaction failed:', orderId, e);
    }
  }

  return { canceledCount };
}

async function cancelOverdueAddOnsOrdersAndRefund({ nowIso, limit = 25 } = {}) {
  const now = String(nowIso || new Date().toISOString()).trim();
  const max = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(100, Number(limit)))
    : 25;

  const rows = db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.listing_id AS listingId,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.total_usd AS totalUsd,
              o.stripe_payment_intent_id AS stripePaymentIntentId,
              l.title AS listingTitle
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.status = 'addons'
          AND o.addons_completed_at IS NULL
          AND o.addons_due_at IS NOT NULL
          AND o.addons_due_at <= ?
          AND COALESCE(o.refunded_usd, 0) = 0
          AND o.dispute_opened_at IS NULL
        ORDER BY o.addons_due_at ASC
        LIMIT ?`,
    )
    .all(now, max);

  if (!rows?.length) return { canceledCount: 0 };

  let canceledCount = 0;
  for (const r of rows) {
    const orderId = String(r.id || '').trim();
    if (!orderId) continue;

    const { refundedSubtotalUsd, refundedUsd } = computeFullRefundAmounts(r);

    const refund = await refundStripePaymentIntentBestEffort({
      paymentIntentId: r.stripePaymentIntentId,
      amountUsd: refundedSubtotalUsd,
    });

    if (!refund.ok && !refund.skipped) {
      console.warn(
        'Auto-refund failed for overdue add-ons order:',
        orderId,
        refund.error,
      );
      continue;
    }

    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE orders
              SET status = 'canceled',
                  refunded_subtotal_usd = ?,
                  refunded_usd = ?,
                  finalized_reason = COALESCE(finalized_reason, 'addons_deadline_missed'),
                  finalized_at = COALESCE(finalized_at, ?),
                  updated_at = ?
            WHERE id = ?
              AND status = 'addons'
              AND addons_completed_at IS NULL
              AND COALESCE(refunded_usd, 0) = 0`,
        )
        .run(refundedSubtotalUsd, refundedUsd, now, now, orderId);

      if (Number(result?.changes ?? 0) <= 0) return false;

      db.prepare(
        `UPDATE listings
            SET status = 'active', updated_at = ?
          WHERE id = ? AND status = 'in_progress'`,
      ).run(now, String(r.listingId));

      const title = String(r.listingTitle || 'Listing');
      const orderNumber = r.orderNumber ? String(r.orderNumber) : null;

      createNotification({
        userId: String(r.buyerId),
        type: 'buyer.order_refunded',
        title: 'Order refunded',
        detail: `The seller missed the add-ons completion deadline for “${title}”. You’ve been fully refunded.`,
        entityType: 'order',
        entityId: orderId,
        data: { orderId, orderNumber },
      });

      createNotification({
        userId: String(r.sellerId),
        type: 'seller.order_canceled',
        title: 'Order canceled',
        detail: `The add-ons completion deadline was missed for “${title}”. The buyer was fully refunded.`,
        entityType: 'order',
        entityId: orderId,
        data: { orderId, orderNumber },
      });

      return true;
    });

    try {
      const didCancel = tx();
      if (didCancel) canceledCount += 1;
    } catch (e) {
      console.warn('Auto-cancel add-ons transaction failed:', orderId, e);
    }
  }

  return { canceledCount };
}

function completeExpiredAddOnsReviewOrders({ nowIso } = {}) {
  const now = String(nowIso || new Date().toISOString()).trim();
  if (!now) return { completedCount: 0 };

  const due = db
    .prepare(
      `SELECT id,
              listing_id AS listingId
         FROM orders
        WHERE status = 'addons_waiting_approval'
          AND addons_review_ends_at IS NOT NULL
          AND addons_review_ends_at <= ?
          AND dispute_opened_at IS NULL`,
    )
    .all(now);

  if (!due.length) return { completedCount: 0 };

  db.transaction(() => {
    for (const row of due) {
      const orderId = String(row.id || '').trim();
      const listingId = String(row.listingId || '').trim();
      if (!orderId || !listingId) continue;

      db.prepare(
        `UPDATE orders
            SET status = 'completed',
                finalized_reason = COALESCE(finalized_reason, 'auto_addons_review_ended'),
                finalized_at = COALESCE(finalized_at, ?),
                updated_at = ?
          WHERE id = ? AND status = 'addons_waiting_approval'`,
      ).run(now, now, orderId);

      db.prepare(
        `UPDATE listings
            SET status = 'sold', updated_at = ?
          WHERE id = ? AND status = 'in_progress'`,
      ).run(now, listingId);
    }
  })();

  return { completedCount: due.length };
}

async function runOrderTimersTick({ nowIso } = {}) {
  const now = String(nowIso || new Date().toISOString()).trim();
  // 1) Auto-complete delivered orders whose review window ended.
  completeExpiredReviewOrders({ nowIso: now });
  // 1b) Auto-apply any legacy pending extension requests.
  autoApproveStaleMoreTimeRequests({ nowIso: now });
  // 2) Auto-complete add-ons once their buyer review window ends.
  completeExpiredAddOnsReviewOrders({ nowIso: now });
  // 3) Auto-cancel + refund overdue paid orders.
  await cancelOverduePaidOrdersAndRefund({ nowIso: now });
  // 4) Auto-cancel + refund overdue add-ons work.
  await cancelOverdueAddOnsOrdersAndRefund({ nowIso: now });
  // 5) Notify when timers are close to ending.
  notifyOrdersTimersEndingSoon({ nowIso: now });
  return { ok: true };
}

function autoApproveStaleMoreTimeRequests({ nowIso } = {}) {
  const now = String(nowIso || new Date().toISOString()).trim();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return { approvedCount: 0 };

  // Previous behavior: approve after 24h unanswered.
  // Current behavior: apply any pending request as soon as timers run.
  const cutoffIso = now;

  let approvedCount = 0;
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id,
                order_id AS orderId,
                stage,
                requester_id AS requesterId,
                requester_role AS requesterRole,
                hours,
                created_at AS createdAt,
                deadline_after_iso AS deadlineAfterIso
           FROM order_more_time_requests
          WHERE status = 'pending'
            AND created_at IS NOT NULL
            AND created_at <= ?
          ORDER BY created_at ASC
          LIMIT 200`,
      )
      .all(cutoffIso);
  } catch {
    return { approvedCount: 0 };
  }

  if (!Array.isArray(rows) || !rows.length) return { approvedCount: 0 };

  const tx = db.transaction((r) => {
    const requestId = String(r.id || '').trim();
    const orderId = String(r.orderId || '').trim();
    if (!requestId || !orderId) return false;

    const stage = toMoreTimeStageKey(r.stage);
    if (!stage) return false;
    const requesterId = String(r.requesterId || '').trim() || null;
    const requesterRole = getMoreTimeRequesterRole(stage);
    if (!requesterRole) return false;

    const afterIso = String(r.deadlineAfterIso || '').trim();
    if (!afterIso) return false;

    const orderRow = db
      .prepare(
        `SELECT id,
                status,
                created_at AS createdAt,
                delivered_at AS deliveredAt,
                addons_started_at AS addonsStartedAt,
                addons_completed_at AS addonsCompletedAt,
                dispute_opened_at AS disputeOpenedAt,
                dispute_resolved_at AS disputeResolvedAt
           FROM orders
          WHERE id = ?
          LIMIT 1`,
      )
      .get(orderId);

    if (!orderRow) return false;
    const statusLower = String(orderRow.status ?? '')
      .trim()
      .toLowerCase();
    if (
      statusLower === 'completed' ||
      statusLower === 'canceled' ||
      statusLower === 'cancelled'
    ) {
      return false;
    }

    const hasOpenDispute = Boolean(
      String(orderRow.disputeOpenedAt || '').trim() &&
      !String(orderRow.disputeResolvedAt || '').trim(),
    );
    if (hasOpenDispute) return false;

    const deliveredAt = String(orderRow.deliveredAt || '').trim();
    const addonsStartedAt = String(orderRow.addonsStartedAt || '').trim();
    const addonsCompletedAt = String(orderRow.addonsCompletedAt || '').trim();

    if (stage === 'delivery') {
      if (deliveredAt) return false;
      if (statusLower !== 'paid' && statusLower !== 'pending_payment') {
        return false;
      }
      db.prepare(
        `UPDATE orders
            SET delivery_due_at = ?,
                seller_more_time_requested_at = ?,
                seller_more_time_hours = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(afterIso, now, Number(r.hours ?? 0), now, orderId);
    } else if (stage === 'review') {
      if (!deliveredAt) return false;
      db.prepare(
        `UPDATE orders
            SET review_ends_at = ?,
                buyer_more_time_requested_at = ?,
                buyer_more_time_hours = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(afterIso, now, Number(r.hours ?? 0), now, orderId);
    } else if (stage === 'addons') {
      const inAddOnsStage =
        (statusLower.startsWith('addons') || !!addonsStartedAt) &&
        !addonsCompletedAt;
      if (!inAddOnsStage) return false;
      db.prepare(
        `UPDATE orders
            SET addons_due_at = ?,
                seller_more_time_requested_at = ?,
                seller_more_time_hours = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(afterIso, now, Number(r.hours ?? 0), now, orderId);
    } else {
      if (statusLower !== 'addons_waiting_approval' || !addonsCompletedAt) {
        return false;
      }
      db.prepare(
        `UPDATE orders
            SET addons_review_ends_at = ?,
                buyer_more_time_requested_at = ?,
                buyer_more_time_hours = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(afterIso, now, Number(r.hours ?? 0), now, orderId);
    }

    const info = db
      .prepare(
        `UPDATE order_more_time_requests
            SET status = 'applied',
                decided_at = ?,
                decided_by_id = ?,
                decided_by_role = ?,
                applied_at = COALESCE(applied_at, ?)
          WHERE id = ? AND order_id = ? AND status = 'pending'`,
      )
      .run(now, requesterId, requesterRole, now, requestId, orderId);

    return info?.changes > 0;
  });

  for (const r of rows) {
    try {
      const didApprove = tx(r);
      if (didApprove) approvedCount += 1;
    } catch {
      // best-effort
    }
  }

  return { approvedCount };
}

function notifyOrdersTimersEndingSoon({ nowIso }) {
  const now = String(nowIso || new Date().toISOString()).trim();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return { ok: false };

  const thresholdMs = 5 * 60 * 60 * 1000;
  const cutoffIso = new Date(nowMs + thresholdMs).toISOString();

  // Seller: delivery deadline in <= 5 hours (status=paid)
  try {
    const rows = db
      .prepare(
        `SELECT o.id,
                o.order_number AS orderNumber,
                o.seller_id AS sellerId,
                o.delivery_due_at AS deliveryDueAt,
                l.title AS listingTitle
           FROM orders o
           JOIN listings l ON l.id = o.listing_id
          WHERE o.status = 'paid'
            AND o.delivery_due_at IS NOT NULL
            AND o.delivery_due_at > ?
            AND o.delivery_due_at <= ?
            AND (o.seller_delivery_due_soon_notified_at IS NULL OR o.seller_delivery_due_soon_notified_at = '')
          ORDER BY o.delivery_due_at ASC
          LIMIT 200`,
      )
      .all(now, cutoffIso);

    const tx = db.transaction((r) => {
      createNotification({
        userId: String(r.sellerId),
        type: 'seller.delivery_due_soon',
        title: 'Delivery deadline soon',
        detail: `Only 5 hours left to deliver “${String(r.listingTitle || 'your order').trim()}”.`,
        entityType: 'order',
        entityId: String(r.id),
        data: {
          orderId: String(r.id),
          orderNumber: r.orderNumber || null,
          deliveryDueAt: r.deliveryDueAt || null,
        },
      });

      db.prepare(
        `UPDATE orders
            SET seller_delivery_due_soon_notified_at = ?,
                updated_at = updated_at
          WHERE id = ?`,
      ).run(now, String(r.id));
    });

    for (const r of rows) {
      try {
        tx(r);
      } catch {
        // Best-effort notifications; ignore per-row failures.
      }
    }
  } catch {
    // ignore
  }

  // Buyer: review window ends in <= 5 hours (status=delivered)
  try {
    const rows = db
      .prepare(
        `SELECT o.id,
                o.order_number AS orderNumber,
                o.buyer_id AS buyerId,
                o.review_ends_at AS reviewEndsAt,
                l.title AS listingTitle
           FROM orders o
           JOIN listings l ON l.id = o.listing_id
          WHERE o.status = 'delivered'
            AND o.review_ends_at IS NOT NULL
            AND o.review_ends_at > ?
            AND o.review_ends_at <= ?
            AND (o.buyer_review_ends_soon_notified_at IS NULL OR o.buyer_review_ends_soon_notified_at = '')
          ORDER BY o.review_ends_at ASC
          LIMIT 200`,
      )
      .all(now, cutoffIso);

    const tx = db.transaction((r) => {
      createNotification({
        userId: String(r.buyerId),
        type: 'buyer.review_ends_soon',
        title: 'Review window ending soon',
        detail: `Only 5 hours left to review “${String(r.listingTitle || 'your order').trim()}” before it auto-completes.`,
        entityType: 'order',
        entityId: String(r.id),
        data: {
          orderId: String(r.id),
          orderNumber: r.orderNumber || null,
          reviewEndsAt: r.reviewEndsAt || null,
        },
      });

      db.prepare(
        `UPDATE orders
            SET buyer_review_ends_soon_notified_at = ?,
                updated_at = updated_at
          WHERE id = ?`,
      ).run(now, String(r.id));
    });

    for (const r of rows) {
      try {
        tx(r);
      } catch {
        // Best-effort notifications; ignore per-row failures.
      }
    }
  } catch {
    // ignore
  }

  // Seller: add-ons due in <= 5 hours (status=addons)
  try {
    const rows = db
      .prepare(
        `SELECT o.id,
                o.order_number AS orderNumber,
                o.seller_id AS sellerId,
                o.addons_due_at AS addonsDueAt,
                l.title AS listingTitle
           FROM orders o
           JOIN listings l ON l.id = o.listing_id
          WHERE o.status = 'addons'
            AND o.addons_completed_at IS NULL
            AND o.addons_due_at IS NOT NULL
            AND o.addons_due_at > ?
            AND o.addons_due_at <= ?
            AND o.dispute_opened_at IS NULL
            AND (o.seller_addons_due_soon_notified_at IS NULL OR o.seller_addons_due_soon_notified_at = '')
          ORDER BY o.addons_due_at ASC
          LIMIT 200`,
      )
      .all(now, cutoffIso);

    const tx = db.transaction((r) => {
      createNotification({
        userId: String(r.sellerId),
        type: 'seller.addons_due_soon',
        title: 'Add-ons deadline soon',
        detail: `Only 5 hours left to complete the add-ons for “${String(r.listingTitle || 'your order').trim()}”.`,
        entityType: 'order',
        entityId: String(r.id),
        data: {
          orderId: String(r.id),
          orderNumber: r.orderNumber || null,
          addonsDueAt: r.addonsDueAt || null,
        },
      });

      db.prepare(
        `UPDATE orders
            SET seller_addons_due_soon_notified_at = ?,
                updated_at = updated_at
          WHERE id = ?`,
      ).run(now, String(r.id));
    });

    for (const r of rows) {
      try {
        tx(r);
      } catch {
        // Best-effort notifications; ignore per-row failures.
      }
    }
  } catch {
    // ignore
  }

  // Buyer: add-ons review window ends in <= 5 hours (status=addons_waiting_approval)
  try {
    const rows = db
      .prepare(
        `SELECT o.id,
                o.order_number AS orderNumber,
                o.buyer_id AS buyerId,
                o.addons_review_ends_at AS addonsReviewEndsAt,
                l.title AS listingTitle
           FROM orders o
           JOIN listings l ON l.id = o.listing_id
          WHERE o.status = 'addons_waiting_approval'
            AND o.addons_review_ends_at IS NOT NULL
            AND o.addons_review_ends_at > ?
            AND o.addons_review_ends_at <= ?
            AND o.dispute_opened_at IS NULL
            AND (o.buyer_addons_review_ends_soon_notified_at IS NULL OR o.buyer_addons_review_ends_soon_notified_at = '')
          ORDER BY o.addons_review_ends_at ASC
          LIMIT 200`,
      )
      .all(now, cutoffIso);

    const tx = db.transaction((r) => {
      createNotification({
        userId: String(r.buyerId),
        type: 'buyer.addons_review_ends_soon',
        title: 'Add-ons review ending soon',
        detail: `Only 5 hours left to review the add-ons for “${String(r.listingTitle || 'your order').trim()}” before it auto-completes.`,
        entityType: 'order',
        entityId: String(r.id),
        data: {
          orderId: String(r.id),
          orderNumber: r.orderNumber || null,
          addonsReviewEndsAt: r.addonsReviewEndsAt || null,
        },
      });

      db.prepare(
        `UPDATE orders
            SET buyer_addons_review_ends_soon_notified_at = ?,
                updated_at = updated_at
          WHERE id = ?`,
      ).run(now, String(r.id));
    });

    for (const r of rows) {
      try {
        tx(r);
      } catch {
        // Best-effort notifications; ignore per-row failures.
      }
    }
  } catch {
    // ignore
  }

  return { ok: true };
}

function downloadReceiptPdf(req, res) {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing order id' });

  const userId = String(req.user?.id || '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.status,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.selected_add_ons_json AS selectedAddOnsJson,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.platform_fee_usd AS platformFeeUsd,
              o.total_usd AS totalUsd,
              o.refunded_usd AS refundedUsd,
              COALESCE(o.refunded_subtotal_usd, COALESCE(o.refunded_usd, 0)) AS refundedSubtotalUsd,
              o.paid_at AS paidAt,
              o.created_at AS createdAt,
              l.title AS listingTitle,
              l.category AS listingCategory,
              l.add_ons_json AS listingAddOnsJson,
              b.email AS buyerEmail,
              b.display_name AS buyerDisplayName,
              b.username AS buyerUsername,
              b.name AS buyerName,
              s.email AS sellerEmail,
              s.display_name AS sellerDisplayName,
              s.username AS sellerUsername,
              s.name AS sellerName
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         JOIN users b ON b.id = o.buyer_id
         JOIN users s ON s.id = o.seller_id
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Order not found' });

  const status = String(row.status || '')
    .trim()
    .toLowerCase();
  const isFinalized = status === 'completed' || status === 'canceled';
  if (!isFinalized) {
    return res.status(400).json({
      error: 'Receipt is only available after the order is finalized',
    });
  }

  const buyerId = String(row.buyerId || '').trim();
  const sellerId = String(row.sellerId || '').trim();
  if (userId !== buyerId && userId !== sellerId) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const viewerRole = userId === buyerId ? 'buyer' : 'seller';

  const buyerName =
    String(row.buyerDisplayName || '').trim() ||
    String(row.buyerUsername || '').trim() ||
    String(row.buyerName || '').trim() ||
    String(row.buyerEmail || '').trim() ||
    'Buyer';

  const sellerName =
    String(row.sellerDisplayName || '').trim() ||
    String(row.sellerUsername || '').trim() ||
    String(row.sellerName || '').trim() ||
    String(row.sellerEmail || '').trim() ||
    'Seller';

  const listingTitle = String(row.listingTitle || 'Listing').trim();

  let orderNumber = String(row.orderNumber || '').trim();
  if (!orderNumber) {
    orderNumber = generateUniqueOrderNumber();
    db.prepare(
      `UPDATE orders
          SET order_number = COALESCE(order_number, ?),
              updated_at = updated_at
        WHERE id = ?`,
    ).run(orderNumber, id);
  }

  const filename = toSafePdfFilename(`receipt_${orderNumber}`, 'receipt.pdf');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  doc.on('error', () => {
    try {
      res.end();
    } catch {
      // ignore
    }
  });

  doc.pipe(res);

  const formatReceiptDate = (iso) => {
    const ms = Date.parse(String(iso || '').trim());
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const yyyy = String(d.getUTCFullYear());
    return `${mm}-${dd}-${yyyy}`;
  };

  // Header
  const logoSvg = getReceiptLogoSvgString();
  const headerTop = 48;
  const headerLeft = doc.page.margins.left;
  const headerRight = doc.page.width - doc.page.margins.right;

  const logoWidth = 24;
  const headerGap = 12;

  if (logoSvg) {
    try {
      const logoX = Math.max(headerLeft, headerRight - logoWidth);
      SVGtoPDF(doc, logoSvg, logoX, headerTop, { width: logoWidth });
    } catch {
      // ignore logo render errors
    }
  }

  const titleX = headerLeft;
  const titleY = headerTop;
  const titleMaxWidth =
    headerRight - headerLeft - (logoSvg ? logoWidth + headerGap : 0);

  doc
    .fontSize(20)
    .fillColor('#000000')
    .text('Receipt', titleX, titleY, {
      width: Math.max(0, titleMaxWidth),
      align: 'left',
    });

  doc.moveDown(2);
  doc
    .fontSize(10)
    .fillColor('#333333')
    .text(`Order: ${orderNumber || row.id}`)
    .text(`Date: ${formatReceiptDate(row.paidAt || row.createdAt)}`)
    .text(`Outcome: ${status === 'completed' ? 'Completed' : 'Canceled'}`)
    .text(`Buyer: ${buyerName}`)
    .text(`Seller: ${sellerName}`);

  doc.moveDown(1.5);
  doc.fontSize(12).fillColor('#000000').text('Items');
  doc.moveDown(0.5);

  // Line items
  doc
    .fontSize(10)
    .fillColor('#111111')
    .text(`${listingTitle}`, { continued: true })
    .text(`  ${formatUsd(row.listingPriceUsd)}`, {
      align: 'right',
    });

  const selectedAddOns = safeJsonParse(row.selectedAddOnsJson, null);
  const addOnIds = Array.isArray(selectedAddOns) ? selectedAddOns : [];
  const listingAddOnsJson = safeJsonParse(row.listingAddOnsJson, {
    addOns: [],
    addOnPrices: {},
    addOnTimes: {},
  });
  const addOnPrices =
    typeof listingAddOnsJson?.addOnPrices === 'object' &&
    listingAddOnsJson.addOnPrices
      ? listingAddOnsJson.addOnPrices
      : {};
  if (addOnIds.length) {
    for (const idRaw of addOnIds.slice(0, 25)) {
      const label = String(idRaw || '').trim();
      if (!label) continue;

      const addOnPriceUsd = Number(addOnPrices[label]);
      if (Number.isFinite(addOnPriceUsd)) {
        doc
          .fontSize(10)
          .fillColor('#444444')
          .text(`Add-on: ${label}`, { continued: true })
          .text(`  ${formatUsd(addOnPriceUsd)}`, { align: 'right' });
      } else {
        doc.fontSize(10).fillColor('#444444').text(`Add-on: ${label}`);
      }
    }
  }

  doc.moveDown(1);

  const listingPriceUsd = Number(row.listingPriceUsd ?? 0);
  const addOnsTotalUsd = Number(row.addOnsTotalUsd ?? 0);
  const subtotalUsd = listingPriceUsd + addOnsTotalUsd;
  const totalUsd = Number(row.totalUsd ?? 0);
  const platformFeeUsd = Number(row.platformFeeUsd ?? 0);
  const serviceFeeUsd = Math.max(0, totalUsd - subtotalUsd);

  const refundedUsd = Math.max(0, Number(row.refundedUsd ?? 0));
  const refundedSubtotalUsd = Math.max(
    0,
    Math.min(subtotalUsd, Number(row.refundedSubtotalUsd ?? refundedUsd)),
  );

  doc
    .fontSize(10)
    .fillColor('#111111')
    .text(`Subtotal`, { continued: true })
    .text(`${formatUsd(subtotalUsd)}`, { align: 'right' });

  if (viewerRole === 'seller') {
    doc
      .fontSize(10)
      .fillColor('#111111')
      .text(`Platform fee`, { continued: true })
      .text(`-${formatUsd(platformFeeUsd)}`, { align: 'right' });
  } else {
    doc
      .fontSize(10)
      .fillColor('#111111')
      .text(`Service fee`, { continued: true })
      .text(`${formatUsd(serviceFeeUsd)}`, { align: 'right' });
  }

  const isPartialRefund =
    viewerRole === 'seller'
      ? refundedSubtotalUsd > 0 && refundedSubtotalUsd < subtotalUsd
      : Number.isFinite(refundedUsd) &&
        refundedUsd > 0 &&
        Number.isFinite(totalUsd) &&
        refundedUsd < totalUsd;

  if (isPartialRefund) {
    doc
      .fontSize(10)
      .fillColor('#111111')
      .text(`Partial refund`, { continued: true })
      .text(
        `-${formatUsd(viewerRole === 'seller' ? refundedSubtotalUsd : refundedUsd)}`,
        { align: 'right' },
      );
  }

  const sellerPayoutUsd = Math.max(
    0,
    subtotalUsd - platformFeeUsd - refundedSubtotalUsd,
  );

  doc
    .fontSize(10)
    .fillColor('#111111')
    .text(`Total paid`, { continued: true })
    .text(
      `${formatUsd(viewerRole === 'seller' ? sellerPayoutUsd : totalUsd)}`,
      { align: 'right' },
    );

  if (row.listingCategory) {
    doc
      .fontSize(9)
      .fillColor('#666666')
      .text(`Category: ${String(row.listingCategory).trim()}`);
  }

  doc.moveDown(2);
  doc.fontSize(9).fillColor('#666666').text('Thank you for your purchase.');

  doc.end();
}

function addDaysToIso(iso, days) {
  const baseMs = Date.parse(String(iso || ''));
  if (!Number.isFinite(baseMs)) return null;
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return null;
  const ms = baseMs + Math.floor(d) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function addHoursToIso(iso, hours) {
  const baseMs = Date.parse(String(iso || ''));
  if (!Number.isFinite(baseMs)) return null;
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  const ms = baseMs + Math.floor(h) * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

function getRequestBaseUrl(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0];
  const proto = xfProto ? xfProto.trim() : req.protocol;
  const host = req.get('host');
  return `${proto}://${host}`;
}

function toSafeAttachmentFilename(filename, fallback = 'delivery.zip') {
  const raw = String(filename || '')
    .replace(/[\r\n]/g, ' ')
    .trim();

  const sanitized = raw
    ? raw.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200)
    : fallback;

  const ascii = sanitized
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  const base = ascii || fallback;
  const withExt = base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
  return withExt || fallback;
}

function isZipMagicBytes(buf) {
  if (!buf || buf.length < 4) return false;
  // ZIP local file header (PK\x03\x04), empty archive (PK\x05\x06), spanned (PK\x07\x08)
  return (
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) ||
      (buf[2] === 0x05 && buf[3] === 0x06) ||
      (buf[2] === 0x07 && buf[3] === 0x08))
  );
}

function proxyStreamUrlToResponse(
  url,
  res,
  { maxRedirects = 5, onBeforePipe = null } = {},
) {
  return new Promise((resolve, reject) => {
    const start = (currentUrl, redirectsLeft) => {
      let urlObj;
      try {
        urlObj = new URL(String(currentUrl));
      } catch (e) {
        return reject(new Error('Invalid delivery URL'));
      }

      const client = urlObj.protocol === 'https:' ? https : http;
      const reqUp = client.get(urlObj, (upRes) => {
        const status = Number(upRes.statusCode || 0);

        if (
          status >= 300 &&
          status < 400 &&
          upRes.headers.location &&
          redirectsLeft > 0
        ) {
          const nextUrl = new URL(String(upRes.headers.location), urlObj);
          upRes.resume();
          return start(nextUrl.toString(), redirectsLeft - 1);
        }

        if (status < 200 || status >= 300) {
          upRes.resume();
          return reject(new Error(`Upstream download failed (${status || 0})`));
        }

        if (typeof onBeforePipe === 'function') {
          try {
            onBeforePipe(upRes, urlObj);
          } catch (err) {
            upRes.resume();
            return reject(err);
          }
        }

        upRes.on('error', reject);
        upRes.pipe(res);
        upRes.on('end', resolve);
      });

      reqUp.on('error', reject);
    };

    start(url, maxRedirects);
  });
}

function fetchUrlHeaders(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = (currentUrl, redirectsLeft) => {
      let urlObj;
      try {
        urlObj = new URL(String(currentUrl));
      } catch (e) {
        return reject(new Error('Invalid delivery URL'));
      }

      const client = urlObj.protocol === 'https:' ? https : http;
      const reqUp = client.request(
        urlObj,
        {
          method: 'HEAD',
        },
        (upRes) => {
          const status = Number(upRes.statusCode || 0);

          if (
            status >= 300 &&
            status < 400 &&
            upRes.headers.location &&
            redirectsLeft > 0
          ) {
            const nextUrl = new URL(String(upRes.headers.location), urlObj);
            upRes.resume();
            return start(nextUrl.toString(), redirectsLeft - 1);
          }

          if (status < 200 || status >= 300) {
            upRes.resume();
            return reject(new Error(`Upstream HEAD failed (${status || 0})`));
          }

          const headers = upRes.headers || {};
          upRes.resume();
          return resolve(headers);
        },
      );

      reqUp.on('error', reject);
      reqUp.end();
    };

    start(url, maxRedirects);
  });
}

async function createOrder(req, res) {
  // requireAuth middleware guarantees req.user
  const buyerId = req.user.id;

  const listingId =
    typeof req.body?.listingId === 'string' ? req.body.listingId.trim() : '';
  if (!listingId)
    return res.status(400).json({ error: 'listingId is required' });

  const selectedAddOns = Array.isArray(req.body?.selectedAddOns)
    ? req.body.selectedAddOns
    : [];

  const listing = db
    .prepare(
      `SELECT id,
              seller_id AS sellerId,
              status,
              title,
              price_usd AS priceUsd,
              add_ons_json AS addOnsJson,
              delivery_method AS deliveryMethod,
              support_days AS supportDays
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (listing.sellerId === buyerId)
    return res.status(400).json({ error: 'You cannot buy your own listing' });

  const listingPriceUsd = toInt(listing.priceUsd, { min: 1, max: 1_000_000 });
  if (!listingPriceUsd)
    return res.status(400).json({ error: 'Listing price is invalid' });

  const addOnsJson = safeJsonParse(listing.addOnsJson, {
    addOns: [],
    addOnPrices: {},
  });

  const totals = computeOrderTotals({
    listingPriceUsd,
    selectedAddOnIds: selectedAddOns,
    addOnsJson,
  });

  const now = new Date().toISOString();
  const deliveryDueAt = addHoursToIso(now, 48);
  // Review window starts when delivery is submitted.
  const reviewEndsAt = null;
  const id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : require('crypto').randomUUID();
  const insert = db.prepare(
    `INSERT INTO orders (
        id,
        order_number,
        listing_id,
        buyer_id,
        seller_id,
        status,
        delivery_due_at,
        review_ends_at,
        selected_add_ons_json,
        listing_price_usd,
        add_ons_total_usd,
        platform_fee_usd,
        seller_platform_fee_bps,
        buyer_service_fee_bps,
        total_usd,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let orderNumber = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    orderNumber = generateUniqueOrderNumber();
    try {
      insert.run(
        id,
        orderNumber,
        listingId,
        buyerId,
        listing.sellerId,
        'pending_payment',
        deliveryDueAt,
        reviewEndsAt,
        JSON.stringify(totals.selectedAddOns),
        listingPriceUsd,
        totals.addOnsTotalUsd,
        totals.platformFeeUsd,
        totals.sellerPlatformFeeBps,
        totals.buyerServiceFeeBps,
        totals.totalUsd,
        now,
        now,
      );
      break;
    } catch (e) {
      const msg = String(e?.message ?? '');
      const isUniqueConflict = msg.includes('idx_orders_order_number_unique');
      if (!isUniqueConflict || attempt === 9) throw e;
      // Retry with a different number.
    }
  }

  return res.json({
    order: {
      id,
      orderNumber,
      status: 'pending_payment',
      deliveryDueAt,
      reviewEndsAt,
      listing: {
        id: listing.id,
        title: listing.title,
        priceUsd: listingPriceUsd,
        deliveryMethod: listing.deliveryMethod,
        supportDays: listing.supportDays ?? null,
      },
      selectedAddOns: totals.selectedAddOns,
      amounts: {
        listingPriceUsd,
        addOnsTotalUsd: totals.addOnsTotalUsd,
        platformFeeUsd: totals.platformFeeUsd,
        totalUsd: totals.totalUsd,
      },
      createdAt: now,
    },
  });
}

async function finalizePaidOrderFromPaymentIntent({ paymentIntentId }) {
  const stripePaymentIntentId = String(paymentIntentId ?? '').trim();
  if (!stripePaymentIntentId) throw new Error('paymentIntentId is required');

  const existing = db
    .prepare(
      `SELECT id
         FROM orders
        WHERE stripe_payment_intent_id = ?
        LIMIT 1`,
    )
    .get(stripePaymentIntentId);
  if (existing?.id) return { orderId: String(existing.id) };

  const checkout = db
    .prepare(
      `SELECT id,
              listing_id AS listingId,
              buyer_id AS buyerId,
              status,
              selected_add_ons_json AS selectedAddOnsJson,
              listing_price_usd AS listingPriceUsd,
              add_ons_total_usd AS addOnsTotalUsd,
              platform_fee_usd AS platformFeeUsd,
              seller_platform_fee_bps AS sellerPlatformFeeBps,
              buyer_service_fee_bps AS buyerServiceFeeBps,
              total_usd AS totalUsd,
              expires_at AS expiresAt
         FROM checkout_intents
        WHERE stripe_payment_intent_id = ?
        LIMIT 1`,
    )
    .get(stripePaymentIntentId);

  if (!checkout?.id) throw new Error('Checkout intent not found');

  const now = new Date().toISOString();
  const deliveryDueAt = addHoursToIso(now, 48);
  // Review window starts when delivery is submitted.
  const reviewEndsAt = null;
  // If it was left open and expired, still allow finalize if Stripe succeeded.

  const listing = db
    .prepare(
      `SELECT id,
              seller_id AS sellerId,
              status,
              title,
              delivery_method AS deliveryMethod,
              support_days AS supportDays
         FROM listings
        WHERE id = ?
        LIMIT 1`,
    )
    .get(String(checkout.listingId));

  if (!listing?.id) throw new Error('Listing not found');

  const id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : require('crypto').randomUUID();
  const orderNumber = generateUniqueOrderNumber();

  const selectedAddOns = safeJsonParse(checkout.selectedAddOnsJson, []);

  const listingPriceUsd = Math.max(0, Number(checkout.listingPriceUsd ?? 0));
  const addOnsTotalUsd = Math.max(0, Number(checkout.addOnsTotalUsd ?? 0));
  const subtotalUsd = listingPriceUsd + addOnsTotalUsd;

  const defaultSellerBps = getSellerPlatformFeeBps();
  const defaultBuyerBps = getBuyerServiceFeeBps();
  const checkoutSellerBps = Number(checkout.sellerPlatformFeeBps ?? NaN);
  const checkoutBuyerBps = Number(checkout.buyerServiceFeeBps ?? NaN);

  const baseSellerPlatformFeeBps = Number.isFinite(checkoutSellerBps)
    ? Math.max(0, Math.min(10_000, checkoutSellerBps))
    : defaultSellerBps;
  const baseBuyerServiceFeeBps = Number.isFinite(checkoutBuyerBps)
    ? Math.max(0, Math.min(10_000, checkoutBuyerBps))
    : defaultBuyerBps;

  // Transaction: create order, mark listing in progress, mark checkout finalized.
  const tx = db.transaction(() => {
    // If listing already has an order, only allow when it's for the same payment intent.
    const already = db
      .prepare(
        `SELECT id, stripe_payment_intent_id AS stripePaymentIntentId
           FROM orders
          WHERE listing_id = ?
          LIMIT 1`,
      )
      .get(String(checkout.listingId));

    if (
      already?.id &&
      String(already.stripePaymentIntentId || '') !== stripePaymentIntentId
    ) {
      const err = new Error('Listing has already been purchased');
      err.status = 409;
      throw err;
    }

    // Allocate promo atomically: first paid sale is free for first N sellers.
    let sellerPlatformFeeBps = baseSellerPlatformFeeBps;

    try {
      const userRow = db
        .prepare(
          `SELECT used_free_first_sale_platform_fee AS used
             FROM users
            WHERE id = ?
            LIMIT 1`,
        )
        .get(String(listing.sellerId));
      const used = Number(userRow?.used ?? 0) === 1;

      if (!used) {
        // Ensure state row exists even if table was added to an existing DB.
        const state = db
          .prepare(
            `SELECT free_first_sale_slots_remaining AS remaining
               FROM platform_fee_promo_state
              WHERE id = 1
              LIMIT 1`,
          )
          .get();

        const remaining = Number(state?.remaining ?? 0);
        if (remaining > 0) {
          sellerPlatformFeeBps = 0;
          const nowIso = now;

          db.prepare(
            `UPDATE users
                SET used_free_first_sale_platform_fee = 1
              WHERE id = ? AND used_free_first_sale_platform_fee = 0`,
          ).run(String(listing.sellerId));

          db.prepare(
            `UPDATE platform_fee_promo_state
                SET free_first_sale_slots_remaining = free_first_sale_slots_remaining - 1,
                    updated_at = ?
              WHERE id = 1 AND free_first_sale_slots_remaining > 0`,
          ).run(nowIso);
        }
      }
    } catch {
      // Best-effort: if promo tables/columns are missing, fall back to default fees.
    }

    const platformFeeUsd =
      sellerPlatformFeeBps === 0
        ? 0
        : computeFeeUsd({
            amountUsd: subtotalUsd,
            feeBps: sellerPlatformFeeBps,
          });

    const buyerServiceFeeBps = baseBuyerServiceFeeBps;

    db.prepare(
      `INSERT INTO orders (
        id,
        order_number,
        listing_id,
        buyer_id,
        seller_id,
        status,
        delivery_due_at,
        review_ends_at,
        selected_add_ons_json,
        listing_price_usd,
        add_ons_total_usd,
        platform_fee_usd,
        seller_platform_fee_bps,
        buyer_service_fee_bps,
        total_usd,
        stripe_payment_intent_id,
        paid_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      orderNumber,
      String(checkout.listingId),
      String(checkout.buyerId),
      String(listing.sellerId),
      'paid',
      deliveryDueAt,
      reviewEndsAt,
      JSON.stringify(Array.isArray(selectedAddOns) ? selectedAddOns : []),
      listingPriceUsd,
      addOnsTotalUsd,
      platformFeeUsd,
      sellerPlatformFeeBps,
      buyerServiceFeeBps,
      Number(checkout.totalUsd ?? 0),
      stripePaymentIntentId,
      now,
      now,
      now,
    );

    // Notify seller: new paid order received.
    // Uses the existing v1 notification type allowed by the notifications controller.
    createNotification({
      userId: String(listing.sellerId),
      type: 'seller.new_order_received',
      title: 'New order received',
      detail: `Your listing “${String(listing.title || 'Listing')}” was purchased.`,
      entityType: 'order',
      entityId: id,
      data: {
        orderId: id,
        orderNumber,
        listingId: String(checkout.listingId),
        buyerId: String(checkout.buyerId),
        totalUsd: Number(checkout.totalUsd ?? 0),
      },
    });

    // Hide listing from public by moving it to in_progress.
    if (String(listing.status) === 'active') {
      db.prepare(
        `UPDATE listings SET status = 'in_progress', updated_at = ? WHERE id = ?`,
      ).run(now, String(checkout.listingId));
    }

    db.prepare(
      `UPDATE checkout_intents
          SET status = 'finalized', updated_at = ?
        WHERE id = ?`,
    ).run(now, String(checkout.id));

    // Close any other expired/open locks for this listing.
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'closed', updated_at = ?
        WHERE listing_id = ?
          AND status = 'open'
          AND id <> ?`,
    ).run(now, String(checkout.listingId), String(checkout.id));
  });

  tx();
  return { orderId: id };
}

async function finalizePaidOrder(req, res) {
  const buyerId = String(req.user?.id ?? '').trim();
  if (!buyerId) return res.status(401).json({ error: 'Not authenticated' });

  const paymentIntentId = String(req.body?.paymentIntentId ?? '').trim();
  if (!paymentIntentId)
    return res.status(400).json({ error: 'paymentIntentId is required' });

  // Verify with Stripe.
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!pi) return res.status(404).json({ error: 'Payment not found' });
  if (String(pi.status) !== 'succeeded') {
    return res.status(400).json({ error: 'Payment is not completed' });
  }

  const checkout = db
    .prepare(
      `SELECT buyer_id AS buyerId
         FROM checkout_intents
        WHERE stripe_payment_intent_id = ?
        LIMIT 1`,
    )
    .get(paymentIntentId);
  if (!checkout?.buyerId)
    return res.status(404).json({ error: 'Checkout intent not found' });
  if (String(checkout.buyerId) !== buyerId)
    return res.status(403).json({ error: 'Not authorized' });

  try {
    const { orderId } = await finalizePaidOrderFromPaymentIntent({
      paymentIntentId,
    });
    return res.json({ order: { id: orderId } });
    tx();
    return res.json({ order: { id } });
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    const msg = e instanceof Error ? e.message : 'Could not create order';
    return res.status(status).json({ error: msg });
  }
}

async function markDelivered(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.seller_id AS sellerId,
              o.status,
              o.delivered_at AS deliveredAt,
              o.review_ends_at AS reviewEndsAt,
              o.delivery_zip_url AS deliveryZipUrl,
              o.delivery_zip_public_id AS deliveryZipPublicId,
              o.delivery_zip_filename AS deliveryZipFilename,
              o.delivery_repo_link AS deliveryRepoLink,
              o.delivery_repo_username AS deliveryRepoUsername,
              o.delivery_repo_message AS deliveryRepoMessage,
              o.listing_id AS listingId,
              l.support_days AS supportDays
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.sellerId) !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const status = String(row.status || '').toLowerCase();
  if (status !== 'paid' && status !== 'delivered') {
    return res.status(400).json({ error: 'Order is not ready for delivery' });
  }

  const repoLinkRaw =
    typeof req.body?.repoLink === 'string' ? req.body.repoLink.trim() : '';
  const repoEmailRaw =
    typeof req.body?.repoEmail === 'string' ? req.body.repoEmail.trim() : '';
  const buyerGithubUsernameRaw =
    typeof req.body?.buyerGithubUsername === 'string'
      ? req.body.buyerGithubUsername.trim()
      : '';
  const repoMessageRaw =
    typeof req.body?.repoMessage === 'string'
      ? req.body.repoMessage.trim()
      : '';

  const wantsRepoUpdate =
    !!repoLinkRaw ||
    !!repoEmailRaw ||
    !!buyerGithubUsernameRaw ||
    !!repoMessageRaw;

  if (wantsRepoUpdate && !repoLinkRaw) {
    return res
      .status(400)
      .json({ error: 'repoLink is required for repo delivery' });
  }

  const hasExistingZip = !!String(row.deliveryZipUrl || '').trim();
  const hasExistingRepo = !!String(row.deliveryRepoLink || '').trim();

  // Reset ZIP flow: we only accept a real ZIP file uploaded to our backend.
  // (No more client-provided Cloudinary URLs / public IDs.)
  const clientZipUrlRaw =
    typeof req.body?.zipUrl === 'string' ? req.body.zipUrl.trim() : '';
  const clientZipPublicIdRaw =
    typeof req.body?.zipPublicId === 'string'
      ? req.body.zipPublicId.trim()
      : '';
  if (clientZipUrlRaw || clientZipPublicIdRaw) {
    return res.status(400).json({
      error:
        'ZIP uploads must be submitted as a .zip file (please re-select and submit the ZIP).',
    });
  }

  const hasNewZip = !!req.file?.buffer;
  const hasNewRepo = !!repoLinkRaw;

  if (!hasExistingZip && !hasExistingRepo && !hasNewZip && !hasNewRepo) {
    return res.status(400).json({
      error:
        'Provide a ZIP file and/or repo invite details before submitting delivery',
    });
  }

  const now = new Date().toISOString();

  // Review window is always 48h from the first delivery submission.
  // If delivery already happened, preserve the existing review_ends_at unless it's missing.
  const deliveredAtExisting = String(row.deliveredAt || '').trim();
  const reviewEndsAtFirstDelivery = addHoursToIso(now, 48);
  const reviewEndsAtFromExistingDelivery = addHoursToIso(
    deliveredAtExisting || now,
    48,
  );

  let uploadedZip = null;
  if (!!req.file?.buffer) {
    if (!isZipMagicBytes(req.file.buffer)) {
      return res
        .status(400)
        .json({ error: 'Uploaded file is not a valid ZIP' });
    }

    // Block delivery if malware scan fails.
    try {
      const scan = await scanBufferWithClamAV(req.file.buffer);
      if (!scan.clean) {
        return res.status(400).json({ error: 'ZIP failed malware scan' });
      }
    } catch (e) {
      const msg = toScanErrorMessage(e);
      console.warn('ClamAV scan skipped (buffer):', msg);
      if (shouldBlockDeliveryForScanError(e)) {
        return res.status(503).json({ error: msg });
      }
    }

    try {
      uploadedZip = await uploadOrderDeliveryZipBuffer({
        orderId: id,
        buffer: req.file.buffer,
      });
      uploadedZip.filename = toSafeAttachmentFilename(
        String(req.file?.originalname || '').trim(),
        'delivery.zip',
      );
    } catch (e) {
      const statusCode = typeof e?.status === 'number' ? e.status : 500;
      const msg = e instanceof Error ? e.message : 'Could not upload ZIP';
      return res.status(statusCode).json({ error: msg });
    }
  }

  // If we got a ZIP (either direct or buffer upload), scan it before marking delivered.
  if (uploadedZip?.url) {
    try {
      const scan = await scanUrlWithClamAV(uploadedZip.url);
      if (!scan.clean) {
        // Best-effort cleanup of the uploaded asset.
        try {
          await deleteRawResourceByPublicId({
            publicId: uploadedZip.publicId,
          });
        } catch {
          // ignore cleanup errors
        }
        return res.status(400).json({ error: 'ZIP failed malware scan' });
      }
    } catch (e) {
      const msg = toScanErrorMessage(e);
      console.warn('ClamAV scan skipped (url):', msg);
      if (shouldBlockDeliveryForScanError(e)) {
        return res.status(503).json({ error: msg });
      }
    }
  }

  db.prepare(
    `UPDATE orders
        SET status = 'delivered',
            delivered_at = COALESCE(delivered_at, ?),
            review_ends_at = CASE
              WHEN delivered_at IS NULL OR delivered_at = '' THEN ?
              ELSE COALESCE(review_ends_at, ?)
            END,
            delivery_zip_url = COALESCE(?, delivery_zip_url),
            delivery_zip_public_id = COALESCE(?, delivery_zip_public_id),
            delivery_zip_filename = COALESCE(?, delivery_zip_filename),
            delivery_zip_size_bytes = COALESCE(?, delivery_zip_size_bytes),
            delivery_repo_link = COALESCE(?, delivery_repo_link),
            delivery_repo_username = COALESCE(?, delivery_repo_username),
            delivery_repo_email = COALESCE(?, delivery_repo_email),
            delivery_repo_message = COALESCE(?, delivery_repo_message),
            updated_at = ?
      WHERE id = ?`,
  ).run(
    now,
    // First submit: reset any prefilled review_ends_at to now+48.
    reviewEndsAtFirstDelivery,
    // Subsequent submits: backfill only if missing.
    reviewEndsAtFromExistingDelivery,
    uploadedZip?.url ?? null,
    uploadedZip?.publicId ?? null,
    hasNewZip ? (uploadedZip?.filename ?? null) : null,
    hasNewZip && req.file?.buffer ? req.file.buffer.length : null,
    hasNewRepo ? repoLinkRaw : null,
    hasNewRepo ? buyerGithubUsernameRaw || null : null,
    hasNewRepo ? repoEmailRaw || null : null,
    hasNewRepo ? repoMessageRaw || null : null,
    now,
    id,
  );

  return res.json({ ok: true });
}

async function uploadDeliveryZipDraft(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.seller_id AS sellerId,
              o.status
         FROM orders o
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.sellerId) !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const status = String(row.status || '').toLowerCase();
  if (status !== 'paid' && status !== 'delivered') {
    return res.status(400).json({ error: 'Order is not ready for delivery' });
  }

  if (!req.file?.buffer) {
    return res.status(400).json({ error: 'ZIP file is required' });
  }

  if (!isZipMagicBytes(req.file.buffer)) {
    return res.status(400).json({ error: 'Uploaded file is not a valid ZIP' });
  }

  // Scan before upload where possible.
  try {
    const scan = await scanBufferWithClamAV(req.file.buffer);
    if (!scan.clean) {
      return res.status(400).json({ error: 'ZIP failed malware scan' });
    }
  } catch (e) {
    const msg = toScanErrorMessage(e);
    console.warn('ClamAV scan skipped (buffer):', msg);
    if (shouldBlockDeliveryForScanError(e)) {
      return res.status(503).json({ error: msg });
    }
  }

  let uploadedZip = null;
  try {
    uploadedZip = await uploadOrderDeliveryZipBuffer({
      orderId: id,
      buffer: req.file.buffer,
    });
    uploadedZip.filename = toSafeAttachmentFilename(
      String(req.file?.originalname || '').trim(),
      'delivery.zip',
    );
  } catch (e) {
    const statusCode = typeof e?.status === 'number' ? e.status : 500;
    const msg = e instanceof Error ? e.message : 'Could not upload ZIP';
    return res.status(statusCode).json({ error: msg });
  }

  // Scan the uploaded asset URL too (best effort).
  if (uploadedZip?.url) {
    try {
      const scan = await scanUrlWithClamAV(uploadedZip.url);
      if (!scan.clean) {
        try {
          await deleteRawResourceByPublicId({ publicId: uploadedZip.publicId });
        } catch {
          // ignore cleanup errors
        }
        return res.status(400).json({ error: 'ZIP failed malware scan' });
      }
    } catch (e) {
      const msg = toScanErrorMessage(e);
      console.warn('ClamAV scan skipped (url):', msg);
      if (shouldBlockDeliveryForScanError(e)) {
        return res.status(503).json({ error: msg });
      }
    }
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders
        SET delivery_zip_url = ?,
            delivery_zip_public_id = ?,
            delivery_zip_filename = ?,
            delivery_zip_size_bytes = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    uploadedZip?.url ?? null,
    uploadedZip?.publicId ?? null,
    uploadedZip?.filename ?? null,
    req.file?.buffer ? req.file.buffer.length : null,
    now,
    id,
  );

  return res.json({ ok: true });
}

async function updateDeliveryRepoDraft(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.seller_id AS sellerId,
              o.status
         FROM orders o
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.sellerId) !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const status = String(row.status || '').toLowerCase();
  if (status !== 'paid' && status !== 'delivered') {
    return res.status(400).json({ error: 'Order is not ready for delivery' });
  }

  const repoLinkRaw =
    typeof req.body?.repoLink === 'string' ? req.body.repoLink.trim() : '';
  const repoEmailRaw =
    typeof req.body?.repoEmail === 'string' ? req.body.repoEmail.trim() : '';
  const buyerGithubUsernameRaw =
    typeof req.body?.buyerGithubUsername === 'string'
      ? req.body.buyerGithubUsername.trim()
      : '';
  const repoMessageRaw =
    typeof req.body?.repoMessage === 'string'
      ? req.body.repoMessage.trim()
      : '';

  if (!repoLinkRaw) {
    return res
      .status(400)
      .json({ error: 'repoLink is required for repo delivery' });
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE orders
        SET delivery_repo_link = ?,
            delivery_repo_username = ?,
            delivery_repo_email = ?,
            delivery_repo_message = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(
    repoLinkRaw,
    buyerGithubUsernameRaw || null,
    repoEmailRaw || null,
    repoMessageRaw || null,
    now,
    id,
  );

  return res.json({ ok: true });
}

async function createDeliveryZipUploadSignature(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.seller_id AS sellerId,
              o.status
         FROM orders o
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.sellerId) !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const status = String(row.status || '').toLowerCase();
  if (status !== 'paid' && status !== 'delivered') {
    return res.status(400).json({ error: 'Order is not ready for delivery' });
  }

  const publicId = `mehor/orders/${id}/delivery_zip`;
  const signed = createSignedRawUploadParams({ publicId });

  return res.json({ ok: true, upload: signed });
}

async function markCompleted(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.buyer_id AS buyerId,
              o.status,
              o.listing_id AS listingId,
              o.selected_add_ons_json AS selectedAddOnsJson,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_resolved_at AS disputeResolvedAt
         FROM orders o
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.buyerId) !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const status = String(row.status || '').toLowerCase();
  if (status === 'completed') {
    return res.json({ ok: true, status: 'completed' });
  }

  if (status !== 'delivered' && status !== 'addons_waiting_approval') {
    return res.status(400).json({ error: 'Order is not ready to complete' });
  }

  const hasOpenDispute = Boolean(String(row.disputeOpenedAt || '').trim());
  const disputeResolvedAt = String(row.disputeResolvedAt || '').trim();
  if (hasOpenDispute && !disputeResolvedAt) {
    return res.status(400).json({ error: 'Resolve dispute before completing' });
  }

  const selectedAddOns = safeJsonParse(row.selectedAddOnsJson, []);
  const hasAddOns = Array.isArray(selectedAddOns) && selectedAddOns.length;

  if (status === 'delivered' && hasAddOns) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE orders
          SET status = 'addons',
              addons_started_at = COALESCE(addons_started_at, ?),
              updated_at = ?
        WHERE id = ? AND status = 'delivered'`,
    ).run(now, now, id);

    return res.json({ ok: true, status: 'addons' });
  }

  // If this completion transitions the listing to sold, remove its images from Cloudinary.
  // Block the transition if Cloudinary is configured but cleanup fails.
  try {
    await deleteCloudinaryResourcesByPrefix({
      prefix: `mehor/listings/${String(row.listingId)}/`,
      resourceType: 'image',
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED')) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete listing images' });
    }
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE orders
          SET status = 'completed',
              addons_started_at = COALESCE(addons_started_at, CASE WHEN status = 'addons_waiting_approval' THEN ? ELSE addons_started_at END),
              addons_completed_at = COALESCE(addons_completed_at, CASE WHEN status = 'addons_waiting_approval' THEN ? ELSE addons_completed_at END),
              finalized_reason = COALESCE(finalized_reason, 'buyer_accepted'),
              finalized_at = COALESCE(finalized_at, ?),
              dispute_resolved_at = CASE
                WHEN dispute_opened_at IS NOT NULL THEN COALESCE(dispute_resolved_at, ?)
                ELSE dispute_resolved_at
              END,
              updated_at = ?
        WHERE id = ?`,
    ).run(now, now, now, now, now, id);

    // Move listing from in_progress to sold so it drops from seller listings panel.
    db.prepare(
      `UPDATE listings
          SET status = 'sold', screenshots_json = NULL, updated_at = ?
        WHERE id = ? AND status = 'in_progress'`,
    ).run(now, String(row.listingId));
  })();

  return res.json({ ok: true, status: 'completed' });
}

async function markAddOnsCompleted(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.seller_id AS sellerId,
              o.status,
              o.listing_id AS listingId,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_resolved_at AS disputeResolvedAt
         FROM orders o
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.sellerId) !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const status = String(row.status || '').toLowerCase();
  if (status === 'completed') {
    return res.json({ ok: true, status: 'completed' });
  }
  if (status !== 'addons') {
    return res.status(400).json({ error: 'Add-ons are not in progress' });
  }

  const hasOpenDispute = Boolean(String(row.disputeOpenedAt || '').trim());
  const disputeResolvedAt = String(row.disputeResolvedAt || '').trim();
  if (hasOpenDispute && !disputeResolvedAt) {
    return res.status(400).json({ error: 'Resolve dispute before completing' });
  }

  const now = new Date().toISOString();
  const addonsReviewEndsAt = addHoursToIso(now, ADDONS_REVIEW_WINDOW_HOURS);
  db.prepare(
    `UPDATE orders
        SET status = 'addons_waiting_approval',
            addons_completed_at = COALESCE(addons_completed_at, ?),
            addons_review_ends_at = COALESCE(addons_review_ends_at, ?),
            updated_at = ?
      WHERE id = ? AND status = 'addons'`,
  ).run(now, addonsReviewEndsAt, now, id);

  return res.json({ ok: true, status: 'addons_waiting_approval' });
}

async function getOrder(req, res) {
  const viewerId = req.user.id;
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  // Opportunistically sync expired order timers so status-driven UI stays correct
  // even if the background tick has not run yet.
  const nowIso = new Date().toISOString();
  completeExpiredReviewOrders({ nowIso });
  completeExpiredAddOnsReviewOrders({ nowIso });
  await cancelOverduePaidOrdersAndRefund({ nowIso });
  await cancelOverdueAddOnsOrdersAndRefund({ nowIso });

  const row = db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.listing_id AS listingId,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.status,
              o.paid_at AS paidAt,
              o.delivery_due_at AS deliveryDueAt,
              o.delivered_at AS deliveredAt,
              o.review_ends_at AS reviewEndsAt,
              o.addons_started_at AS addonsStartedAt,
              o.addons_completed_at AS addonsCompletedAt,
              o.addons_due_at AS addonsDueAt,
              o.addons_review_ends_at AS addonsReviewEndsAt,
              o.finalized_reason AS finalizedReason,
              o.finalized_at AS finalizedAt,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_opened_stage AS disputeOpenedStage,
              o.dispute_resolved_at AS disputeResolvedAt,
              o.dispute_reason AS disputeReason,
              o.dispute_other_reason AS disputeOtherReason,
              o.dispute_message AS disputeMessage,
              o.dispute_edited_at AS disputeEditedAt,
              o.seller_more_time_requested_at AS sellerMoreTimeRequestedAt,
              o.seller_more_time_hours AS sellerMoreTimeHours,
              o.buyer_more_time_requested_at AS buyerMoreTimeRequestedAt,
              o.buyer_more_time_hours AS buyerMoreTimeHours,
              o.delivery_zip_url AS deliveryZipUrl,
              o.delivery_zip_filename AS deliveryZipFilename,
              o.delivery_zip_size_bytes AS deliveryZipSizeBytes,
              o.delivery_repo_link AS deliveryRepoLink,
              o.delivery_repo_username AS deliveryRepoUsername,
              o.delivery_repo_email AS deliveryRepoEmail,
              o.delivery_repo_message AS deliveryRepoMessage,
              o.selected_add_ons_json AS selectedAddOnsJson,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.platform_fee_usd AS platformFeeUsd,
              o.total_usd AS totalUsd,
              COALESCE(o.refunded_subtotal_usd, COALESCE(o.refunded_usd, 0)) AS refundedSubtotalUsd,
              COALESCE(o.seller_paid_out_usd, 0) AS sellerPaidOutUsd,
              o.created_at AS createdAt,
              l.title AS listingTitle,
                  l.add_ons_json AS listingAddOnsJson,
              l.delivery_method AS deliveryMethod,
              l.support_days AS supportDays
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });

  if (row.buyerId !== viewerId && row.sellerId !== viewerId)
    return res.status(403).json({ error: 'Not authorized' });

  let orderNumber = String(row.orderNumber ?? '').trim();
  if (!orderNumber) {
    orderNumber = generateUniqueOrderNumber();
    db.prepare(
      `UPDATE orders
          SET order_number = COALESCE(order_number, ?),
              updated_at = updated_at
        WHERE id = ?`,
    ).run(orderNumber, id);
  }

  const viewerRole =
    row.buyerId === viewerId
      ? 'buyer'
      : row.sellerId === viewerId
        ? 'seller'
        : 'other';

  const selectedAddOns = safeJsonParse(row.selectedAddOnsJson, []);
  const hasSelectedAddOns =
    Array.isArray(selectedAddOns) && selectedAddOns.length;

  const listingAddOnsJson = safeJsonParse(row.listingAddOnsJson, {
    addOns: [],
    addOnPrices: {},
    addOnTimes: {},
  });
  const listingAddOnTimes =
    typeof listingAddOnsJson.addOnTimes === 'object' &&
    listingAddOnsJson.addOnTimes
      ? listingAddOnsJson.addOnTimes
      : {};

  const totalAddOnDays = hasSelectedAddOns
    ? Math.max(
        0,
        Math.min(
          365,
          selectedAddOns.reduce((sum, id) => {
            const key = String(id ?? '').trim();
            if (!key) return sum;
            const raw = listingAddOnTimes[key];
            const d = Number.parseInt(String(raw ?? ''), 10);
            const days = Number.isFinite(d) && d > 0 ? d : 7;
            return sum + days;
          }, 0),
        ),
      )
    : 0;

  const createdAtBase = String(row.createdAt || '').trim();
  const deliveredAtBase = String(row.deliveredAt || '').trim();

  let deliveryDueAt = String(row.deliveryDueAt || '').trim() || null;
  if (!deliveryDueAt) {
    deliveryDueAt = addHoursToIso(createdAtBase, 48);
  }

  let reviewEndsAt = String(row.reviewEndsAt || '').trim() || null;
  if (!reviewEndsAt && deliveredAtBase) {
    reviewEndsAt = addHoursToIso(deliveredAtBase, DELIVERY_REVIEW_WINDOW_HOURS);
  }

  let addonsDueAt = String(row.addonsDueAt || '').trim() || null;
  const addonsStartedAt = String(row.addonsStartedAt || '').trim() || null;
  if (!addonsDueAt && addonsStartedAt && totalAddOnDays) {
    addonsDueAt = addDaysToIso(addonsStartedAt, totalAddOnDays);
  }

  const addonsCompletedAt = String(row.addonsCompletedAt || '').trim() || null;
  let addonsReviewEndsAt = String(row.addonsReviewEndsAt || '').trim() || null;
  if (!addonsReviewEndsAt && addonsCompletedAt) {
    addonsReviewEndsAt = addHoursToIso(
      addonsCompletedAt,
      ADDONS_REVIEW_WINDOW_HOURS,
    );
  }

  // Backfill persisted deadlines (legacy orders).
  // Keep updated_at stable by writing updated_at = updated_at.
  try {
    db.prepare(
      `UPDATE orders
          SET delivery_due_at = COALESCE(delivery_due_at, ?),
              -- Only backfill review_ends_at after delivery exists.
              review_ends_at = CASE
                WHEN delivered_at IS NOT NULL AND delivered_at <> '' THEN COALESCE(review_ends_at, ?)
                ELSE review_ends_at
              END,
              addons_due_at = COALESCE(addons_due_at, ?),
              addons_review_ends_at = CASE
                WHEN addons_completed_at IS NOT NULL AND addons_completed_at <> '' THEN COALESCE(addons_review_ends_at, ?)
                ELSE addons_review_ends_at
              END,
              updated_at = updated_at
        WHERE id = ?`,
    ).run(deliveryDueAt, reviewEndsAt, addonsDueAt, addonsReviewEndsAt, id);
  } catch {
    // Best-effort backfill only.
  }

  const subtotalUsd =
    Number(row.listingPriceUsd ?? 0) + Number(row.addOnsTotalUsd ?? 0);

  const refundedSubtotalUsd = Math.max(0, Number(row.refundedSubtotalUsd ?? 0));
  const sellerPaidOutUsd = Math.max(0, Number(row.sellerPaidOutUsd ?? 0));

  const statusLower = String(row.status ?? '').toLowerCase();
  const isCanceled = statusLower === 'canceled' || statusLower === 'cancelled';
  const isFullyRefundedSubtotal =
    subtotalUsd > 0 && refundedSubtotalUsd >= subtotalUsd;
  const buyerDeliveryRestricted =
    viewerRole === 'buyer' && (isCanceled || isFullyRefundedSubtotal);

  const deliveredAtIso = String(row.deliveredAt || '').trim();
  const deliveryVisibleToViewer =
    viewerRole === 'seller' ? true : Boolean(deliveredAtIso);
  const canExposeDelivery = !buyerDeliveryRestricted && deliveryVisibleToViewer;

  const moreTimeRequests = listMoreTimeRequests(id);

  const disputeRows = (() => {
    try {
      return db
        .prepare(
          `SELECT id,
                  stage,
                  opened_at AS openedAt,
                  edited_at AS editedAt,
                  resolved_at AS resolvedAt,
                  reason,
                  other_reason AS otherReason,
                  message,
                  seed_image_message_ids AS seedImageMessageIds
             FROM order_disputes
            WHERE order_id = ?
            ORDER BY opened_at ASC`,
        )
        .all(id);
    } catch {
      // Backwards-compat: older DBs may not have the seed_image_message_ids column yet.
      try {
        return db
          .prepare(
            `SELECT id,
                    stage,
                    opened_at AS openedAt,
                    edited_at AS editedAt,
                    resolved_at AS resolvedAt,
                    reason,
                    other_reason AS otherReason,
                    message
               FROM order_disputes
              WHERE order_id = ?
              ORDER BY opened_at ASC`,
          )
          .all(id);
      } catch {
        return [];
      }
    }
  })();

  const disputes = Array.isArray(disputeRows)
    ? disputeRows.map((d) => ({
        id: String(d.id),
        openedStage: String(d.stage || '').trim() || null,
        openedAt: d.openedAt ? String(d.openedAt) : null,
        editedAt: d.editedAt ? String(d.editedAt) : null,
        resolvedAt: d.resolvedAt ? String(d.resolvedAt) : null,
        reason: d.reason ? String(d.reason) : null,
        otherReason: d.otherReason ? String(d.otherReason) : null,
        message: d.message ? String(d.message) : null,
        seedImageMessageIds: (() => {
          const raw = d.seedImageMessageIds
            ? String(d.seedImageMessageIds)
            : '';
          if (!raw.trim()) return [];
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed)
              ? parsed.map((v) => String(v ?? '').trim()).filter(Boolean)
              : [];
          } catch {
            return [];
          }
        })(),
      }))
    : [];

  return res.json({
    order: {
      id: row.id,
      orderNumber,
      status: row.status,
      viewerRole,
      paidAt: row.paidAt ?? null,
      deliveryDueAt,
      deliveredAt: row.deliveredAt ?? null,
      reviewEndsAt,
      addonsStartedAt: row.addonsStartedAt ?? null,
      addonsCompletedAt: row.addonsCompletedAt ?? null,
      addonsDueAt,
      addonsReviewEndsAt,
      finalizedReason: row.finalizedReason ?? null,
      finalizedAt: row.finalizedAt ?? null,
      dispute: {
        openedAt: row.disputeOpenedAt ?? null,
        openedStage: row.disputeOpenedStage ?? null,
        resolvedAt: row.disputeResolvedAt ?? null,
        editedAt: row.disputeEditedAt ?? null,
        reason: row.disputeReason ?? null,
        otherReason: row.disputeOtherReason ?? null,
        message: row.disputeMessage ?? null,
      },
      disputes,
      moreTime: {
        sellerRequestedAt: row.sellerMoreTimeRequestedAt ?? null,
        sellerHours: row.sellerMoreTimeHours ?? null,
        buyerRequestedAt: row.buyerMoreTimeRequestedAt ?? null,
        buyerHours: row.buyerMoreTimeHours ?? null,
      },
      moreTimeRequests,
      delivery: {
        zipUrl:
          canExposeDelivery && row.deliveryZipUrl
            ? `${getRequestBaseUrl(req)}/api/orders/${encodeURIComponent(
                row.id,
              )}/delivery-zip`
            : null,
        zipFilename: canExposeDelivery
          ? (row.deliveryZipFilename ?? null)
          : null,
        zipSizeBytes:
          canExposeDelivery && Number.isFinite(Number(row.deliveryZipSizeBytes))
            ? Number(row.deliveryZipSizeBytes)
            : null,
        repoLink: canExposeDelivery ? (row.deliveryRepoLink ?? null) : null,
        buyerGithubUsername: canExposeDelivery
          ? (row.deliveryRepoUsername ?? null)
          : null,
        repoEmail: canExposeDelivery ? (row.deliveryRepoEmail ?? null) : null,
        repoMessage: canExposeDelivery
          ? (row.deliveryRepoMessage ?? null)
          : null,
      },
      listing: {
        id: row.listingId,
        title: row.listingTitle,
        priceUsd: row.listingPriceUsd,
        deliveryMethod: row.deliveryMethod,
        supportDays: row.supportDays ?? null,
        addOnTimes: listingAddOnTimes,
      },
      selectedAddOns: Array.isArray(selectedAddOns) ? selectedAddOns : [],
      amounts: {
        listingPriceUsd: row.listingPriceUsd,
        addOnsTotalUsd: row.addOnsTotalUsd,
        subtotalUsd,
        platformFeeUsd: row.platformFeeUsd,
        refundedSubtotalUsd,
        sellerPaidOutUsd,
        ...(viewerRole === 'buyer' ? { totalUsd: row.totalUsd } : {}),
      },
      createdAt: row.createdAt,
    },
  });
}

async function downloadDeliveryZip(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              status,
              delivered_at AS deliveredAt,
              listing_price_usd AS listingPriceUsd,
              add_ons_total_usd AS addOnsTotalUsd,
              COALESCE(refunded_subtotal_usd, COALESCE(refunded_usd, 0)) AS refundedSubtotalUsd,
              delivery_zip_url AS deliveryZipUrl,
              delivery_zip_filename AS deliveryZipFilename
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.buyerId) !== userId && String(row.sellerId) !== userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const isBuyer = String(row.buyerId) === userId;
  if (isBuyer) {
    const deliveredAtIso = String(row.deliveredAt || '').trim();
    if (!deliveredAtIso) {
      return res.status(404).json({ error: 'ZIP not available' });
    }
    const statusLower = String(row.status ?? '').toLowerCase();
    const isCanceled =
      statusLower === 'canceled' || statusLower === 'cancelled';
    const subtotalUsd =
      Number(row.listingPriceUsd ?? 0) + Number(row.addOnsTotalUsd ?? 0);
    const refundedSubtotalUsd = Math.max(
      0,
      Number(row.refundedSubtotalUsd ?? 0),
    );
    const isFullyRefundedSubtotal =
      subtotalUsd > 0 && refundedSubtotalUsd >= subtotalUsd;
    if (isCanceled || isFullyRefundedSubtotal) {
      return res
        .status(403)
        .json({ error: 'Delivery is not available for refunded orders' });
    }
  }

  const zipUrl = String(row.deliveryZipUrl || '').trim();
  if (!zipUrl) return res.status(404).json({ error: 'ZIP not available' });

  const originalName = String(row.deliveryZipFilename || '').trim();
  const filename = toSafeAttachmentFilename(originalName, 'delivery.zip');
  const filenameStar = originalName
    ? encodeURIComponent(originalName.replace(/[\r\n]/g, ' ').trim())
    : '';

  if (String(req.method || '').toUpperCase() === 'HEAD') {
    try {
      const upstreamHeaders = await fetchUrlHeaders(zipUrl);
      const upstreamType = String(upstreamHeaders['content-type'] || '').trim();
      const upstreamLength = String(
        upstreamHeaders['content-length'] || '',
      ).trim();

      res.setHeader('Content-Type', upstreamType || 'application/zip');
      const cd = filenameStar
        ? `attachment; filename="${filename}"; filename*=UTF-8''${filenameStar}`
        : `attachment; filename="${filename}"`;
      res.setHeader('Content-Disposition', cd);
      res.setHeader('Cache-Control', 'private, no-store');
      if (upstreamLength) res.setHeader('Content-Length', upstreamLength);
      return res.status(200).end();
    } catch (e) {
      return res
        .status(502)
        .json({ error: e instanceof Error ? e.message : 'Download failed' });
    }
  }

  try {
    await proxyStreamUrlToResponse(zipUrl, res, {
      onBeforePipe: (upRes) => {
        const upstreamType = String(upRes.headers['content-type'] || '').trim();
        const upstreamLength = String(
          upRes.headers['content-length'] || '',
        ).trim();

        res.setHeader('Content-Type', upstreamType || 'application/zip');
        const cd = filenameStar
          ? `attachment; filename="${filename}"; filename*=UTF-8''${filenameStar}`
          : `attachment; filename="${filename}"`;
        res.setHeader('Content-Disposition', cd);
        res.setHeader('Cache-Control', 'private, no-store');
        if (upstreamLength) res.setHeader('Content-Length', upstreamLength);
      },
    });
  } catch (e) {
    if (!res.headersSent) {
      return res
        .status(502)
        .json({ error: e instanceof Error ? e.message : 'Download failed' });
    }
    // If streaming already started, just terminate.
    try {
      res.end();
    } catch {}
  }
}

async function requestMoreTime(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const hoursRaw = req.body?.hours;
  const hours = Number.parseInt(String(hoursRaw ?? ''), 10);
  // Website UI currently offers +24h, +72h, +120h options.
  // Keep legacy +36h/+48h support for compatibility.
  if (![24, 36, 48, 72, 120].includes(hours)) {
    return res
      .status(400)
      .json({ error: 'hours must be 24, 36, 48, 72, or 120' });
  }

  const row = db
    .prepare(
      `SELECT o.id,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.status,
              o.created_at AS createdAt,
              o.paid_at AS paidAt,
              o.delivery_due_at AS deliveryDueAt,
              o.delivered_at AS deliveredAt,
              o.review_ends_at AS reviewEndsAt,
              o.addons_review_ends_at AS addonsReviewEndsAt,
              o.addons_started_at AS addonsStartedAt,
              o.addons_completed_at AS addonsCompletedAt,
              o.addons_due_at AS addonsDueAt,
              o.selected_add_ons_json AS selectedAddOnsJson,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_resolved_at AS disputeResolvedAt,
              o.seller_more_time_requested_at AS sellerMoreTimeRequestedAt,
              o.buyer_more_time_requested_at AS buyerMoreTimeRequestedAt,
              l.title AS listingTitle,
              l.add_ons_json AS listingAddOnsJson
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (row.buyerId !== userId && row.sellerId !== userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const status = String(row.status ?? '').toLowerCase();
  const now = new Date().toISOString();

  const isSeller = row.sellerId === userId;
  const isBuyer = row.buyerId === userId;

  const hasOpenDispute = Boolean(
    String(row.disputeOpenedAt || '').trim() &&
    !String(row.disputeResolvedAt || '').trim(),
  );
  if (hasOpenDispute) {
    return res
      .status(400)
      .json({ error: 'Resolve dispute before requesting more time' });
  }

  if (
    status === 'completed' ||
    status === 'canceled' ||
    status === 'cancelled'
  ) {
    return res.status(400).json({ error: 'Order is already finalized' });
  }

  const selectedAddOns = safeJsonParse(row.selectedAddOnsJson, []);
  const hasSelectedAddOns =
    Array.isArray(selectedAddOns) && selectedAddOns.length;

  const listingAddOnsJson = safeJsonParse(row.listingAddOnsJson, {
    addOns: [],
    addOnPrices: {},
    addOnTimes: {},
  });
  const listingAddOnTimes =
    typeof listingAddOnsJson.addOnTimes === 'object' &&
    listingAddOnsJson.addOnTimes
      ? listingAddOnsJson.addOnTimes
      : {};

  const totalAddOnDays = hasSelectedAddOns
    ? Math.max(
        0,
        Math.min(
          365,
          selectedAddOns.reduce((sum, addOnId) => {
            const key = String(addOnId ?? '').trim();
            if (!key) return sum;
            const raw = listingAddOnTimes[key];
            const d = Number.parseInt(String(raw ?? ''), 10);
            const days = Number.isFinite(d) && d > 0 ? d : 7;
            return sum + days;
          }, 0),
        ),
      )
    : 0;

  const addonsStartedAt = String(row.addonsStartedAt || '').trim();
  const addonsCompletedAt = String(row.addonsCompletedAt || '').trim();
  const addonsReviewEndsAt = String(row.addonsReviewEndsAt || '').trim();
  const inAddOnsStage =
    (status === 'addons' || (!!addonsStartedAt && !addonsCompletedAt)) &&
    !addonsCompletedAt;
  const inAddOnsReviewStage =
    status === 'addons_waiting_approval' && !!addonsCompletedAt;

  const inReviewStage = status === 'delivered';

  let stage = 'delivery';
  if (inAddOnsReviewStage) stage = 'addons_review';
  else if (inAddOnsStage) stage = 'addons';
  else if (inReviewStage) stage = 'review';

  const requesterRole = getMoreTimeRequesterRole(stage);
  if (!requesterRole) {
    return res.status(400).json({ error: 'Invalid request stage' });
  }

  // Enforce the per-stage 2-request limit.
  // Each stage is requestable by only one side, so requesterRole is a stable key.
  const requestCountRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt
         FROM order_more_time_requests
        WHERE order_id = ? AND stage = ? AND requester_role = ?`,
    )
    .get(id, stage, requesterRole);
  const priorCount = Number(requestCountRow?.cnt ?? 0);
  if (priorCount >= 2) {
    return res
      .status(400)
      .json({ error: 'Request limit reached for this stage' });
  }

  const requesterId = userId;
  const requestId = newId('more_time');

  const insertRequest = (fields) => {
    db.prepare(
      `INSERT INTO order_more_time_requests (
          id,
          order_id,
          stage,
          requester_id,
          requester_role,
          hours,
          status,
          created_at,
          decided_at,
          decided_by_id,
          decided_by_role,
          applied_at,
          deadline_before_iso,
          deadline_after_iso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      requestId,
      id,
      stage,
      requesterId,
      requesterRole,
      hours,
      fields.status,
      now,
      fields.decidedAt,
      fields.decidedById,
      fields.decidedByRole,
      fields.appliedAt,
      fields.deadlineBeforeIso,
      fields.deadlineAfterIso,
    );
  };

  if (inAddOnsStage) {
    if (!isSeller) {
      return res
        .status(403)
        .json({ error: 'Only the seller can request more time for add-ons' });
    }
    if (!totalAddOnDays) {
      return res.status(400).json({ error: 'No add-ons are in progress' });
    }

    const base =
      String(row.addonsDueAt || '').trim() ||
      addDaysToIso(addonsStartedAt || row.createdAt, totalAddOnDays);
    const nextDue = addHoursToIso(base, hours);
    if (!nextDue) {
      return res.status(500).json({ error: 'Could not compute new deadline' });
    }

    db.prepare(
      `UPDATE orders
          SET addons_due_at = ?,
              seller_more_time_requested_at = ?,
              seller_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(nextDue, now, hours, now, id);

    insertRequest({
      status: 'applied',
      decidedAt: now,
      decidedById: requesterId,
      decidedByRole: requesterRole,
      appliedAt: now,
      deadlineBeforeIso: base,
      deadlineAfterIso: nextDue,
    });

    return res.json({
      ok: true,
      order: { id, addonsDueAt: nextDue },
    });
  }

  if (inAddOnsReviewStage) {
    if (!isBuyer) {
      return res.status(403).json({
        error: 'Only the buyer can request more time during add-ons review',
      });
    }

    const base =
      addonsReviewEndsAt ||
      (addonsCompletedAt
        ? addHoursToIso(addonsCompletedAt, ADDONS_REVIEW_WINDOW_HOURS)
        : null);
    if (!base) {
      return res.status(400).json({
        error: 'Add-ons review window has not started yet',
      });
    }

    const nextEnds = addHoursToIso(base, hours);
    if (!nextEnds) {
      return res.status(500).json({ error: 'Could not compute new deadline' });
    }

    db.prepare(
      `UPDATE orders
          SET addons_review_ends_at = ?,
              buyer_more_time_requested_at = ?,
              buyer_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(nextEnds, now, hours, now, id);

    insertRequest({
      status: 'applied',
      decidedAt: now,
      decidedById: requesterId,
      decidedByRole: requesterRole,
      appliedAt: now,
      deadlineBeforeIso: base,
      deadlineAfterIso: nextEnds,
    });

    return res.json({
      ok: true,
      order: { id, addonsReviewEndsAt: nextEnds },
    });
  }

  if (inReviewStage) {
    if (!isBuyer) {
      return res
        .status(403)
        .json({ error: 'Only the buyer can request more time during review' });
    }

    const deliveredAt = String(row.deliveredAt || '').trim();
    const base =
      String(row.reviewEndsAt || '').trim() ||
      (deliveredAt ? addHoursToIso(deliveredAt, 48) : null);
    if (!base) {
      return res
        .status(400)
        .json({ error: 'Review window has not started yet' });
    }
    const nextEnds = addHoursToIso(base, hours);
    if (!nextEnds) {
      return res.status(500).json({ error: 'Could not compute new deadline' });
    }

    db.prepare(
      `UPDATE orders
          SET review_ends_at = ?,
              buyer_more_time_requested_at = ?,
              buyer_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(nextEnds, now, hours, now, id);

    insertRequest({
      status: 'applied',
      decidedAt: now,
      decidedById: requesterId,
      decidedByRole: requesterRole,
      appliedAt: now,
      deadlineBeforeIso: base,
      deadlineAfterIso: nextEnds,
    });

    return res.json({
      ok: true,
      order: { id, reviewEndsAt: nextEnds },
    });
  }

  // Default: delivery stage.
  if (!isSeller) {
    return res
      .status(403)
      .json({ error: 'Only the seller can request more time before delivery' });
  }

  if (status !== 'paid' && status !== 'pending_payment') {
    return res
      .status(400)
      .json({ error: 'More time can only be requested during delivery' });
  }

  const base =
    String(row.deliveryDueAt || '').trim() ||
    addHoursToIso(String(row.createdAt || '').trim(), 48);
  const nextDue = addHoursToIso(base, hours);
  if (!nextDue) {
    return res.status(500).json({ error: 'Could not compute new deadline' });
  }

  // Final (2nd) request applies immediately, same as the first.

  db.prepare(
    `UPDATE orders
        SET delivery_due_at = ?,
            seller_more_time_requested_at = ?,
            seller_more_time_hours = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(nextDue, now, hours, now, id);

  insertRequest({
    status: 'applied',
    decidedAt: now,
    decidedById: requesterId,
    decidedByRole: requesterRole,
    appliedAt: now,
    deadlineBeforeIso: base,
    deadlineAfterIso: nextDue,
  });

  return res.json({
    ok: true,
    order: { id, deliveryDueAt: nextDue },
  });

  return res.status(403).json({ error: 'Not authorized' });
}

async function approveMoreTimeRequest(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.id ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });

  const requestId = String(req.params?.requestId ?? '').trim();
  if (!requestId)
    return res.status(400).json({ error: 'Request id is required' });

  const row = db
    .prepare(
      `SELECT o.id,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.status,
              o.created_at AS createdAt,
              o.delivered_at AS deliveredAt,
              o.addons_started_at AS addonsStartedAt,
              o.addons_completed_at AS addonsCompletedAt,
              o.selected_add_ons_json AS selectedAddOnsJson,
              o.delivery_due_at AS deliveryDueAt,
              o.review_ends_at AS reviewEndsAt,
              o.addons_review_ends_at AS addonsReviewEndsAt,
              o.addons_due_at AS addonsDueAt,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_resolved_at AS disputeResolvedAt,
              l.add_ons_json AS listingAddOnsJson
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (row.buyerId !== userId && row.sellerId !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const statusLower = String(row.status ?? '').toLowerCase();
  if (
    statusLower === 'completed' ||
    statusLower === 'canceled' ||
    statusLower === 'cancelled'
  ) {
    return res.status(400).json({ error: 'Order is already finalized' });
  }

  const hasOpenDispute = Boolean(
    String(row.disputeOpenedAt || '').trim() &&
    !String(row.disputeResolvedAt || '').trim(),
  );
  if (hasOpenDispute) {
    return res
      .status(400)
      .json({ error: 'Resolve dispute before approving more time' });
  }

  const reqRow = db
    .prepare(
      `SELECT id,
              stage,
              requester_id AS requesterId,
              requester_role AS requesterRole,
              hours,
              status,
              created_at AS createdAt,
              deadline_before_iso AS deadlineBeforeIso,
              deadline_after_iso AS deadlineAfterIso
         FROM order_more_time_requests
        WHERE id = ? AND order_id = ?
        LIMIT 1`,
    )
    .get(requestId, orderId);

  if (!reqRow) return res.status(404).json({ error: 'Not Found' });
  if (String(reqRow.status || '').toLowerCase() !== 'pending') {
    return res.status(400).json({ error: 'Request is not pending' });
  }

  const stage = toMoreTimeStageKey(reqRow.stage);
  if (!stage) return res.status(400).json({ error: 'Invalid request stage' });

  const approverRole = getMoreTimeApproverRole(stage);
  if (!approverRole) return res.status(400).json({ error: 'Invalid stage' });

  const isApprover =
    (approverRole === 'buyer' && row.buyerId === userId) ||
    (approverRole === 'seller' && row.sellerId === userId);
  if (!isApprover) {
    return res.status(403).json({ error: 'Not authorized to approve' });
  }

  const afterIso = String(reqRow.deadlineAfterIso || '').trim();
  if (!afterIso) {
    return res.status(400).json({ error: 'Request is missing deadline' });
  }

  // Validate stage is still relevant.
  const deliveredAt = String(row.deliveredAt || '').trim();
  const addonsStartedAt = String(row.addonsStartedAt || '').trim();
  const addonsCompletedAt = String(row.addonsCompletedAt || '').trim();

  if (stage === 'delivery') {
    if (deliveredAt) {
      return res.status(400).json({ error: 'Order is already delivered' });
    }
    if (statusLower !== 'paid' && statusLower !== 'pending_payment') {
      return res
        .status(400)
        .json({ error: 'Delivery stage is no longer active' });
    }
  }

  if (stage === 'review') {
    if (!deliveredAt) {
      return res
        .status(400)
        .json({ error: 'Review window has not started yet' });
    }
  }

  if (stage === 'addons') {
    const selectedAddOns = safeJsonParse(row.selectedAddOnsJson, []);
    const hasSelectedAddOns =
      Array.isArray(selectedAddOns) && selectedAddOns.length;
    const listingAddOnsJson = safeJsonParse(row.listingAddOnsJson, {
      addOns: [],
      addOnPrices: {},
      addOnTimes: {},
    });
    const listingAddOnTimes =
      typeof listingAddOnsJson.addOnTimes === 'object' &&
      listingAddOnsJson.addOnTimes
        ? listingAddOnsJson.addOnTimes
        : {};
    const totalAddOnDays = hasSelectedAddOns
      ? Math.max(
          0,
          Math.min(
            365,
            selectedAddOns.reduce((sum, addOnId) => {
              const key = String(addOnId ?? '').trim();
              if (!key) return sum;
              const raw = listingAddOnTimes[key];
              const d = Number.parseInt(String(raw ?? ''), 10);
              const days = Number.isFinite(d) && d > 0 ? d : 7;
              return sum + days;
            }, 0),
          ),
        )
      : 0;

    const inAddOnsStage =
      (statusLower.startsWith('addons') || !!addonsStartedAt) &&
      !addonsCompletedAt;
    if (!inAddOnsStage || !totalAddOnDays) {
      return res.status(400).json({ error: 'Add-ons are not in progress' });
    }
  }

  if (stage === 'addons_review') {
    if (statusLower !== 'addons_waiting_approval' || !addonsCompletedAt) {
      return res
        .status(400)
        .json({ error: 'Add-ons review is no longer pending' });
    }
  }

  const now = new Date().toISOString();

  if (stage === 'delivery') {
    db.prepare(
      `UPDATE orders
          SET delivery_due_at = ?,
              seller_more_time_requested_at = ?,
              seller_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(afterIso, now, reqRow.hours, now, orderId);
  } else if (stage === 'review') {
    db.prepare(
      `UPDATE orders
          SET review_ends_at = ?,
              buyer_more_time_requested_at = ?,
              buyer_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(afterIso, now, reqRow.hours, now, orderId);
  } else if (stage === 'addons') {
    db.prepare(
      `UPDATE orders
          SET addons_due_at = ?,
              seller_more_time_requested_at = ?,
              seller_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(afterIso, now, reqRow.hours, now, orderId);
  } else {
    db.prepare(
      `UPDATE orders
          SET addons_review_ends_at = ?,
              buyer_more_time_requested_at = ?,
              buyer_more_time_hours = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(afterIso, now, reqRow.hours, now, orderId);
  }

  db.prepare(
    `UPDATE order_more_time_requests
        SET status = 'approved',
            decided_at = ?,
            decided_by_id = ?,
            decided_by_role = ?,
            applied_at = COALESCE(applied_at, ?)
      WHERE id = ? AND order_id = ? AND status = 'pending'`,
  ).run(now, userId, approverRole, now, requestId, orderId);

  return res.json({ ok: true });
}

async function declineMoreTimeRequest(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.id ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });

  const requestId = String(req.params?.requestId ?? '').trim();
  if (!requestId)
    return res.status(400).json({ error: 'Request id is required' });

  const orderRow = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              status,
              dispute_opened_at AS disputeOpenedAt,
              dispute_resolved_at AS disputeResolvedAt
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!orderRow) return res.status(404).json({ error: 'Not Found' });
  if (orderRow.buyerId !== userId && orderRow.sellerId !== userId)
    return res.status(403).json({ error: 'Not authorized' });

  const statusLower = String(orderRow.status ?? '').toLowerCase();
  if (
    statusLower === 'completed' ||
    statusLower === 'canceled' ||
    statusLower === 'cancelled'
  ) {
    return res.status(400).json({ error: 'Order is already finalized' });
  }

  const hasOpenDispute = Boolean(
    String(orderRow.disputeOpenedAt || '').trim() &&
    !String(orderRow.disputeResolvedAt || '').trim(),
  );
  if (hasOpenDispute) {
    return res
      .status(400)
      .json({ error: 'Resolve dispute before declining more time' });
  }

  const reqRow = db
    .prepare(
      `SELECT id,
              stage,
              status
         FROM order_more_time_requests
        WHERE id = ? AND order_id = ?
        LIMIT 1`,
    )
    .get(requestId, orderId);

  if (!reqRow) return res.status(404).json({ error: 'Not Found' });
  if (String(reqRow.status || '').toLowerCase() !== 'pending') {
    return res.status(400).json({ error: 'Request is not pending' });
  }

  const stage = toMoreTimeStageKey(reqRow.stage);
  if (!stage) return res.status(400).json({ error: 'Invalid request stage' });

  const approverRole = getMoreTimeApproverRole(stage);
  if (!approverRole) return res.status(400).json({ error: 'Invalid stage' });

  const isApprover =
    (approverRole === 'buyer' && orderRow.buyerId === userId) ||
    (approverRole === 'seller' && orderRow.sellerId === userId);
  if (!isApprover) {
    return res.status(403).json({ error: 'Not authorized to decline' });
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE order_more_time_requests
        SET status = 'declined',
            decided_at = ?,
            decided_by_id = ?,
            decided_by_role = ?
      WHERE id = ? AND order_id = ? AND status = 'pending'`,
  ).run(now, userId, approverRole, requestId, orderId);

  return res.json({ ok: true });
}

async function openDispute(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const row = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId,
              seller_id AS sellerId,
              listing_id AS listingId,
              status,
              dispute_opened_at AS disputeOpenedAt,
              dispute_opened_stage AS disputeOpenedStage,
              dispute_edited_at AS disputeEditedAt
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.buyerId) !== userId)
    return res.status(403).json({ error: 'Only the buyer can open a dispute' });

  const status = String(row.status ?? '').toLowerCase();
  if (status === 'completed') {
    return res.status(400).json({ error: 'Order is already completed' });
  }

  const reasonRaw =
    typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const otherReasonRaw =
    typeof req.body?.otherReason === 'string'
      ? req.body.otherReason.trim()
      : '';
  const messageRaw =
    typeof req.body?.message === 'string' ? req.body.message.trim() : '';

  const markEdited =
    req.body?.markEdited === true || String(req.body?.markEdited) === 'true';

  const allowedReasons = new Set([
    '',
    'delivery_issue',
    'files_missing',
    'not_as_described',
    'cannot_run',
    'seller_unresponsive',
    'late_delivery',
    'other',
  ]);

  if (!allowedReasons.has(reasonRaw)) {
    return res.status(400).json({ error: 'Invalid dispute reason' });
  }

  if (messageRaw.length > 2000) {
    return res.status(400).json({ error: 'Message is too long' });
  }

  const now = new Date().toISOString();
  const openedStageRaw =
    typeof req.body?.openedStage === 'string'
      ? req.body.openedStage.trim()
      : '';
  const allowedOpenedStages = new Set(['', 'approve', 'addons', 'delivery']);
  if (!allowedOpenedStages.has(openedStageRaw)) {
    return res.status(400).json({ error: 'Invalid openedStage' });
  }

  // Normalize stage to exactly two dispute buckets.
  // - approve/delivery/empty => delivery dispute
  // - addons => add-ons dispute
  const disputeStage =
    String(openedStageRaw || '')
      .trim()
      .toLowerCase() === 'addons'
      ? 'addons'
      : 'delivery';

  const existingOpen = db
    .prepare(
      `SELECT id,
              stage,
              opened_at AS openedAt,
              edited_at AS editedAt,
              resolved_at AS resolvedAt,
              reason,
              other_reason AS otherReason,
              message
         FROM order_disputes
        WHERE order_id = ?
          AND stage = ?
          AND resolved_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1`,
    )
    .get(id, disputeStage);

  const shouldSetEditedAt =
    markEdited &&
    !!existingOpen?.id &&
    !!String(existingOpen.openedAt || '').trim() &&
    !String(existingOpen.editedAt || '').trim();

  const editedAt = shouldSetEditedAt ? now : null;

  let disputeId = existingOpen?.id ? String(existingOpen.id) : null;
  let openedAt = existingOpen?.openedAt ? String(existingOpen.openedAt) : now;

  if (!existingOpen?.id) {
    disputeId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : require('crypto').randomUUID();

    db.prepare(
      `INSERT INTO order_disputes (
          id,
          order_id,
          stage,
          opened_at,
          edited_at,
          resolved_at,
          reason,
          other_reason,
          message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      disputeId,
      id,
      disputeStage,
      openedAt,
      reasonRaw || null,
      otherReasonRaw || null,
      messageRaw || null,
      openedAt,
      openedAt,
    );
  } else if (markEdited) {
    // Update the current open dispute for this stage (no-op for empty fields).
    db.prepare(
      `UPDATE order_disputes
          SET reason = COALESCE(NULLIF(?, ''), reason),
              other_reason = COALESCE(NULLIF(?, ''), other_reason),
              message = COALESCE(NULLIF(?, ''), message),
              edited_at = COALESCE(edited_at, ?),
              updated_at = ?
        WHERE id = ? AND order_id = ? AND resolved_at IS NULL`,
    ).run(reasonRaw, otherReasonRaw, messageRaw, editedAt, now, disputeId, id);
  }

  // Keep legacy order-level dispute fields as "current dispute".
  // This preserves existing UI + dashboard logic, while history lives in order_disputes.
  db.prepare(
    `UPDATE orders
        SET dispute_opened_at = ?,
            dispute_opened_stage = ?,
            dispute_resolved_at = NULL,
            dispute_reason = COALESCE(NULLIF(?, ''), dispute_reason),
            dispute_other_reason = COALESCE(NULLIF(?, ''), dispute_other_reason),
            dispute_message = COALESCE(NULLIF(?, ''), dispute_message),
            dispute_edited_at = COALESCE(dispute_edited_at, ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(
    openedAt,
    disputeStage,
    reasonRaw,
    otherReasonRaw,
    messageRaw,
    editedAt,
    now,
    id,
  );

  // Create/get stage-specific dispute thread.
  const existingThread = db
    .prepare(
      `SELECT id
         FROM message_threads
        WHERE kind = 'dispute'
          AND order_id = ?
          AND COALESCE(NULLIF(dispute_stage, ''), 'delivery') = ?
        LIMIT 1`,
    )
    .get(id, disputeStage);

  let threadId = existingThread?.id ? String(existingThread.id) : null;
  if (!threadId) {
    threadId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : require('crypto').randomUUID();

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
          updated_at
       ) VALUES (?, ?, ?, ?, 'dispute', ?, ?, ?, ?)`,
    ).run(
      threadId,
      String(row.listingId),
      String(row.buyerId),
      String(row.sellerId),
      id,
      disputeStage,
      now,
      now,
    );
  }

  // Notify seller once per newly created stage dispute.
  if (!existingOpen?.id) {
    try {
      createNotification({
        userId: String(row.sellerId),
        type: 'seller.dispute_opened',
        title: 'Dispute opened',
        detail: 'A buyer opened a dispute on an order.',
        entityType: 'order',
        entityId: id,
        data: { orderId: id, stage: disputeStage },
      });
    } catch {
      // Best-effort notification.
    }
  }

  return res.json({
    ok: true,
    dispute: {
      id: disputeId,
      openedAt,
      openedStage: disputeStage,
      editedAt:
        (existingOpen?.editedAt ? String(existingOpen.editedAt) : null) ||
        editedAt ||
        null,
      reason: reasonRaw || existingOpen?.reason || null,
      otherReason: otherReasonRaw || existingOpen?.otherReason || null,
      message: messageRaw || existingOpen?.message || null,
    },
    thread: { id: threadId },
  });
}

function cancelDispute(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const id = String(req.params?.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Order id is required' });

  const normalizeDisputeStage = (input) => {
    const v = String(input ?? '')
      .trim()
      .toLowerCase();
    return v === 'addons' ? 'addons' : 'delivery';
  };

  const requestedStage = normalizeDisputeStage(req.body?.stage);

  const row = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId,
              status,
              dispute_opened_at AS disputeOpenedAt,
              dispute_opened_stage AS disputeOpenedStage
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.buyerId) !== userId)
    return res
      .status(403)
      .json({ error: 'Only the buyer can cancel a dispute' });

  const status = String(row.status ?? '').toLowerCase();
  if (status === 'completed') {
    return res.status(400).json({ error: 'Order is already completed' });
  }

  // Idempotent: if no dispute is open, just return ok.
  if (!String(row.disputeOpenedAt || '').trim()) {
    return res.json({ ok: true });
  }

  // Do NOT delete dispute history; resolve it so the record + thread can persist.
  const now = new Date().toISOString();

  const stageToResolve = req.body?.stage
    ? requestedStage
    : normalizeDisputeStage(row.disputeOpenedStage);

  // Resolve the stage-specific dispute record (history), best-effort.
  db.prepare(
    `UPDATE order_disputes
        SET resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
      WHERE order_id = ?
        AND stage = ?
        AND resolved_at IS NULL`,
  ).run(now, now, id, stageToResolve);

  db.prepare(
    `UPDATE orders
        SET dispute_resolved_at = COALESCE(dispute_resolved_at, ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(now, now, id);

  return res.json({ ok: true, resolvedAt: now, stage: stageToResolve });
}

function setDisputeSeedImages(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(req.params?.id ?? '').trim();
  if (!orderId) return res.status(400).json({ error: 'Order id is required' });

  const disputeId = String(req.params?.disputeId ?? '').trim();
  if (!disputeId)
    return res.status(400).json({ error: 'Dispute id is required' });

  const idsRaw = req.body?.messageIds;
  const messageIds = Array.isArray(idsRaw)
    ? idsRaw.map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];

  if (messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds are required' });
  }

  if (messageIds.length > 10) {
    return res.status(400).json({ error: 'Too many messageIds' });
  }

  const row = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId,
              seller_id AS sellerId
         FROM orders
        WHERE id = ?
        LIMIT 1`,
    )
    .get(orderId);

  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.buyerId) !== userId) {
    return res
      .status(403)
      .json({ error: 'Only the buyer can finalize dispute screenshots' });
  }

  const disputeRow = db
    .prepare(
      `SELECT id,
              stage,
              seed_image_message_ids AS seedImageMessageIds
         FROM order_disputes
        WHERE id = ?
          AND order_id = ?
        LIMIT 1`,
    )
    .get(disputeId, orderId);

  if (!disputeRow) {
    return res.status(404).json({ error: 'Dispute not found' });
  }

  const stage = String(disputeRow.stage ?? '')
    .trim()
    .toLowerCase();
  const disputeStage = stage === 'addons' ? 'addons' : 'delivery';

  // Idempotent: do not overwrite once set.
  const existingRaw = String(disputeRow.seedImageMessageIds ?? '').trim();
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw);
      const existing = Array.isArray(parsed)
        ? parsed.map((v) => String(v ?? '').trim()).filter(Boolean)
        : [];
      return res.json({ ok: true, seedImageMessageIds: existing });
    } catch {
      // If existing value is corrupt, allow a one-time repair.
    }
  }

  // Find the dispute thread id for this stage/order.
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

  const threadId = threadRow?.id ? String(threadRow.id).trim() : '';
  if (!threadId) {
    return res.status(400).json({ error: 'Dispute thread not found' });
  }

  // Validate provided ids belong to the thread and are buyer image-only messages.
  // (Prevents later/manual messages from being hoisted.)
  const placeholders = messageIds.map(() => '?').join(',');
  const rowsFound = db
    .prepare(
      `SELECT id
         FROM message_thread_messages
        WHERE thread_id = ?
          AND sender_id = ?
          AND id IN (${placeholders})
          AND COALESCE(NULLIF(TRIM(body), ''), '') = ''
          AND COALESCE(NULLIF(TRIM(image_url), ''), '') <> ''`,
    )
    .all(threadId, String(row.buyerId), ...messageIds);

  const validIds = Array.isArray(rowsFound)
    ? rowsFound.map((r) => String(r.id ?? '').trim()).filter(Boolean)
    : [];

  if (validIds.length === 0) {
    return res.status(400).json({ error: 'No valid seed images found' });
  }

  const uniqueIds = Array.from(new Set(validIds));
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE order_disputes
        SET seed_image_message_ids = ?,
            updated_at = ?
      WHERE id = ? AND order_id = ?`,
  ).run(JSON.stringify(uniqueIds), now, disputeId, orderId);

  return res.json({ ok: true, seedImageMessageIds: uniqueIds });
}

module.exports = {
  createOrder,
  getOrder,
  finalizePaidOrder,
  finalizePaidOrderFromPaymentIntent,
  markDelivered,
  uploadDeliveryZipDraft,
  updateDeliveryRepoDraft,
  createDeliveryZipUploadSignature,
  downloadDeliveryZip,
  downloadReceiptPdf,
  markCompleted,
  markAddOnsCompleted,
  requestMoreTime,
  approveMoreTimeRequest,
  declineMoreTimeRequest,
  openDispute,
  cancelDispute,
  setDisputeSeedImages,
  runOrderTimersTick,
};
