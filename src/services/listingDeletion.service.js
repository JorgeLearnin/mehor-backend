const pool = require('../db');
const cloudinary = require('../lib/cloudinary');

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

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

function normalizePublicIds(rows) {
  return rows.map((row) => String(row.public_id || '').trim()).filter(Boolean);
}

async function getListingImagePublicIds({ client, listingIds }) {
  if (!Array.isArray(listingIds) || listingIds.length === 0) return [];

  const result = await client.query(
    `
    SELECT public_id
    FROM listing_images
    WHERE listing_id = ANY($1::uuid[])
      AND public_id IS NOT NULL
    `,
    [listingIds],
  );

  return normalizePublicIds(result.rows);
}

async function destroyListingImageAssets(publicIds, context = 'listing_cleanup') {
  const uniquePublicIds = [...new Set(publicIds.map((id) => String(id || '').trim()).filter(Boolean))];

  for (const publicId of uniquePublicIds) {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
      });
    } catch (error) {
      console.error(`${context} Cloudinary image cleanup error:`, error);
    }
  }
}

async function hardDeleteListingRecord({
  client,
  listingId,
  sellerId = null,
  statuses = null,
}) {
  const normalizedListingId = normalizeUuid(listingId);

  if (!isUuid(normalizedListingId)) {
    return {
      deletedCount: 0,
      publicIds: [],
    };
  }

  const params = [normalizedListingId];
  const whereParts = ['id = $1'];

  if (sellerId !== null && sellerId !== undefined) {
    params.push(sellerId);
    whereParts.push(`seller_id = $${params.length}`);
  }

  if (Array.isArray(statuses) && statuses.length > 0) {
    params.push(statuses);
    whereParts.push(`status = ANY($${params.length}::listing_status[])`);
  }

  const listingResult = await client.query(
    `
    SELECT id
    FROM listings
    WHERE ${whereParts.join(' AND ')}
    FOR UPDATE
    `,
    params,
  );

  const listingIds = listingResult.rows.map((row) => row.id);

  if (listingIds.length === 0) {
    return {
      deletedCount: 0,
      publicIds: [],
    };
  }

  const publicIds = await getListingImagePublicIds({
    client,
    listingIds,
  });

  await client.query(
    `
    DELETE FROM listings
    WHERE id = ANY($1::uuid[])
    `,
    [listingIds],
  );

  return {
    deletedCount: listingIds.length,
    publicIds,
  };
}

async function hardDeleteListingsBySellerRecord({ client, sellerId }) {
  const listingResult = await client.query(
    `
    SELECT id
    FROM listings
    WHERE seller_id = $1
    FOR UPDATE
    `,
    [sellerId],
  );

  const listingIds = listingResult.rows.map((row) => row.id);

  if (listingIds.length === 0) {
    return {
      deletedCount: 0,
      publicIds: [],
    };
  }

  const publicIds = await getListingImagePublicIds({
    client,
    listingIds,
  });

  await client.query(
    `
    DELETE FROM listings
    WHERE id = ANY($1::uuid[])
    `,
    [listingIds],
  );

  return {
    deletedCount: listingIds.length,
    publicIds,
  };
}

async function hardDeleteListing(options) {
  const client = await pool.connect();
  let result = {
    deletedCount: 0,
    publicIds: [],
  };

  try {
    await client.query('BEGIN');

    result = await hardDeleteListingRecord({
      client,
      ...options,
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await destroyListingImageAssets(result.publicIds, options?.context);

  return result;
}

async function hardDeleteListingSafely(options) {
  try {
    return await hardDeleteListing(options);
  } catch (error) {
    console.error(`${options?.context || 'listing_cleanup'} hard delete error:`, error);

    return {
      deletedCount: 0,
      publicIds: [],
      error,
    };
  }
}

module.exports = {
  destroyListingImageAssets,
  hardDeleteListing,
  hardDeleteListingRecord,
  hardDeleteListingSafely,
  hardDeleteListingsBySellerRecord,
};