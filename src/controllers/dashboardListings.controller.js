'use strict';

const { db } = require('../db/db');
const { deleteCloudinaryResourcesByPrefix } = require('../utils/cloudinary');
const { getPaginationParams, escapeLike } = require('../utils/pagination');

function toDashboardStatus(listingStatus) {
  const s = String(listingStatus || '')
    .trim()
    .toLowerCase();
  if (s === 'disabled') return 'Disabled';
  if (s === 'in_progress') return 'Pending';
  if (s === 'sold') return 'Sold';
  if (s === 'active') return 'Active';
  return 'Disabled';
}

async function listDashboardListings(req, res) {
  const qRaw = typeof req.query?.q === 'string' ? req.query.q : '';
  const q = qRaw.trim().toLowerCase();

  const { page, limit, offset } = getPaginationParams(req.query, {
    defaultLimit: 10,
    maxLimit: 50,
  });

  // Dashboard listings should include Active, Disabled (admin disabled), and Pending (in_progress).
  // Remove listings from this view once they've been sold OR canceled.
  // - sold: listings.status becomes 'sold'
  // - canceled: an order for the listing reached status='canceled' (full refund or seller deadline missed)
  const baseWhere = `
    l.status IN ('active', 'disabled', 'in_progress')
    AND NOT EXISTS (
      SELECT 1
        FROM orders o
       WHERE o.listing_id = l.id
         AND o.status = 'canceled'
    )
  `;

  let where = baseWhere;
  let args = [];

  if (q) {
    const like = `%${escapeLike(q)}%`;

    let mapped = q;
    if (q === 'pending') mapped = 'in_progress';
    else if (q === 'active') mapped = 'active';
    else if (q === 'sold') mapped = 'sold';
    else if (q === 'disabled') mapped = 'disabled';

    const statusLike = `%${escapeLike(mapped)}%`;

    where = `${baseWhere} AND (
      LOWER(l.title) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(u.username, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(l.status) LIKE LOWER(?) ESCAPE '\\'
    )`;

    args = [like, like, statusLike];
  }

  const totalRow = await db
    .prepare(
      `SELECT COUNT(1) AS total
         FROM listings l
         JOIN users u ON u.id = l.seller_id
        WHERE ${where}`,
    )
    .get(...args);

  const total = Number(totalRow?.total ?? 0);

  const rows = await db
    .prepare(
      `SELECT l.id,
              l.title,
              l.price_usd AS priceUsd,
              l.status AS listingStatus,
              u.username AS sellerUsername
         FROM listings l
         JOIN users u ON u.id = l.seller_id
        WHERE ${where}
        ORDER BY l.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const listings = (rows || []).map((r) => ({
    id: String(r.id),
    title: String(r.title || ''),
    price: Number(r.priceUsd ?? 0),
    seller: String(r.sellerUsername || ''),
    status: toDashboardStatus(r.listingStatus),
  }));

  return res.json({ listings, total, page, limit });
}

async function disableDashboardListing(req, res) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const row = await db
    .prepare(`SELECT id, status FROM listings WHERE id = ? LIMIT 1`)
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });

  const status = String(row.status || '').toLowerCase();

  // Block if being sold or already sold.
  if (status === 'in_progress' || status === 'sold') {
    return res.status(409).json({ error: 'Listing cannot be modified' });
  }

  // Already disabled/draft -> no-op.
  if (status !== 'active') {
    return res.json({ ok: true });
  }

  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE listings
          SET status = 'disabled', updated_at = ?
        WHERE id = ? AND status = 'active'`,
    ).run(now, id);

    // Close any open checkout locks for safety.
    await db.prepare(
      `UPDATE checkout_intents
          SET status = 'closed', updated_at = ?
        WHERE listing_id = ? AND status = 'open'`,
    ).run(now, id);
  })();

  return res.json({ ok: true });
}

async function enableDashboardListing(req, res) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const row = await db
    .prepare(`SELECT id, status FROM listings WHERE id = ? LIMIT 1`)
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });

  const status = String(row.status || '').toLowerCase();

  // Block if being sold or already sold.
  if (status === 'in_progress' || status === 'sold') {
    return res.status(409).json({ error: 'Listing cannot be modified' });
  }

  // Only disabled listings can be enabled.
  if (status !== 'disabled') {
    return res.json({ ok: true });
  }

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE listings
        SET status = 'active', updated_at = ?
      WHERE id = ? AND status = 'disabled'`,
  ).run(now, id);

  return res.json({ ok: true });
}

async function deleteDashboardListing(req, res) {
  const id = typeof req.params?.id === 'string' ? req.params.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const row = await db
    .prepare(`SELECT id, status FROM listings WHERE id = ? LIMIT 1`)
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });

  const status = String(row.status || '').toLowerCase();

  // Block if being sold or already sold.
  if (status === 'in_progress' || status === 'sold') {
    return res.status(409).json({ error: 'Listing cannot be removed' });
  }

  // Delete listing images from Cloudinary first. Block delete if configured but deletion fails.
  try {
    await deleteCloudinaryResourcesByPrefix({
      prefix: `mehor/listings/${id}/`,
      resourceType: 'image',
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED')) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to delete listing images' });
    }
  }

  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare(
      `UPDATE checkout_intents
          SET status = 'closed', updated_at = ?
        WHERE listing_id = ? AND status = 'open'`,
    ).run(now, id);

    await db.prepare(`DELETE FROM listings WHERE id = ?`).run(id);
  })();

  return res.json({ ok: true });
}

module.exports = {
  listDashboardListings,
  disableDashboardListing,
  enableDashboardListing,
  deleteDashboardListing,
};
