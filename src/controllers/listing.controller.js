const pool = require('../db');
const { verifySessionToken } = require('../utils/token');
const {
  destroyListingImageAssets,
  hardDeleteListing,
} = require('../services/listingDeletion.service');
const {
  createNotificationWithEmail,
} = require('../services/notification.service');

const allowedDeliveryMethods = ['zip', 'repo', 'both'];
const allowedListingTypes = [
  'website',
  'mobile',
  'ecommerce',
  'booking',
  'dashboard',
];

const isNonEmptyString = (value) => {
  return typeof value === 'string' && value.trim().length > 0;
};

const normalizeListingImageInput = (image) => {
  if (typeof image === 'string') {
    const url = image.trim();
    return url ? { url, publicId: null } : null;
  }

  if (image && typeof image === 'object' && !Array.isArray(image)) {
    const url = String(image.url ?? image.secure_url ?? '').trim();
    const publicId = String(image.publicId ?? image.public_id ?? '').trim();

    if (!url) return null;

    return {
      url,
      publicId: publicId || null,
    };
  }

  return null;
};

const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const getOptionalUserId = (req) => {
  const cookieName = process.env.COOKIE_NAME || 'mehor_session';
  const token = req.cookies?.[cookieName];

  if (!token) return null;

  try {
    const user = verifySessionToken(token);
    return user?.id ?? null;
  } catch {
    return null;
  }
};

const normalizeQaText = (value, maxLength) => {
  if (typeof value !== 'string') {
    return { text: '', error: 'Text is required.' };
  }

  const text = value.trim();

  if (!text) {
    return { text: '', error: 'Text is required.' };
  }

  if (text.length > maxLength) {
    return {
      text: '',
      error: `Text must be ${maxLength} characters or less.`,
    };
  }

  return { text, error: null };
};

const getListingTypeFromPayload = ({ listing_type }) => {
  return listing_type || 'website';
};

const validateListingPayload = ({
  title,
  description,
  base_price,
  listing_type,
  delivery_method,
  support_window_days,
  stacks = [],
  images = [],
  addons = [],
}) => {
  const errors = {};

  if (!isNonEmptyString(title)) {
    errors.title = 'Title is required.';
  } else if (title.trim().length > 35) {
    errors.title = 'Title must be 35 characters or less.';
  }

  if (!isNonEmptyString(description)) {
    errors.description = 'Description is required.';
  } else if (description.trim().length > 500) {
    errors.description = 'Description must be 500 characters or less.';
  }

  if (!allowedListingTypes.includes(listing_type)) {
    errors.listing_type =
      'Listing type must be website, mobile, ecommerce, booking, or dashboard.';
  }

  if (!allowedDeliveryMethods.includes(delivery_method)) {
    errors.delivery_method = 'Delivery method must be zip, repo, or both.';
  }

  const priceNumber = Number(base_price);
  if (!Number.isFinite(priceNumber) || priceNumber < 0) {
    errors.base_price = 'Base price must be a valid number.';
  }

  const supportDays = Number(support_window_days);
  if (!Number.isInteger(supportDays) || supportDays < 0) {
    errors.support_window_days =
      'Support window must be a valid number of days.';
  }

  if (!Array.isArray(stacks)) {
    errors.stacks = 'Stacks must be an array.';
  } else if (stacks.length > 6) {
    errors.stacks = 'You can select up to 6 stacks.';
  } else if (
    stacks.some((stack) => !isNonEmptyString(stack) || stack.trim().length > 50)
  ) {
    errors.stacks = 'Each stack must be valid and 50 characters or less.';
  }

  if (!Array.isArray(images)) {
    errors.images = 'Images must be an array.';
  } else if (images.length > 7) {
    errors.images = 'You can upload up to 7 images.';
  } else if (images.some((image) => !normalizeListingImageInput(image))) {
    errors.images = 'Each image must be valid.';
  }

  if (!Array.isArray(addons)) {
    errors.addons = 'Add-ons must be an array.';
  } else {
    for (const addon of addons) {
      const addonPrice = Number(addon.price);
      const addonDays = Number(addon.delivery_days);

      if (
        !isNonEmptyString(addon.title) ||
        addon.title.trim().length > 80 ||
        !Number.isFinite(addonPrice) ||
        addonPrice < 0 ||
        !Number.isInteger(addonDays) ||
        addonDays < 0
      ) {
        errors.addons =
          'Each add-on must include valid title, price, and delivery days.';
        break;
      }
    }
  }

  return {
    errors,
    priceNumber,
    supportDays,
  };
};

const getListingImagePublicIdsForCleanup = async (client, listingId) => {
  const result = await client.query(
    `
    SELECT public_id
    FROM listing_images
    WHERE listing_id = $1
      AND public_id IS NOT NULL
    `,
    [listingId],
  );

  return result.rows
    .map((row) => String(row.public_id || '').trim())
    .filter(Boolean);
};

const getRemovedImagePublicIdsForCleanup = (oldPublicIds, images = []) => {
  const keptPublicIds = new Set(
    images
      .map((image) => normalizeListingImageInput(image)?.publicId)
      .map((publicId) => String(publicId || '').trim())
      .filter(Boolean),
  );

  return oldPublicIds.filter((publicId) => !keptPublicIds.has(publicId));
};

const createListing = async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = req.user.id;

    const {
      title,
      description,
      demo_url,
      base_price,
      listing_type,
      delivery_method,
      support_window_days,
      included,
      not_included,
      stacks = [],
      images = [],
      addons = [],
    } = req.body;

    const listingType = getListingTypeFromPayload({ listing_type });

    const { errors, priceNumber, supportDays } = validateListingPayload({
      title,
      description,
      base_price,
      listing_type: listingType,
      delivery_method,
      support_window_days,
      stacks,
      images,
      addons,
    });

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ fieldErrors: errors });
    }

    await client.query('BEGIN');

    const listingResult = await client.query(
      `INSERT INTO listings (
        seller_id,
        listing_type,
        title,
        description,
        demo_url,
        base_price_cents,
        delivery_method,
        support_window_days,
        included,
        not_included
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      ) RETURNING id`,
      [
        userId,
        listingType,
        title.trim(),
        description.trim(),
        demo_url || null,
        Math.round(priceNumber * 100),
        delivery_method,
        supportDays,
        included || null,
        not_included || null,
      ],
    );

    const listingId = listingResult.rows[0].id;

    for (const stack of stacks) {
      await client.query(
        `INSERT INTO listing_stacks (
          listing_id,
          name
        ) VALUES ($1, $2)`,
        [listingId, stack.trim()],
      );
    }

    for (let i = 0; i < images.length; i++) {
      const image = normalizeListingImageInput(images[i]);

      await client.query(
        `INSERT INTO listing_images (
          listing_id,
          url,
          position,
          public_id
        ) VALUES ($1, $2, $3, $4)`,
        [listingId, image.url, i, image.publicId],
      );
    }

    for (const addon of addons) {
      await client.query(
        `INSERT INTO listing_addons (
          listing_id,
          title,
          price_cents,
          delivery_days
        ) VALUES ($1, $2, $3, $4)`,
        [
          listingId,
          addon.title.trim(),
          Math.round(Number(addon.price) * 100),
          Number(addon.delivery_days),
        ],
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      listingId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create listing error:', err);
    return res.status(500).json({ error: 'Failed to create listing' });
  } finally {
    client.release();
  }
};

const getListings = async (req, res) => {
  try {
    const rawType = req.query.type;
    const rawMinPriceCents = req.query.minPriceCents;
    const rawMaxPriceCents = req.query.maxPriceCents;
    const rawSearch = req.query.q;
    const rawSort = req.query.sort;
    const rawLimit = req.query.limit;

    if (rawType !== undefined) {
      if (
        typeof rawType !== 'string' ||
        !allowedListingTypes.includes(rawType)
      ) {
        return res.status(400).json({
          error:
            'Type must be one of website, mobile, ecommerce, booking, or dashboard.',
        });
      }
    }

    if (rawSearch !== undefined) {
      if (typeof rawSearch !== 'string') {
        return res.status(400).json({
          error: 'Search query must be a string.',
        });
      }

      if (rawSearch.trim().length > 80) {
        return res.status(400).json({
          error: 'Search query must be 80 characters or less.',
        });
      }
    }

    if (rawSort !== undefined) {
      if (
        typeof rawSort !== 'string' ||
        !['newest', 'most_viewed'].includes(rawSort)
      ) {
        return res.status(400).json({
          error: 'Sort must be newest or most_viewed.',
        });
      }
    }

    const parsePriceQueryParam = (value, label) => {
      if (value === undefined) {
        return null;
      }

      if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        return { error: `${label} must be a non-negative integer.` };
      }

      return { value: Number.parseInt(value, 10) };
    };

    const parseLimitQueryParam = (value) => {
      if (value === undefined) {
        return null;
      }

      if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        return { error: 'Limit must be a positive integer.' };
      }

      const parsed = Number.parseInt(value, 10);

      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 24) {
        return { error: 'Limit must be between 1 and 24.' };
      }

      return { value: parsed };
    };

    const limitResult = parseLimitQueryParam(rawLimit);

    if (limitResult?.error) {
      return res.status(400).json({ error: limitResult.error });
    }

    const minPriceCentsResult = parsePriceQueryParam(
      rawMinPriceCents,
      'minPriceCents',
    );
    if (minPriceCentsResult?.error) {
      return res.status(400).json({ error: minPriceCentsResult.error });
    }

    const maxPriceCentsResult = parsePriceQueryParam(
      rawMaxPriceCents,
      'maxPriceCents',
    );
    if (maxPriceCentsResult?.error) {
      return res.status(400).json({ error: maxPriceCentsResult.error });
    }

    const whereClauses = [`l.status = 'published'`];
    const params = [];

    if (rawType) {
      params.push(rawType);
      whereClauses.push(`l.listing_type = $${params.length}`);
    }

    if (
      minPriceCentsResult?.value !== null &&
      minPriceCentsResult?.value !== undefined
    ) {
      params.push(minPriceCentsResult.value);
      whereClauses.push(`l.base_price_cents >= $${params.length}`);
    }

    if (
      maxPriceCentsResult?.value !== null &&
      maxPriceCentsResult?.value !== undefined
    ) {
      params.push(maxPriceCentsResult.value);
      whereClauses.push(`l.base_price_cents <= $${params.length}`);
    }

    const searchQuery = typeof rawSearch === 'string' ? rawSearch.trim() : '';

    if (searchQuery) {
      params.push(`%${searchQuery}%`);
      whereClauses.push(`(
        l.title ILIKE $${params.length}
        OR l.description ILIKE $${params.length}
        OR l.listing_type::text ILIKE $${params.length}
        OR EXISTS (
          SELECT 1
          FROM listing_stacks search_ls
          WHERE search_ls.listing_id = l.id
            AND search_ls.name ILIKE $${params.length}
        )
      )`);
    }

    const result = await pool.query(
      `SELECT
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.delivery_method,
        l.support_window_days,
        l.status,
        l.view_count,
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
        ) AS cover_image
        , COALESCE(
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT ls.name), NULL),
            '{}'
          ) AS stacks
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN listing_stacks ls ON ls.listing_id = l.id
      WHERE ${whereClauses.join('\n        AND ')}
      GROUP BY
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.delivery_method,
        l.support_window_days,
        l.status,
        l.view_count,
        l.created_at,
        u.full_name,
        u.username,
        u.status,
        u.deleted_at
      ORDER BY ${
        rawSort === 'most_viewed'
          ? 'l.view_count DESC, l.created_at DESC'
          : 'l.created_at DESC'
      }
      ${limitResult?.value ? `LIMIT ${limitResult.value}` : ''}`,
      params,
    );

    return res.json({ listings: result.rows });
  } catch (err) {
    console.error('Get listings error:', err);
    return res.status(500).json({ error: 'Failed to get listings' });
  }
};

const getListingSeo = async (req, res) => {
  try {
    const { listingId } = req.params;

    if (!isUuid(listingId)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    const listingResult = await pool.query(
      `
      SELECT
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.status,
        l.created_at,
        l.updated_at,
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
      FROM listings l
      JOIN users u ON u.id = l.seller_id
      LEFT JOIN listing_stacks ls ON ls.listing_id = l.id
      WHERE l.id = $1
        AND l.status = 'published'
      GROUP BY
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.status,
        l.created_at,
        l.updated_at,
        u.full_name,
        u.username,
        u.status,
        u.deleted_at
      LIMIT 1
      `,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    return res.json({ listing: listingResult.rows[0] });
  } catch (err) {
    console.error('Get listing SEO error:', err);
    return res.status(500).json({ error: 'Failed to get listing SEO data' });
  }
};

const getListingById = async (req, res) => {
  try {
    const { listingId } = req.params;

    const listingResult = await pool.query(
      `WITH viewed_listing AS (
        UPDATE listings
        SET view_count = view_count + 1
        WHERE id = $1
          AND status = 'published'
        RETURNING *
      )
      SELECT
        l.id,
        l.seller_id,
        l.listing_type,
        l.title,
        l.description,
        l.demo_url,
        l.base_price_cents,
        l.delivery_method,
        l.support_window_days,
        l.included,
        l.not_included,
        l.status,
        l.view_count,
        l.created_at,
        l.updated_at,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
          ELSE COALESCE(u.full_name, u.username)
        END AS seller_name,
        CASE
          WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
          ELSE u.username
        END AS seller_username
      FROM viewed_listing l
      JOIN users u ON u.id = l.seller_id
      `,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const stacksResult = await pool.query(
      `SELECT name
       FROM listing_stacks
       WHERE listing_id = $1
       ORDER BY name ASC`,
      [listingId],
    );

    const imagesResult = await pool.query(
      `SELECT url, public_id, position
       FROM listing_images
       WHERE listing_id = $1
       ORDER BY position ASC`,
      [listingId],
    );

    const addonsResult = await pool.query(
      `SELECT id, title, price_cents, delivery_days
       FROM listing_addons
       WHERE listing_id = $1
       ORDER BY title ASC`,
      [listingId],
    );

    return res.json({
      listing: {
        ...listingResult.rows[0],
        stacks: stacksResult.rows.map((row) => row.name),
        images: imagesResult.rows,
        addons: addonsResult.rows,
      },
    });
  } catch (err) {
    console.error('Get listing by id error:', err);
    return res.status(500).json({ error: 'Failed to get listing' });
  }
};

const getMyListingById = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    const listingResult = await pool.query(
      `SELECT
        l.id,
        l.seller_id,
        l.listing_type,
        l.title,
        l.description,
        l.demo_url,
        l.base_price_cents,
        l.delivery_method,
        l.support_window_days,
        l.included,
        l.not_included,
        l.status,
        l.created_at,
        l.updated_at
      FROM listings l
      WHERE l.id = $1
        AND l.seller_id = $2
        AND l.status = 'published'
      LIMIT 1`,
      [listingId, userId],
    );

    if (listingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const stacksResult = await pool.query(
      `SELECT name
       FROM listing_stacks
       WHERE listing_id = $1
       ORDER BY name ASC`,
      [listingId],
    );

    const imagesResult = await pool.query(
      `SELECT url, public_id, position
       FROM listing_images
       WHERE listing_id = $1
       ORDER BY position ASC`,
      [listingId],
    );

    const addonsResult = await pool.query(
      `SELECT id, title, price_cents, delivery_days
       FROM listing_addons
       WHERE listing_id = $1
       ORDER BY title ASC`,
      [listingId],
    );

    return res.json({
      listing: {
        ...listingResult.rows[0],
        stacks: stacksResult.rows.map((row) => row.name),
        images: imagesResult.rows,
        addons: addonsResult.rows,
      },
    });
  } catch (err) {
    console.error('Get my listing by id error:', err);
    return res.status(500).json({ error: 'Failed to get listing' });
  }
};

const getDraftListing = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT
        id,
        seller_id,
        listing_type,
        title,
        description,
        demo_url,
        base_price_cents,
        delivery_method,
        support_window_days,
        included,
        not_included,
        status,
        created_at,
        updated_at
      FROM listings
      WHERE seller_id = $1 AND status = 'draft'
      LIMIT 1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.json({ draft: null });
    }

    const draft = result.rows[0];

    const stacksResult = await pool.query(
      `SELECT name
       FROM listing_stacks
       WHERE listing_id = $1
       ORDER BY name ASC`,
      [draft.id],
    );

    const imagesResult = await pool.query(
      `SELECT url, public_id, position
       FROM listing_images
       WHERE listing_id = $1
       ORDER BY position ASC`,
      [draft.id],
    );

    const addonsResult = await pool.query(
      `SELECT id, title, price_cents, delivery_days
       FROM listing_addons
       WHERE listing_id = $1
       ORDER BY title ASC`,
      [draft.id],
    );

    return res.json({
      draft: {
        ...draft,
        stacks: stacksResult.rows.map((row) => row.name),
        images: imagesResult.rows,
        addons: addonsResult.rows,
      },
    });
  } catch (err) {
    console.error('Get draft listing error:', err);
    return res.status(500).json({ error: 'Failed to get draft listing' });
  }
};

const updateDraftListing = async (req, res) => {
  const client = await pool.connect();
  let oldImagePublicIds = [];

  try {
    const userId = req.user.id;

    const {
      title,
      description,
      demo_url,
      base_price,
      listing_type,
      delivery_method,
      support_window_days,
      included,
      not_included,
      stacks = [],
      images = [],
      addons = [],
    } = req.body;

    const listingType = getListingTypeFromPayload({ listing_type });

    await client.query('BEGIN');

    const draftResult = await client.query(
      `SELECT id
       FROM listings
       WHERE seller_id = $1 AND status = 'draft'
       LIMIT 1`,
      [userId],
    );

    let listingId;

    if (draftResult.rows.length === 0) {
      const createdDraft = await client.query(
        `INSERT INTO listings (
          seller_id,
          listing_type,
          title,
          description,
          demo_url,
          base_price_cents,
          delivery_method,
          support_window_days,
          included,
          not_included,
          status
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft'
        )
        RETURNING id`,
        [
          userId,
          listingType,
          title.trim(),
          description.trim(),
          demo_url || null,
          Math.round(Number(base_price) * 100),
          delivery_method,
          Number(support_window_days),
          included || null,
          not_included || null,
        ],
      );

      listingId = createdDraft.rows[0].id;
    } else {
      listingId = draftResult.rows[0].id;

      await client.query(
        `UPDATE listings
         SET
          listing_type = $1,
          title = $2,
          description = $3,
          demo_url = $4,
          base_price_cents = $5,
          delivery_method = $6,
          support_window_days = $7,
          included = $8,
          not_included = $9,
          updated_at = NOW()
         WHERE id = $10 AND seller_id = $11 AND status = 'draft'`,
        [
          listingType,
          title.trim(),
          description.trim(),
          demo_url || null,
          Math.round(Number(base_price) * 100),
          delivery_method,
          Number(support_window_days),
          included || null,
          not_included || null,
          listingId,
          userId,
        ],
      );
    }

    oldImagePublicIds = await getListingImagePublicIdsForCleanup(
      client,
      listingId,
    );

    await client.query(`DELETE FROM listing_stacks WHERE listing_id = $1`, [
      listingId,
    ]);
    await client.query(`DELETE FROM listing_images WHERE listing_id = $1`, [
      listingId,
    ]);
    await client.query(`DELETE FROM listing_addons WHERE listing_id = $1`, [
      listingId,
    ]);

    for (const stack of stacks) {
      await client.query(
        `INSERT INTO listing_stacks (listing_id, name)
         VALUES ($1, $2)`,
        [listingId, stack.trim()],
      );
    }

    for (let i = 0; i < images.length; i++) {
      const image = normalizeListingImageInput(images[i]);

      await client.query(
        `INSERT INTO listing_images (listing_id, url, position, public_id)
         VALUES ($1, $2, $3, $4)`,
        [listingId, image.url, i, image.publicId],
      );
    }

    for (const addon of addons) {
      await client.query(
        `INSERT INTO listing_addons (
          listing_id,
          title,
          price_cents,
          delivery_days
        ) VALUES ($1, $2, $3, $4)`,
        [
          listingId,
          addon.title.trim(),
          Math.round(Number(addon.price) * 100),
          Number(addon.delivery_days),
        ],
      );
    }

    await client.query('COMMIT');

    await destroyListingImageAssets(
      getRemovedImagePublicIdsForCleanup(oldImagePublicIds, images),
      'draft_listing_image_replace_cleanup',
    );

    return res.json({
      success: true,
      listingId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update draft listing error:', err);
    return res.status(500).json({ error: 'Failed to update draft listing' });
  } finally {
    client.release();
  }
};

const publishDraftListing = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT
        id,
        listing_type,
        title,
        description,
        base_price_cents,
        delivery_method,
        support_window_days
      FROM listings
      WHERE seller_id = $1 AND status = 'draft'
      LIMIT 1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Draft listing not found' });
    }

    const draft = result.rows[0];
    const errors = {};

    if (!allowedListingTypes.includes(draft.listing_type)) {
      errors.listing_type = 'Valid listing type is required.';
    }

    if (!isNonEmptyString(draft.title) || draft.title.length > 35) {
      errors.title = 'Valid title is required.';
    }

    if (
      !isNonEmptyString(draft.description) ||
      draft.description.length > 500
    ) {
      errors.description = 'Valid description is required.';
    }

    if (
      !Number.isInteger(draft.base_price_cents) ||
      draft.base_price_cents < 0
    ) {
      errors.base_price = 'Valid base price is required.';
    }

    if (!allowedDeliveryMethods.includes(draft.delivery_method)) {
      errors.delivery_method = 'Valid delivery method is required.';
    }

    if (
      !Number.isInteger(draft.support_window_days) ||
      draft.support_window_days < 0
    ) {
      errors.support_window_days = 'Valid support window is required.';
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ fieldErrors: errors });
    }

    await pool.query(
      `UPDATE listings
       SET status = 'published',
           updated_at = NOW()
       WHERE id = $1 AND seller_id = $2 AND status = 'draft'`,
      [draft.id, userId],
    );

    return res.json({
      success: true,
      listingId: draft.id,
    });
  } catch (err) {
    console.error('Publish draft listing error:', err);
    return res.status(500).json({ error: 'Failed to publish draft listing' });
  }
};

const getMyPublishedListings = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT
        l.id,
        l.listing_type,
        l.title,
        l.description,
        l.base_price_cents,
        l.delivery_method,
        l.support_window_days,
        l.status,
        l.created_at,
        l.updated_at,
        (
          SELECT li.url
          FROM listing_images li
          WHERE li.listing_id = l.id
          ORDER BY li.position ASC
          LIMIT 1
        ) AS cover_image
      FROM listings l
      WHERE l.seller_id = $1
        AND l.status = 'published'
      ORDER BY l.updated_at DESC`,
      [userId],
    );

    return res.json({
      listings: result.rows,
    });
  } catch (err) {
    console.error('Get my published listings error:', err);
    return res.status(500).json({ error: 'Failed to get seller listings' });
  }
};

const deleteListing = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    const result = await hardDeleteListing({
      listingId,
      sellerId: userId,
      statuses: ['draft', 'published', 'archived', 'disabled'],
      context: 'seller_listing_delete',
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    return res.json({
      success: true,
      listingId,
    });
  } catch (err) {
    console.error('Delete listing error:', err);
    return res.status(500).json({ error: 'Failed to delete listing' });
  }
};

const updatePublishedListing = async (req, res) => {
  const client = await pool.connect();
  let oldImagePublicIds = [];

  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    const {
      title,
      description,
      demo_url,
      base_price,
      listing_type,
      delivery_method,
      support_window_days,
      included,
      not_included,
      stacks = [],
      images = [],
      addons = [],
    } = req.body;

    const listingType = getListingTypeFromPayload({ listing_type });

    const { errors, priceNumber, supportDays } = validateListingPayload({
      title,
      description,
      base_price,
      listing_type: listingType,
      delivery_method,
      support_window_days,
      stacks,
      images,
      addons,
    });

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ fieldErrors: errors });
    }

    const existingListing = await client.query(
      `SELECT id
       FROM listings
       WHERE id = $1
         AND seller_id = $2
         AND status = 'published'
       LIMIT 1`,
      [listingId, userId],
    );

    if (existingListing.rows.length === 0) {
      return res.status(404).json({ error: 'Published listing not found' });
    }

    await client.query('BEGIN');

    oldImagePublicIds = await getListingImagePublicIdsForCleanup(
      client,
      listingId,
    );

    await client.query(
      `UPDATE listings
       SET
        listing_type = $1,
        title = $2,
        description = $3,
        demo_url = $4,
        base_price_cents = $5,
        delivery_method = $6,
        support_window_days = $7,
        included = $8,
        not_included = $9,
        updated_at = NOW()
       WHERE id = $10
         AND seller_id = $11
         AND status = 'published'`,
      [
        listingType,
        title.trim(),
        description.trim(),
        demo_url || null,
        Math.round(priceNumber * 100),
        delivery_method,
        supportDays,
        included || null,
        not_included || null,
        listingId,
        userId,
      ],
    );

    await client.query(`DELETE FROM listing_stacks WHERE listing_id = $1`, [
      listingId,
    ]);
    await client.query(`DELETE FROM listing_images WHERE listing_id = $1`, [
      listingId,
    ]);
    await client.query(`DELETE FROM listing_addons WHERE listing_id = $1`, [
      listingId,
    ]);

    for (const stack of stacks) {
      await client.query(
        `INSERT INTO listing_stacks (listing_id, name)
         VALUES ($1, $2)`,
        [listingId, stack.trim()],
      );
    }

    for (let i = 0; i < images.length; i++) {
      const image = normalizeListingImageInput(images[i]);

      await client.query(
        `INSERT INTO listing_images (listing_id, url, position, public_id)
         VALUES ($1, $2, $3, $4)`,
        [listingId, image.url, i, image.publicId],
      );
    }

    for (const addon of addons) {
      await client.query(
        `INSERT INTO listing_addons (
          listing_id,
          title,
          price_cents,
          delivery_days
        ) VALUES ($1, $2, $3, $4)`,
        [
          listingId,
          addon.title.trim(),
          Math.round(Number(addon.price) * 100),
          Number(addon.delivery_days),
        ],
      );
    }

    await client.query('COMMIT');

    await destroyListingImageAssets(
      getRemovedImagePublicIdsForCleanup(oldImagePublicIds, images),
      'published_listing_image_replace_cleanup',
    );

    return res.json({
      success: true,
      listingId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update published listing error:', err);
    return res
      .status(500)
      .json({ error: 'Failed to update published listing' });
  } finally {
    client.release();
  }
};

const getPublishedListingForQa = async (listingId) => {
  if (!isUuid(listingId)) return null;

  const result = await pool.query(
    `SELECT id, seller_id, title
     FROM listings
     WHERE id = $1::uuid
       AND status = 'published'
     LIMIT 1`,
    [listingId],
  );

  return result.rows[0] || null;
};

function getListingPublicUrl(listingId) {
  return `/listing/${listingId}`;
}

async function notifyListingQuestionCreated({ listing, question, authorId }) {
  if (String(listing.seller_id) === String(authorId)) return;

  await createNotificationWithEmail({
    userId: listing.seller_id,
    type: 'listing_question_created',
    title: 'New question on your listing',
    body: `Someone asked a question on "${listing.title}".`,
    actionUrl: getListingPublicUrl(listing.id),
    metadata: {
      listingId: listing.id,
      questionId: question.id,
    },
    emailSubject: 'New question on your listing',
    emailTitle: 'New question on your listing',
    emailBody: `Someone asked a question on "${listing.title}".`,
    emailActionLabel: 'View question',
  });
}

async function notifyListingQuestionReplyCreated({
  listing,
  question,
  reply,
  authorId,
}) {
  if (String(question.user_id) === String(authorId)) return;

  await createNotificationWithEmail({
    userId: question.user_id,
    type: 'listing_question_reply_created',
    title: 'Someone replied to your question',
    body: `Your question on "${listing.title}" got a reply.`,
    actionUrl: getListingPublicUrl(listing.id),
    metadata: {
      listingId: listing.id,
      questionId: question.id,
      replyId: reply.id,
    },
    emailSubject: 'Someone replied to your question',
    emailTitle: 'Someone replied to your question',
    emailBody: `Your question on "${listing.title}" got a reply.`,
    emailActionLabel: 'View reply',
  });
}

async function notifyListingQuestionLiked({ listing, question, likerId }) {
  if (String(question.user_id) === String(likerId)) return;

  await createNotificationWithEmail({
    userId: question.user_id,
    type: 'listing_question_liked',
    title: 'Someone liked your question',
    body: `Someone liked your question on "${listing.title}".`,
    actionUrl: getListingPublicUrl(listing.id),
    metadata: {
      listingId: listing.id,
      questionId: question.id,
    },
    emailSubject: 'Someone liked your question',
    emailTitle: 'Someone liked your question',
    emailBody: `Someone liked your question on "${listing.title}".`,
    emailActionLabel: 'View question',
  });
}

const mapQaAuthor = (row, prefix) => ({
  id: String(row[`${prefix}_author_id`] ?? ''),
  fullName: row[`${prefix}_author_name`] || null,
  username: row[`${prefix}_author_username`] || null,
  role: row[`${prefix}_author_role`] || 'buyer',
});

const getListingQaThreadById = async ({ listingId, questionId, viewerId }) => {
  const questionResult = await pool.query(
    `SELECT
       q.id,
       q.text,
       q.created_at,
       q.updated_at,
       q.user_id AS question_author_id,
       CASE
         WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
         ELSE COALESCE(u.full_name, u.username)
       END AS question_author_name,
       CASE
         WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
         ELSE u.username
       END AS question_author_username,
       CASE
         WHEN q.user_id = l.seller_id THEN 'seller'
         ELSE 'buyer'
       END AS question_author_role,
       (
         SELECT COUNT(*)::int
         FROM listing_question_likes ql
         WHERE ql.question_id = q.id
       ) AS likes_count,
       CASE
         WHEN $3::bigint IS NULL THEN false
         ELSE EXISTS (
           SELECT 1
           FROM listing_question_likes my_like
           WHERE my_like.question_id = q.id
             AND my_like.user_id = $3::bigint
         )
       END AS liked_by_me
     FROM listing_questions q
     JOIN listings l ON l.id = q.listing_id
     JOIN users u ON u.id = q.user_id
     WHERE q.id = $1::uuid
       AND q.listing_id = $2::uuid
       AND q.deleted_at IS NULL
       AND l.status = 'published'
     LIMIT 1`,
    [questionId, listingId, viewerId],
  );

  const question = questionResult.rows[0];
  if (!question) return null;

  const repliesResult = await pool.query(
    `SELECT
       r.id,
       r.question_id,
       r.text,
       r.created_at,
       r.updated_at,
       r.user_id AS reply_author_id,
       CASE
         WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
         ELSE COALESCE(u.full_name, u.username)
       END AS reply_author_name,
       CASE
         WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
         ELSE u.username
       END AS reply_author_username,
       CASE
         WHEN r.user_id = l.seller_id THEN 'seller'
         ELSE 'buyer'
       END AS reply_author_role
     FROM listing_question_replies r
     JOIN listing_questions q ON q.id = r.question_id
     JOIN listings l ON l.id = q.listing_id
     JOIN users u ON u.id = r.user_id
     WHERE r.question_id = $1::uuid
       AND r.deleted_at IS NULL
       AND q.deleted_at IS NULL
     ORDER BY r.created_at ASC`,
    [questionId],
  );

  return {
    id: question.id,
    question: {
      id: question.id,
      text: question.text,
      createdAt: question.created_at,
      updatedAt: question.updated_at,
      author: mapQaAuthor(question, 'question'),
    },
    replies: repliesResult.rows.map((reply) => ({
      id: reply.id,
      text: reply.text,
      createdAt: reply.created_at,
      updatedAt: reply.updated_at,
      author: mapQaAuthor(reply, 'reply'),
    })),
    likesCount: Number(question.likes_count || 0),
    likedByMe: Boolean(question.liked_by_me),
  };
};

const getListingQa = async (req, res) => {
  try {
    const { listingId } = req.params;

    if (!isUuid(listingId)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    const listing = await getPublishedListingForQa(listingId);

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const viewerId = getOptionalUserId(req);

    const questionsResult = await pool.query(
      `SELECT
         q.id,
         q.text,
         q.created_at,
         q.updated_at,
         q.user_id AS question_author_id,
         CASE
           WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
           ELSE COALESCE(u.full_name, u.username)
         END AS question_author_name,
         CASE
           WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
           ELSE u.username
         END AS question_author_username,
         CASE
           WHEN q.user_id = l.seller_id THEN 'seller'
           ELSE 'buyer'
         END AS question_author_role,
         (
           SELECT COUNT(*)::int
           FROM listing_question_likes ql
           WHERE ql.question_id = q.id
         ) AS likes_count,
         CASE
           WHEN $2::bigint IS NULL THEN false
           ELSE EXISTS (
             SELECT 1
             FROM listing_question_likes my_like
             WHERE my_like.question_id = q.id
               AND my_like.user_id = $2::bigint
           )
         END AS liked_by_me
       FROM listing_questions q
       JOIN listings l ON l.id = q.listing_id
       JOIN users u ON u.id = q.user_id
       WHERE q.listing_id = $1::uuid
         AND q.deleted_at IS NULL
         AND l.status = 'published'
       ORDER BY q.created_at DESC`,
      [listingId, viewerId],
    );

    const questionIds = questionsResult.rows.map((question) => question.id);

    let repliesByQuestionId = new Map();

    if (questionIds.length > 0) {
      const repliesResult = await pool.query(
        `SELECT
           r.id,
           r.question_id,
           r.text,
           r.created_at,
           r.updated_at,
           r.user_id AS reply_author_id,
           CASE
             WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN 'Deleted user'
             ELSE COALESCE(u.full_name, u.username)
           END AS reply_author_name,
           CASE
             WHEN u.status = 'deleted' OR u.deleted_at IS NOT NULL THEN NULL
             ELSE u.username
           END AS reply_author_username,
           CASE
             WHEN r.user_id = l.seller_id THEN 'seller'
             ELSE 'buyer'
           END AS reply_author_role
         FROM listing_question_replies r
         JOIN listing_questions q ON q.id = r.question_id
         JOIN listings l ON l.id = q.listing_id
         JOIN users u ON u.id = r.user_id
         WHERE r.question_id = ANY($1::uuid[])
           AND r.deleted_at IS NULL
           AND q.deleted_at IS NULL
         ORDER BY r.created_at ASC`,
        [questionIds],
      );

      repliesByQuestionId = repliesResult.rows.reduce((map, reply) => {
        const key = String(reply.question_id);
        const current = map.get(key) || [];

        current.push({
          id: reply.id,
          text: reply.text,
          createdAt: reply.created_at,
          updatedAt: reply.updated_at,
          author: mapQaAuthor(reply, 'reply'),
        });

        map.set(key, current);
        return map;
      }, new Map());
    }

    const threads = questionsResult.rows.map((question) => ({
      id: question.id,
      question: {
        id: question.id,
        text: question.text,
        createdAt: question.created_at,
        updatedAt: question.updated_at,
        author: mapQaAuthor(question, 'question'),
      },
      replies: repliesByQuestionId.get(String(question.id)) || [],
      likesCount: Number(question.likes_count || 0),
      likedByMe: Boolean(question.liked_by_me),
    }));

    return res.json({ threads });
  } catch (err) {
    console.error('Get listing Q&A error:', err);
    return res.status(500).json({ error: 'Failed to get listing Q&A' });
  }
};

const createListingQuestion = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId } = req.params;

    if (!isUuid(listingId)) {
      return res.status(400).json({ error: 'Invalid listing id' });
    }

    const listing = await getPublishedListingForQa(listingId);

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const { text, error } = normalizeQaText(req.body?.text, 800);

    if (error) {
      return res.status(400).json({ error });
    }

    const inserted = await pool.query(
      `INSERT INTO listing_questions (
         listing_id,
         user_id,
         text
       ) VALUES (
         $1::uuid,
         $2::bigint,
         $3::text
       )
       RETURNING id, user_id`,
      [listingId, userId, text],
    );

    const thread = await getListingQaThreadById({
      listingId,
      questionId: inserted.rows[0].id,
      viewerId: userId,
    });

    await notifyListingQuestionCreated({
      listing,
      question: inserted.rows[0],
      authorId: userId,
    });

    return res.status(201).json({ thread });
  } catch (err) {
    console.error('Create listing question error:', err);
    return res.status(500).json({ error: 'Failed to post question' });
  }
};

const updateListingQuestion = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId, questionId } = req.params;

    if (!isUuid(listingId) || !isUuid(questionId)) {
      return res.status(400).json({ error: 'Invalid Q&A id' });
    }

    const { text, error } = normalizeQaText(req.body?.text, 800);

    if (error) {
      return res.status(400).json({ error });
    }

    const result = await pool.query(
      `UPDATE listing_questions q
       SET text = $4::text,
           updated_at = NOW()
       FROM listings l
       WHERE q.id = $1::uuid
         AND q.listing_id = $2::uuid
         AND q.user_id = $3::bigint
         AND q.deleted_at IS NULL
         AND l.id = q.listing_id
         AND l.status = 'published'
       RETURNING q.id`,
      [questionId, listingId, userId, text],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const thread = await getListingQaThreadById({
      listingId,
      questionId,
      viewerId: userId,
    });

    return res.json({ thread });
  } catch (err) {
    console.error('Update listing question error:', err);
    return res.status(500).json({ error: 'Failed to update question' });
  }
};

const createListingQuestionReply = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId, questionId } = req.params;

    if (!isUuid(listingId) || !isUuid(questionId)) {
      return res.status(400).json({ error: 'Invalid Q&A id' });
    }

    const { text, error } = normalizeQaText(req.body?.text, 1200);

    if (error) {
      return res.status(400).json({ error });
    }

    const questionResult = await pool.query(
      `SELECT
         q.id,
         q.user_id,
         l.id AS listing_id,
         l.seller_id,
         l.title
       FROM listing_questions q
       JOIN listings l ON l.id = q.listing_id
       WHERE q.id = $1::uuid
         AND q.listing_id = $2::uuid
         AND q.deleted_at IS NULL
         AND l.status = 'published'
       LIMIT 1`,
      [questionId, listingId],
    );

    if (questionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const insertedReply = await pool.query(
      `INSERT INTO listing_question_replies (
         question_id,
         user_id,
         text
       ) VALUES (
         $1::uuid,
         $2::bigint,
         $3::text
       )
       RETURNING id, user_id`,
      [questionId, userId, text],
    );

    const thread = await getListingQaThreadById({
      listingId,
      questionId,
      viewerId: userId,
    });

    await notifyListingQuestionReplyCreated({
      listing: {
        id: questionResult.rows[0].listing_id,
        seller_id: questionResult.rows[0].seller_id,
        title: questionResult.rows[0].title,
      },
      question: questionResult.rows[0],
      reply: insertedReply.rows[0],
      authorId: userId,
    });

    return res.status(201).json({ thread });
  } catch (err) {
    console.error('Create listing question reply error:', err);
    return res.status(500).json({ error: 'Failed to post reply' });
  }
};

const updateListingQuestionReply = async (req, res) => {
  try {
    const userId = req.user.id;
    const { listingId, questionId, replyId } = req.params;

    if (!isUuid(listingId) || !isUuid(questionId) || !isUuid(replyId)) {
      return res.status(400).json({ error: 'Invalid Q&A id' });
    }

    const { text, error } = normalizeQaText(req.body?.text, 1200);

    if (error) {
      return res.status(400).json({ error });
    }

    const result = await pool.query(
      `UPDATE listing_question_replies r
       SET text = $5::text,
           updated_at = NOW()
       FROM listing_questions q
       JOIN listings l ON l.id = q.listing_id
       WHERE r.id = $1::uuid
         AND r.question_id = $2::uuid
         AND q.id = r.question_id
         AND q.listing_id = $3::uuid
         AND r.user_id = $4::bigint
         AND r.deleted_at IS NULL
         AND q.deleted_at IS NULL
         AND l.status = 'published'
       RETURNING r.id`,
      [replyId, questionId, listingId, userId, text],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    const thread = await getListingQaThreadById({
      listingId,
      questionId,
      viewerId: userId,
    });

    return res.json({ thread });
  } catch (err) {
    console.error('Update listing question reply error:', err);
    return res.status(500).json({ error: 'Failed to update reply' });
  }
};

const toggleListingQuestionLike = async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = req.user.id;
    const { listingId, questionId } = req.params;

    if (!isUuid(listingId) || !isUuid(questionId)) {
      return res.status(400).json({ error: 'Invalid Q&A id' });
    }

    const questionResult = await client.query(
      `SELECT
         q.id,
         q.user_id,
         l.id AS listing_id,
         l.seller_id,
         l.title
       FROM listing_questions q
       JOIN listings l ON l.id = q.listing_id
       WHERE q.id = $1::uuid
         AND q.listing_id = $2::uuid
         AND q.deleted_at IS NULL
         AND l.status = 'published'
       LIMIT 1`,
      [questionId, listingId],
    );

    if (questionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    await client.query('BEGIN');

    const existingLike = await client.query(
      `SELECT 1
       FROM listing_question_likes
       WHERE question_id = $1::uuid
         AND user_id = $2::bigint
       LIMIT 1`,
      [questionId, userId],
    );

    let liked;

    if (existingLike.rows.length > 0) {
      await client.query(
        `DELETE FROM listing_question_likes
         WHERE question_id = $1::uuid
           AND user_id = $2::bigint`,
        [questionId, userId],
      );

      liked = false;
    } else {
      await client.query(
        `INSERT INTO listing_question_likes (
           question_id,
           user_id
         ) VALUES (
           $1::uuid,
           $2::bigint
         )
         ON CONFLICT (question_id, user_id) DO NOTHING`,
        [questionId, userId],
      );

      liked = true;
    }

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS likes_count
       FROM listing_question_likes
       WHERE question_id = $1::uuid`,
      [questionId],
    );

    await client.query('COMMIT');

    if (liked) {
      await notifyListingQuestionLiked({
        listing: {
          id: questionResult.rows[0].listing_id,
          seller_id: questionResult.rows[0].seller_id,
          title: questionResult.rows[0].title,
        },
        question: questionResult.rows[0],
        likerId: userId,
      });
    }

    return res.json({
      liked,
      likesCount: Number(countResult.rows[0]?.likes_count || 0),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Toggle listing question like error:', err);
    return res.status(500).json({ error: 'Failed to update like' });
  } finally {
    client.release();
  }
};

module.exports = {
  createListing,
  getListings,
  getListingSeo,
  getListingById,
  getMyListingById,
  getDraftListing,
  updateDraftListing,
  publishDraftListing,
  getMyPublishedListings,
  deleteListing,
  updatePublishedListing,
  getListingQa,
  createListingQuestion,
  updateListingQuestion,
  createListingQuestionReply,
  updateListingQuestionReply,
  toggleListingQuestionLike,
};
