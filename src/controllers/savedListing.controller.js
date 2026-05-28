const pool = require('../db');

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const saveListing = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    if (!isUuid(listingId)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    const listingResult = await pool.query(
      `SELECT id
       FROM listings
       WHERE id = $1 AND status = 'published'
       LIMIT 1`,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    await pool.query(
      `INSERT INTO saved_listings (user_id, listing_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, listing_id) DO NOTHING`,
      [userId, listingId],
    );

    return res.json({ success: true, saved: true });
  } catch (err) {
    console.error('Save listing error:', err);
    return res.status(500).json({ error: 'Failed to save listing' });
  }
};

const getSavedListingStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    if (!isUuid(listingId)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    const result = await pool.query(
      `SELECT 1
       FROM saved_listings
       WHERE user_id = $1 AND listing_id = $2
       LIMIT 1`,
      [userId, listingId],
    );

    return res.json({ saved: result.rows.length > 0 });
  } catch (err) {
    console.error('Get saved listing status error:', err);
    return res.status(500).json({ error: 'Failed to check saved status' });
  }
};

const getSavedListings = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT
        sl.id AS saved_id,
        sl.created_at AS saved_at,
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.status,
        l.created_at,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
          ELSE COALESCE(u.full_name, u.username)
        END AS seller_name,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
          ELSE u.username
        END AS seller_username,
        (
          SELECT li.url
          FROM listing_images li
          WHERE li.listing_id = l.id
          ORDER BY li.position ASC
          LIMIT 1
        ) AS cover_image,
        COALESCE(
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT ls.name), NULL),
          '{}'
        ) AS stacks
      FROM saved_listings sl
      JOIN listings l ON l.id = sl.listing_id
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN listing_stacks ls ON ls.listing_id = l.id
      WHERE sl.user_id = $1
        AND l.status = 'published'
      GROUP BY
        sl.id,
        sl.created_at,
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.status,
        l.created_at,
        u.full_name,
        u.username,
        u.status,
        u.deleted_at
      ORDER BY sl.created_at DESC`,
      [userId],
    );

    return res.json({ savedListings: result.rows });
  } catch (err) {
    console.error('Get saved listings error:', err);
    return res.status(500).json({ error: 'Failed to get saved listings' });
  }
};

const removeSavedListing = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    if (!isUuid(listingId)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    await pool.query(
      `DELETE FROM saved_listings
       WHERE user_id = $1 AND listing_id = $2`,
      [userId, listingId],
    );

    return res.json({ success: true, saved: false });
  } catch (err) {
    console.error('Remove saved listing error:', err);
    return res.status(500).json({ error: 'Failed to remove saved listing' });
  }
};

module.exports = {
  saveListing,
  getSavedListingStatus,
  getSavedListings,
  removeSavedListing,
};
