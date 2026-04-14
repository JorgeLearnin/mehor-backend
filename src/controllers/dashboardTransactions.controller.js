'use strict';

const { db } = require('../db/db');
const { getPaginationParams, escapeLike } = require('../utils/pagination');

function clampNumber(n, { min = 0, max = 1_000_000_000 } = {}) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function listDashboardTransactions(req, res) {
  const dashboardUserId = String(req.dashboardUser?.id ?? '').trim();
  if (!dashboardUserId)
    return res.status(401).json({ error: 'Not authenticated' });

  const qRaw = typeof req.query?.q === 'string' ? req.query.q : '';
  const q = qRaw.trim().toLowerCase();
  const { page, limit, offset } = getPaginationParams(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
  });

  let where = `LOWER(o.status) IN ('completed', 'canceled', 'cancelled')
          AND (
            o.dispute_opened_at IS NULL OR o.dispute_resolved_at IS NOT NULL
          )`;
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
            OR LOWER(CASE
                WHEN COALESCE(o.refunded_subtotal_usd, COALESCE(o.refunded_usd, 0)) >= COALESCE(o.listing_price_usd, 0) + COALESCE(o.add_ons_total_usd, 0) THEN 'canceled'
                WHEN COALESCE(o.refunded_subtotal_usd, COALESCE(o.refunded_usd, 0)) > 0 THEN 'part-refunded'
                ELSE 'completed'
              END) LIKE LOWER(?) ESCAPE '\\'
          )`;
    args = [like, like, like, like, like, like, like, like, like];
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
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              COALESCE(o.refunded_subtotal_usd, COALESCE(o.refunded_usd, 0)) AS refundedSubtotalUsd,
              o.dispute_opened_at AS disputeOpenedAt,
              o.dispute_resolved_at AS disputeResolvedAt,
              o.created_at AS createdAt,
              o.paid_at AS paidAt,
              o.updated_at AS updatedAt,
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
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const transactions = rows.map((r) => {
    const listingPriceUsd = clampNumber(r.listingPriceUsd, { min: 0 });
    const addOnsTotalUsd = clampNumber(r.addOnsTotalUsd, { min: 0 });
    const subtotalUsd = clampNumber(listingPriceUsd + addOnsTotalUsd, {
      min: 0,
    });

    const refundedSubtotalUsd = clampNumber(r.refundedSubtotalUsd, { min: 0 });
    const refundedSubtotalClamped = Math.min(subtotalUsd, refundedSubtotalUsd);

    const transactionStatus =
      subtotalUsd > 0 && refundedSubtotalClamped >= subtotalUsd
        ? 'canceled'
        : refundedSubtotalClamped > 0
          ? 'part-refunded'
          : 'completed';

    return {
      orderId: String(r.orderId),
      orderNumber: r.orderNumber ?? null,
      orderStatus: r.orderStatus ?? null,
      transactionStatus,
      createdAt: r.createdAt ?? null,
      paidAt: r.paidAt ?? null,
      updatedAt: r.updatedAt ?? null,
      subtotalUsd,
      refundedSubtotalUsd: refundedSubtotalClamped,
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
      dispute: {
        openedAt: r.disputeOpenedAt ?? null,
        resolvedAt: r.disputeResolvedAt ?? null,
      },
    };
  });

  return res.json({ transactions, total, page, limit });
}

module.exports = { listDashboardTransactions };
