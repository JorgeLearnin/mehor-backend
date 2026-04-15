'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');

const { db } = require('../db/db');
const { completeExpiredReviewOrders } = require('../utils/order');
const { getSellerPlatformFeeBps, computeFeeUsd } = require('../utils/fees');

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toSellerDisplayName(row) {
  const displayName = String(row?.sellerDisplayName ?? '').trim();
  if (displayName) return displayName;

  const username = String(row?.sellerUsername ?? '').trim();
  if (username) return username;

  return 'Seller';
}

function toSellerUsername(row) {
  const username = String(row?.sellerUsername ?? '').trim();
  if (username) return username;
  return null;
}

function toUserFullName(row) {
  const displayName = String(row?.display_name ?? '').trim();
  if (displayName) return displayName;

  const username = String(row?.username ?? '').trim();
  if (username) return username;

  return 'User';
}

function toUserUsername(row) {
  const username = String(row?.username ?? '').trim();
  if (username) return username;
  return null;
}

function toInt(value, { min = 1, max = 50 } = {}) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

async function listUsernames(req, res) {
  const q = String(req.query?.q ?? '').trim();
  const limit = toInt(req.query?.limit, { min: 1, max: 20 }) || 8;

  if (q.length < 1) return res.json({ usernames: [] });
  if (q.length > 30) return res.json({ usernames: [] });

  const qLower = q.toLowerCase();

  const rows = await db
    .prepare(
      `SELECT username
         FROM users
        WHERE username IS NOT NULL
          AND LOWER(username) LIKE ?
        ORDER BY LENGTH(username) ASC, username ASC
        LIMIT ?`,
    )
    .all(`${qLower}%`, limit);

  const usernames = rows
    .map((r) => String(r?.username ?? '').trim())
    .filter(Boolean);

  return res.json({ usernames });
}

async function lookupUsernames(req, res) {
  const raw = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  const usernames = raw
    .map((u) => String(u ?? '').trim())
    .filter(Boolean)
    .slice(0, 20);

  if (usernames.length === 0) return res.json({ usernames: [] });

  const lowered = Array.from(new Set(usernames.map((u) => u.toLowerCase())));
  const placeholders = lowered.map(() => '?').join(',');

  const rows = await db
    .prepare(
      `SELECT username
         FROM users
        WHERE username IS NOT NULL
          AND LOWER(username) IN (${placeholders})
        LIMIT 50`,
    )
    .all(...lowered);

  const existing = rows
    .map((r) => String(r?.username ?? '').trim())
    .filter(Boolean);

  return res.json({ usernames: existing });
}

async function listMySavedListings(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const rows = await db
    .prepare(
      `SELECT sl.listing_id AS id,
              sl.created_at AS savedAt,
              l.status AS status,
              l.title AS title,
              l.price_usd AS priceUsd,
              l.screenshots_json AS screenshotsJson,
              (
                SELECT o.id
                  FROM orders o
                 WHERE o.listing_id = l.id
                 ORDER BY o.created_at DESC
                 LIMIT 1
              ) AS orderId,
              u.id AS sellerId,
              u.display_name AS sellerDisplayName,
              u.username AS sellerUsername,
              u.avatar_url AS sellerAvatarUrl
         FROM saved_listings sl
         JOIN listings l ON l.id = sl.listing_id
         JOIN users u ON u.id = l.seller_id
        WHERE sl.user_id = ?
          AND l.status IN ('active', 'in_progress')
        ORDER BY sl.created_at DESC
        LIMIT 200`,
    )
    .all(userId);

  const savedListings = rows.map((r) => {
    const screenshots = safeJsonParse(r.screenshotsJson, []);
    const imageUrl =
      Array.isArray(screenshots) && screenshots.length > 0
        ? String(screenshots[0]?.url ?? '').trim() || null
        : null;

    return {
      id: String(r.id),
      title: String(r.title || '').trim(),
      status: String(r.status || '').trim(),
      orderId: r.orderId ? String(r.orderId).trim() : null,
      priceUsd: Number(r.priceUsd ?? 0),
      imageUrl,
      seller: {
        id: r.sellerId ? String(r.sellerId).trim() : null,
        fullName: toSellerDisplayName(r),
        username: toSellerUsername(r),
      },
      savedAt: String(r.savedAt || '').trim(),
    };
  });

  return res.json({ savedListings });
}

async function mySavedContains(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = String(req.params?.listingId ?? '').trim();
  if (!listingId)
    return res.status(400).json({ error: 'listingId is required' });

  const row = await db
    .prepare(
      `SELECT 1 AS ok
         FROM saved_listings
        WHERE user_id = ? AND listing_id = ?
        LIMIT 1`,
    )
    .get(userId, listingId);

  return res.json({ saved: !!row });
}

async function toggleMySavedListing(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = String(req.body?.listingId ?? '').trim();
  if (!listingId)
    return res.status(400).json({ error: 'listingId is required' });

  const exists = await db
    .prepare(
      `SELECT 1 AS ok
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);
  if (!exists) return res.status(404).json({ error: 'Listing not found' });

  const already = await db
    .prepare(
      `SELECT 1 AS ok
         FROM saved_listings
        WHERE user_id = ? AND listing_id = ?
        LIMIT 1`,
    )
    .get(userId, listingId);

  if (already) {
    await db.prepare(
      `DELETE FROM saved_listings WHERE user_id = ? AND listing_id = ?`,
    ).run(userId, listingId);
    return res.json({ saved: false });
  }

  await db.prepare(
    `INSERT INTO saved_listings (user_id, listing_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(userId, listingId, new Date().toISOString());

  return res.json({ saved: true });
}

async function removeMySavedListing(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = String(req.params?.listingId ?? '').trim();
  if (!listingId)
    return res.status(400).json({ error: 'listingId is required' });

  await db.prepare(
    `DELETE FROM saved_listings WHERE user_id = ? AND listing_id = ?`,
  ).run(userId, listingId);

  return res.json({ saved: false });
}

function toIntWithDefault(value, { min = 1, max = 200, fallback = 50 } = {}) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

async function listMyTransactions(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  await completeExpiredReviewOrders({ nowIso: new Date().toISOString() });

  const limit = toIntWithDefault(req.query?.limit, {
    min: 1,
    max: 200,
    fallback: 50,
  });

  const rows = await db
    .prepare(
      `SELECT o.id,
              o.listing_id AS listingId,
              o.buyer_id AS buyerId,
              o.seller_id AS sellerId,
              o.status,
              o.platform_fee_usd AS platformFeeUsd,
              o.seller_platform_fee_bps AS sellerPlatformFeeBps,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.total_usd AS totalUsd,
              o.refunded_usd AS refundedUsd,
              o.payout_status AS payoutStatus,
              o.paid_out_at AS paidOutAt,
              o.created_at AS createdAt,
              o.paid_at AS paidAt,
              o.updated_at AS updatedAt,
              l.title AS listingTitle,
              l.category AS listingCategory
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.buyer_id = ? OR o.seller_id = ?
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC
        LIMIT ?`,
    )
    .all(userId, userId, limit);

  // Transactions should reflect:
  // - Purchases (things the user bought)
  // - Refunds (money returned to the buyer)
  // - Withdrawals (seller withdrawing completed funds; payout_status='paid')
  const transactions = [];

  for (const r of rows) {
    const listingTitle = String(r.listingTitle || '').trim();
    const title = listingTitle || 'Listing';

    const lifecycle = String(r.status || '').toLowerCase();
    const refundedUsd = Math.max(0, Number(r.refundedUsd ?? 0));

    const totalUsd = Number(r.totalUsd ?? 0);
    const grossUsd =
      Number(r.listingPriceUsd ?? 0) + Number(r.addOnsTotalUsd ?? 0);

    const isBuyer = String(r.buyerId) === userId;
    const isSeller = String(r.sellerId) === userId;

    // 1) Purchases: only when payment happened.
    if (isBuyer) {
      const paidAt = String(r.paidAt || '').trim();
      if (paidAt) {
        const status =
          lifecycle === 'completed'
            ? 'Completed'
            : lifecycle === 'canceled' || lifecycle === 'cancelled'
              ? 'Canceled'
              : 'Pending';

        transactions.push({
          id: `purchase:${String(r.id)}`,
          orderId: String(r.id),
          listingId: String(r.listingId),
          kind: 'purchase',
          description: `Purchase — ${title}`,
          amountUsd: -totalUsd,
          status,
          createdAt: String(r.createdAt || '').trim(),
          effectiveAt: paidAt,
          listing: {
            title,
            category: String(r.listingCategory || '').trim() || null,
          },
        });

        // 2) Refunds: show as separate credit entries for the buyer.
        if (refundedUsd > 0) {
          const refundAt = String(
            r.updatedAt || r.paidAt || r.createdAt || '',
          ).trim();
          transactions.push({
            id: `refund:buyer:${String(r.id)}`,
            orderId: String(r.id),
            listingId: String(r.listingId),
            kind: 'refund',
            description: `Refund received — ${title}`,
            amountUsd: refundedUsd,
            status: refundedUsd >= totalUsd ? 'Refunded' : 'Partial refund',
            createdAt: String(r.createdAt || '').trim(),
            effectiveAt: refundAt,
            listing: {
              title,
              category: String(r.listingCategory || '').trim() || null,
            },
          });
        }
      }
    }

    // 3) Withdrawals: only when the seller actually withdrew funds.
    if (isSeller) {
      const payoutStatus = String(r.payoutStatus || '').toLowerCase();
      const paidOutAt = String(r.paidOutAt || '').trim();
      if (payoutStatus === 'paid' && paidOutAt) {
        const netUsd = computeSellerNetAfterFeesUsd({
          grossUsd,
          refundedUsd,
          sellerPlatformFeeBps: r.sellerPlatformFeeBps,
        });

        transactions.push({
          id: `payout:${String(r.id)}`,
          orderId: String(r.id),
          listingId: String(r.listingId),
          kind: 'payout',
          description: `Withdrawal — ${title}`,
          amountUsd: netUsd,
          status: 'Paid',
          createdAt: String(r.createdAt || '').trim(),
          effectiveAt: paidOutAt,
          listing: {
            title,
            category: String(r.listingCategory || '').trim() || null,
          },
        });
      }
    }
  }

  // Newest first (based on effective timestamp).
  transactions.sort((a, b) => {
    const am = Date.parse(String(a.effectiveAt || ''));
    const bm = Date.parse(String(b.effectiveAt || ''));
    return (Number.isFinite(bm) ? bm : 0) - (Number.isFinite(am) ? am : 0);
  });

  return res.json({ transactions });
}

async function listMyOrders(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  await completeExpiredReviewOrders({ nowIso: new Date().toISOString() });

  const limit = toIntWithDefault(req.query?.limit, {
    min: 1,
    max: 200,
    fallback: 50,
  });

  const rows = await db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.status,
              o.total_usd AS totalUsd,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.delivery_zip_url AS deliveryZipUrl,
              o.delivery_zip_filename AS deliveryZipFilename,
              o.delivery_repo_link AS deliveryRepoLink,
              o.created_at AS createdAt,
              l.id AS listingId,
              l.title AS listingTitle,
              l.delivery_method AS deliveryMethod,
              s.id AS sellerId,
              s.username AS sellerUsername,
              s.display_name AS sellerDisplayName
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         LEFT JOIN users s ON s.id = o.seller_id
        WHERE o.buyer_id = ?
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC
        LIMIT ?`,
    )
    .all(userId, limit);

  const orders = rows.map((r) => {
    const sellerFullNameRaw =
      String(r.sellerDisplayName || '').trim() ||
      String(r.sellerUsername || '').trim() ||
      'Seller';

    const sellerUsernameRaw = String(r.sellerUsername || '').trim() || null;

    return {
      id: String(r.id),
      orderNumber: r.orderNumber ? String(r.orderNumber) : null,
      status: String(r.status || ''),
      totalUsd: Number(r.totalUsd ?? 0),
      subtotalUsd:
        Number(r.listingPriceUsd ?? 0) + Number(r.addOnsTotalUsd ?? 0),
      createdAt: String(r.createdAt || '').trim(),
      listing: {
        id: String(r.listingId),
        title: String(r.listingTitle || '').trim(),
        deliveryMethod: String(r.deliveryMethod || '').trim() || null,
      },
      seller: {
        id: r.sellerId ? String(r.sellerId) : null,
        fullName: sellerFullNameRaw,
        username: sellerUsernameRaw,
      },
      delivery: {
        zipAvailable: Boolean(String(r.deliveryZipUrl || '').trim()),
        zipFilename: r.deliveryZipFilename
          ? String(r.deliveryZipFilename).trim()
          : null,
        repoLink: r.deliveryRepoLink ? String(r.deliveryRepoLink).trim() : null,
      },
    };
  });

  return res.json({ orders });
}

async function listMySales(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  await completeExpiredReviewOrders({ nowIso: new Date().toISOString() });

  const limit = toIntWithDefault(req.query?.limit, {
    min: 1,
    max: 200,
    fallback: 50,
  });

  const rows = await db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.status,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              COALESCE(o.paid_at, o.created_at) AS soldAt,
              l.id AS listingId,
              l.title AS listingTitle,
              b.id AS buyerId,
              b.username AS buyerUsername,
              b.display_name AS buyerDisplayName
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
         LEFT JOIN users b ON b.id = o.buyer_id
        WHERE o.seller_id = ?
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC
        LIMIT ?`,
    )
    .all(userId, limit);

  const sales = rows.map((r) => {
    const buyerFullNameRaw =
      String(r.buyerDisplayName || '').trim() ||
      String(r.buyerUsername || '').trim() ||
      'Buyer';

    const buyerUsernameRaw = String(r.buyerUsername || '').trim() || null;

    return {
      id: String(r.id),
      orderNumber: r.orderNumber ? String(r.orderNumber) : null,
      status: String(r.status || ''),
      subtotalUsd:
        Number(r.listingPriceUsd ?? 0) + Number(r.addOnsTotalUsd ?? 0),
      soldAt: String(r.soldAt || '').trim(),
      listing: {
        id: String(r.listingId),
        title: String(r.listingTitle || '').trim(),
      },
      buyer: {
        id: r.buyerId ? String(r.buyerId) : null,
        fullName: buyerFullNameRaw,
        username: buyerUsernameRaw,
      },
    };
  });

  return res.json({ sales });
}

function computeSellerNetAfterFeesUsd({
  grossUsd,
  refundedUsd,
  sellerPlatformFeeBps,
}) {
  const gross = Number(grossUsd ?? 0);
  const refunded = Math.max(0, Number(refundedUsd ?? 0));
  const bps = Number.isFinite(Number(sellerPlatformFeeBps))
    ? Math.max(0, Math.min(10_000, Number(sellerPlatformFeeBps)))
    : getSellerPlatformFeeBps();

  // IMPORTANT: seller platform fee is computed from the original gross subtotal,
  // not from the post-refund kept amount (promo orders will have bps=0).
  // Refunds may include buyer service fee (on full refunds), so cap the refunded
  // amount at the seller gross subtotal.
  const refundedFromSubtotal = Math.min(gross, refunded);
  const keptSubtotal = Math.max(0, gross - refundedFromSubtotal);
  const platformFeeUsd = computeFeeUsd({ amountUsd: gross, feeBps: bps });
  return Math.max(0, keptSubtotal - platformFeeUsd);
}

function derivePayoutStatus({ orderStatus, refundedUsd, payoutStatus }) {
  const lifecycle = String(orderStatus ?? '').toLowerCase();
  const payout = String(payoutStatus ?? '').toLowerCase();
  const refund = Math.max(0, Number(refundedUsd ?? 0));

  if (lifecycle === 'canceled' || lifecycle === 'cancelled') return 'Canceled';

  // "Paid" means seller withdrew funds (not Stripe payment success).
  if (payout === 'paid') return 'Paid';

  if (lifecycle === 'completed') {
    return refund > 0 ? 'Partial refund' : 'Completed';
  }

  // Anything else that's already purchased/in-progress is "Pending" for earnings.
  return 'Pending';
}

async function ensureStripePayoutAccountReady({ stripe, stripeAccountId }) {
  const accountId = String(stripeAccountId ?? '').trim();
  if (!accountId) {
    return {
      ok: false,
      error: 'No payout account configured. Please add a payout method.',
    };
  }

  const account = await stripe.accounts.retrieve(accountId);
  const currentlyDue = Array.isArray(account?.requirements?.currently_due)
    ? account.requirements.currently_due.filter(Boolean)
    : [];

  if (account?.details_submitted === false || currentlyDue.length > 0) {
    return {
      ok: false,
      error:
        'Stripe payout account setup is incomplete. Finish Stripe verification before withdrawing.',
    };
  }

  if (account?.payouts_enabled !== true) {
    return {
      ok: false,
      error:
        'Stripe payouts are not enabled for this account yet. Complete Stripe verification and try again.',
    };
  }

  return { ok: true };
}

function toPublicOrderCode({ orderId, orderNumber }) {
  const num = String(orderNumber ?? '').trim();
  if (num) return `MH-${num}`;
  const id = String(orderId ?? '').trim();
  return id ? `MH-${id.slice(0, 8)}` : 'MH-—';
}

async function getMyEarnings(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.user?.isSeller)
    return res.status(403).json({ error: 'Seller access required' });

  // Only include orders that were actually purchased (i.e., payment happened).
  // `paid_at` is the purchase date and drives the earnings history.
  const rows = await db
    .prepare(
      `SELECT o.id,
              o.order_number AS orderNumber,
              o.status,
              o.paid_at AS paidAt,
              o.created_at AS createdAt,
              o.listing_price_usd AS listingPriceUsd,
              o.add_ons_total_usd AS addOnsTotalUsd,
              o.refunded_usd AS refundedUsd,
              o.payout_status AS payoutStatus,
              o.seller_platform_fee_bps AS sellerPlatformFeeBps,
              l.id AS listingId,
              l.title AS listingTitle
         FROM orders o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.seller_id = ?
          AND o.paid_at IS NOT NULL
        ORDER BY o.paid_at DESC`,
    )
    .all(userId);

  const history = rows.map((r) => {
    const grossUsd =
      Number(r.listingPriceUsd ?? 0) + Number(r.addOnsTotalUsd ?? 0);
    const refundedUsd = Math.max(0, Number(r.refundedUsd ?? 0));
    const status = derivePayoutStatus({
      orderStatus: r.status,
      refundedUsd,
      payoutStatus: r.payoutStatus,
    });

    return {
      orderId: String(r.id),
      id: toPublicOrderCode({ orderId: r.id, orderNumber: r.orderNumber }),
      purchasedAt: String(r.paidAt || r.createdAt || '').trim(),
      description: String(r.listingTitle || '').trim() || 'Listing',
      listingId: String(r.listingId || '').trim(),
      amountGrossUsd: grossUsd,
      refundedUsd,
      sellerPlatformFeeBps: r.sellerPlatformFeeBps,
      status,
    };
  });

  let availableUsd = 0;
  let pendingUsd = 0;
  let totalEarningsUsd = 0;

  for (const item of history) {
    const grossUsd = Number(item.amountGrossUsd ?? 0);
    const refundedUsd = Number(item.refundedUsd ?? 0);
    const netUsd = computeSellerNetAfterFeesUsd({
      grossUsd,
      refundedUsd,
      sellerPlatformFeeBps: item.sellerPlatformFeeBps,
    });

    if (item.status === 'Pending') {
      // Option B: show pending as expected net-after-fees.
      pendingUsd += netUsd;
      continue;
    }

    if (item.status === 'Canceled') {
      continue;
    }

    // Completed / Partial refund / Paid all count toward lifetime total earnings.
    totalEarningsUsd += netUsd;

    // Available excludes withdrawn funds (Paid).
    if (item.status !== 'Paid') {
      availableUsd += netUsd;
    }
  }

  return res.json({
    balances: {
      availableUsd,
      pendingUsd,
      totalEarningsUsd,
    },
    history,
  });
}

async function withdrawMyEarnings(req, res) {
  const userId = String(req.user?.id ?? '').trim();
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.user?.isSeller)
    return res.status(403).json({ error: 'Seller access required' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey)
    return res.status(500).json({ error: 'Stripe not configured' });
  const stripe = new Stripe(stripeKey);

  const accountRow = await db
    .prepare(
      `SELECT stripe_account_id AS stripeAccountId
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId);

  const stripeAccountId = String(accountRow?.stripeAccountId ?? '').trim();
  if (!stripeAccountId) {
    return res.status(409).json({
      error:
        'No Stripe payout account configured. Please complete Stripe payout setup.',
    });
  }

  const payoutAccountReady = await ensureStripePayoutAccountReady({
    stripe,
    stripeAccountId,
  });
  if (!payoutAccountReady.ok) {
    return res.status(409).json({ error: payoutAccountReady.error });
  }

  // Payouts must go to a saved bank account on the seller's connected account.
  const banks = await stripe.accounts.listExternalAccounts(stripeAccountId, {
    object: 'bank_account',
    limit: 1,
  });
  const hasBankAccount = Array.isArray(banks?.data) && banks.data.length > 0;
  if (!hasBankAccount) {
    return res.status(409).json({
      error:
        'No payout destination is configured in Stripe yet. Please complete Stripe payout setup.',
    });
  }

  const eligible = await db
    .prepare(
      `SELECT id,
              listing_price_usd AS listingPriceUsd,
              add_ons_total_usd AS addOnsTotalUsd,
              refunded_usd AS refundedUsd,
              COALESCE(refunded_subtotal_usd, COALESCE(refunded_usd, 0)) AS refundedSubtotalUsd,
              seller_platform_fee_bps AS sellerPlatformFeeBps
         FROM orders
        WHERE seller_id = ?
          AND status = 'completed'
          AND paid_at IS NOT NULL
          AND COALESCE(payout_status, 'unpaid') <> 'paid'
        ORDER BY paid_at ASC`,
    )
    .all(userId);

  const orderPayouts = eligible
    .map((o) => {
      const grossUsd =
        Number(o.listingPriceUsd ?? 0) + Number(o.addOnsTotalUsd ?? 0);
      const refundedTotalUsd = Math.max(
        Math.max(0, Number(o.refundedUsd ?? 0)),
        Math.max(0, Number(o.refundedSubtotalUsd ?? 0)),
      );
      const netUsd = computeSellerNetAfterFeesUsd({
        grossUsd,
        refundedUsd: refundedTotalUsd,
        sellerPlatformFeeBps: o.sellerPlatformFeeBps,
      });

      return {
        orderId: String(o.id),
        netUsd,
      };
    })
    .filter((x) => x.orderId && x.netUsd > 0);

  const totalUsd = orderPayouts.reduce((sum, x) => sum + x.netUsd, 0);
  if (totalUsd <= 0) {
    return res.json({ ok: true, paidOutCount: 0 });
  }

  const now = new Date().toISOString();
  const orderIds = orderPayouts.map((x) => x.orderId).sort();
  const hash = crypto
    .createHash('sha256')
    .update(orderIds.join(','))
    .digest('hex')
    .slice(0, 24);
  const idempotencyKey = `mehor_withdraw_${userId}_${hash}_${totalUsd}`;

  await stripe.transfers.create(
    {
      amount: Math.round(totalUsd * 100),
      currency: 'usd',
      destination: stripeAccountId,
      metadata: {
        userId,
        type: 'withdrawal',
        orderIds: orderIds.slice(0, 50).join(','),
      },
    },
    { idempotencyKey },
  );

  const tx = db.transaction(() => {
    const update = db.prepare(
      `UPDATE orders
          SET payout_status = 'paid',
              paid_out_at = COALESCE(paid_out_at, ?),
              seller_paid_out_usd = ?,
              updated_at = ?
        WHERE id = ?
          AND seller_id = ?
          AND status = 'completed'
          AND paid_at IS NOT NULL
          AND COALESCE(payout_status, 'unpaid') <> 'paid'`,
    );

    for (const item of orderPayouts) {
      update.run(now, item.netUsd, now, item.orderId, userId);
    }
  });
  await tx();

  return res.json({ ok: true, paidOutCount: orderPayouts.length });
}

module.exports = {
  listUsernames,
  lookupUsernames,
  listMySavedListings,
  mySavedContains,
  toggleMySavedListing,
  removeMySavedListing,
  listMyTransactions,
  listMyOrders,
  listMySales,
  getMyEarnings,
  withdrawMyEarnings,
};
