'use strict';

const crypto = require('crypto');
const { db } = require('../db/db');
const {
  getSellerPlatformFeeBps,
  getBuyerServiceFeeBps,
  computeFeeUsd,
} = require('./fees');

function safeJsonParse(text, fallback) {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toInt(value, { min = 0, max = 1_000_000 } = {}) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function computeOrderTotals({ listingPriceUsd, selectedAddOnIds, addOnsJson }) {
  const addOns = Array.isArray(addOnsJson?.addOns) ? addOnsJson.addOns : [];
  const addOnPrices =
    typeof addOnsJson?.addOnPrices === 'object' && addOnsJson.addOnPrices
      ? addOnsJson.addOnPrices
      : {};

  const allowed = new Set(
    addOns.map((a) => String(a ?? '').trim()).filter(Boolean),
  );

  const picked = Array.isArray(selectedAddOnIds)
    ? selectedAddOnIds
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
        .filter((id) => allowed.has(id))
        .slice(0, 25)
    : [];

  const addOnsTotalUsd = picked.reduce((sum, id) => {
    const priceRaw = addOnPrices[id];
    const price = toInt(priceRaw, { min: 0, max: 100_000 });
    return sum + (price ?? 0);
  }, 0);

  const subtotal = listingPriceUsd + addOnsTotalUsd;
  const sellerPlatformFeeBps = getSellerPlatformFeeBps();
  const buyerServiceFeeBps = getBuyerServiceFeeBps();

  const platformFeeUsd = computeFeeUsd({
    amountUsd: subtotal,
    feeBps: sellerPlatformFeeBps,
  });
  const serviceFeeUsd = computeFeeUsd({
    amountUsd: subtotal,
    feeBps: buyerServiceFeeBps,
  });

  // Buyer pays subtotal + service fee; seller platform fee is withheld from seller payout.
  const totalUsd = subtotal + serviceFeeUsd;

  return {
    selectedAddOns: picked,
    addOnsTotalUsd,
    sellerPlatformFeeBps,
    buyerServiceFeeBps,
    platformFeeUsd,
    serviceFeeUsd,
    totalUsd,
  };
}

function generateUniqueOrderNumber() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = crypto.randomInt(0, 100_000_000);
    const orderNumber = String(n).padStart(8, '0');
    const exists = db
      .prepare(`SELECT 1 FROM orders WHERE order_number = ? LIMIT 1`)
      .get(orderNumber);
    if (!exists) return orderNumber;
  }
  throw new Error('Failed to generate unique order number');
}

function addDaysToIso(iso, days) {
  const baseMs = Date.parse(String(iso || ''));
  if (!Number.isFinite(baseMs)) return null;
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return null;
  const ms = baseMs + Math.floor(d) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function getAddOnIncludedDays(addOnId) {
  const key = String(addOnId ?? '').trim();
  if (!key) return 0;

  // Keep in sync with website add-on meta.
  if (key === 'deployment-assistance') return 5;
  if (key === 'customization-requests') return 7;
  if (key === 'setup-walkthrough') return 7;
  if (key === 'third-party-services') return 7;
  if (key === 'branding-replacement') return 7;
  if (key === 'additional-pages') return 7;
  if (key === 'seo-setup') return 7;
  if (key === 'domain-connection') return 7;
  if (key === 'extended-maintenance') return 7;

  return 7;
}

function computeSelectedAddOnsTotalDays(selectedAddOns) {
  const ids = Array.isArray(selectedAddOns)
    ? selectedAddOns
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
        .slice(0, 25)
    : [];

  const total = ids.reduce((sum, id) => sum + getAddOnIncludedDays(id), 0);
  return Math.max(0, Math.min(365, total));
}

function completeExpiredReviewOrders({ nowIso } = {}) {
  const now = String(nowIso || new Date().toISOString()).trim();
  if (!now) return { completedCount: 0 };

  const due = db
    .prepare(
      `SELECT id,
              listing_id AS listingId,
              selected_add_ons_json AS selectedAddOnsJson
         FROM orders
        WHERE status = 'delivered'
          AND review_ends_at IS NOT NULL
          AND review_ends_at <= ?
          AND dispute_opened_at IS NULL`,
    )
    .all(now);

  if (!due.length) return { completedCount: 0 };

  db.transaction(() => {
    for (const row of due) {
      const orderId = String(row.id || '').trim();
      const listingId = String(row.listingId || '').trim();
      if (!orderId || !listingId) continue;

      const selectedAddOns = safeJsonParse(row.selectedAddOnsJson, []);
      const hasAddOns = Array.isArray(selectedAddOns) && selectedAddOns.length;

      if (hasAddOns) {
        const totalAddOnDays = computeSelectedAddOnsTotalDays(selectedAddOns);
        const addonsDueAt = totalAddOnDays
          ? addDaysToIso(now, totalAddOnDays)
          : null;
        db.prepare(
          `UPDATE orders
              SET status = 'addons',
                  addons_started_at = COALESCE(addons_started_at, ?),
                  addons_due_at = COALESCE(addons_due_at, ?),
                  updated_at = ?
            WHERE id = ? AND status = 'delivered'`,
        ).run(now, addonsDueAt, now, orderId);

        continue;
      }

      db.prepare(
        `UPDATE orders
            SET status = 'completed',
                finalized_reason = COALESCE(finalized_reason, 'auto_review_ended'),
                finalized_at = COALESCE(finalized_at, ?),
                updated_at = ?
          WHERE id = ? AND status = 'delivered'`,
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

module.exports = {
  safeJsonParse,
  toInt,
  computeOrderTotals,
  generateUniqueOrderNumber,
  completeExpiredReviewOrders,
  computeSelectedAddOnsTotalDays,
};
