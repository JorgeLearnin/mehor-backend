'use strict';

const crypto = require('crypto');
const { db } = require('../db/db');
const { verifySession } = require('../utils/jwt');
const { createNotification } = require('./notifications.controller');
const {
  deleteListingScreenshotByPublicId,
  createSignedImageUploadParams,
} = require('../utils/cloudinary');
const { safeJsonParse, toInt } = require('../utils/order');

function extractMentions(text) {
  const body = String(text ?? '');
  if (!body) return [];

  // Usernames are limited by backend auth rules; keep parsing conservative.
  // Matches @username at start or after a non-word char.
  const re = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{2,30})\b/g;
  const out = new Set();
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(body)) !== null) {
    const u = String(m[2] || '').trim();
    if (u) out.add(u.toLowerCase());
    if (out.size >= 5) break;
  }
  return Array.from(out);
}

async function notifyMentionsInQa({
  text,
  fromUserId,
  listingId,
  questionId,
  replyId,
}) {
  try {
    const usernames = extractMentions(text);
    if (usernames.length === 0) return;

    const placeholders = usernames.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT id, username
           FROM users
          WHERE username IS NOT NULL
            AND LOWER(username) IN (${placeholders})
          LIMIT 10`,
      )
      .all(...usernames);

    for (const r of rows) {
      const mentionedId = String(r?.id ?? '').trim();
      if (!mentionedId || mentionedId === String(fromUserId)) continue;

      await createNotification({
        userId: mentionedId,
        type: 'mention',
        title: "You've been mentioned",
        detail: 'Someone mentioned you in listing Q&A',
        entityType: 'listing',
        entityId: listingId,
        data: {
          questionId: questionId || null,
          replyId: replyId || null,
        },
      });
    }
  } catch {
    // Best-effort.
  }
}

function getViewerUserId(req) {
  try {
    const name = process.env.COOKIE_NAME || 'mehor_session';
    const token = req.cookies?.[name];
    if (!token) return null;
    const user = verifySession(token);
    const id = String(user?.id ?? '').trim();
    return id || null;
  } catch {
    return null;
  }
}

function normalizeCategory(category) {
  const c = String(category || '').trim();
  const allowed = new Set([
    'website',
    'mobile',
    'ecommerce',
    'booking',
    'dashboard',
  ]);
  return allowed.has(c) ? c : null;
}

function normalizeDeliveryMethod(deliveryMethod) {
  const m = String(deliveryMethod || '').trim();
  const allowed = new Set(['repo', 'zip', 'both']);
  return allowed.has(m) ? m : null;
}

function normalizeListingStatus(status) {
  const s = String(status || '').trim();
  const allowed = new Set(['active', 'draft']);
  return allowed.has(s) ? s : null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  );
}

function listingCategoryToType(category) {
  switch (category) {
    case 'website':
      return 'Websites';
    case 'mobile':
      return 'Mobile Apps';
    case 'ecommerce':
      return 'Ecommerce';
    case 'booking':
      return 'Booking';
    case 'dashboard':
      return 'Dashboards';
    default:
      return 'Websites';
  }
}

function publicTypeToListingCategory(type) {
  switch (String(type || '').trim()) {
    case 'Websites':
      return 'website';
    case 'Mobile Apps':
      return 'mobile';
    case 'Ecommerce':
      return 'ecommerce';
    case 'Booking':
      return 'booking';
    case 'Dashboards':
      return 'dashboard';
    case '':
    case 'All':
      return null;
    default:
      return undefined;
  }
}

function stackToTags(stack) {
  if (typeof stack !== 'string') return [];
  return stack
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function rowToPublicListing(row) {
  const type = listingCategoryToType(row.category);
  const price = row.price_usd;
  const tier = price < 500 ? 'Starter' : 'Serious MVP';

  const screenshots = safeJsonParse(row.screenshotsJson, []);
  const primaryImageUrl =
    Array.isArray(screenshots) && screenshots.length > 0
      ? String(screenshots[0]?.url || '').trim()
      : '';

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    price,
    type,
    tags: stackToTags(row.stack || ''),
    imageUrl: primaryImageUrl || null,
    tier,
    flags: {
      liveDemo: Boolean(row.demo_url && String(row.demo_url).trim()),
      fastDelivery:
        row.delivery_method === 'zip' || row.delivery_method === 'both',
    },
  };
}

async function getListingById(id) {
  return await db
    .prepare(
      `SELECT id,
              seller_id AS sellerId,
              status,
              title,
              category,
              description,
              stack,
              demo_url AS demoUrl,
              price_usd AS priceUsd,
              add_ons_json AS addOnsJson,
              includes,
              not_included AS notIncluded,
              notes,
              support_days AS supportDays,
              delivery_method AS deliveryMethod,
              screenshots_json AS screenshotsJson,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM listings
       WHERE id = ?`,
    )
    .get(id);
}

function rowToMyListing(row) {
  const addOnsJson = safeJsonParse(row.addOnsJson, {
    addOns: [],
    addOnPrices: {},
    addOnTimes: {},
  });
  const screenshots = safeJsonParse(row.screenshotsJson, []);

  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    stack: row.stack ?? '',
    demoUrl: row.demoUrl ?? '',
    price: Number(row.priceUsd ?? 0),
    addOns: Array.isArray(addOnsJson.addOns) ? addOnsJson.addOns : [],
    addOnPrices:
      typeof addOnsJson.addOnPrices === 'object' && addOnsJson.addOnPrices
        ? addOnsJson.addOnPrices
        : {},
    addOnTimes:
      typeof addOnsJson.addOnTimes === 'object' && addOnsJson.addOnTimes
        ? addOnsJson.addOnTimes
        : {},
    includes: row.includes,
    notIncluded: row.notIncluded ?? '',
    notes: row.notes ?? '',
    supportDays: row.supportDays ?? '',
    deliveryMethod: row.deliveryMethod,
    screenshots,
  };
}

function toSellerDisplayName(row) {
  const displayName = String(row.sellerDisplayName ?? '').trim();
  if (displayName) return displayName;

  const username = String(row.sellerUsername ?? '').trim();
  if (username) return username;

  return 'Seller';
}

function toSellerUsername(row) {
  const username = String(row.sellerUsername ?? '').trim();
  if (username) return username;
  return null;
}

function sellerCreatedAtToYear(row) {
  const createdAt = String(row.sellerCreatedAt ?? '').trim();
  if (!createdAt) return null;
  const d = new Date(createdAt);
  if (!Number.isFinite(d.getTime())) return null;
  return String(d.getUTCFullYear());
}

function toUserFullName(row) {
  const fullName = String(row.display_name ?? '').trim();
  if (fullName) return fullName;

  const username = String(row.username ?? '').trim();
  if (username) return username;

  return 'User';
}

function toUserUsername(row) {
  const username = String(row.username ?? '').trim();
  if (username) return username;
  return null;
}

function formatQaAuthor({ row, listingSellerId }) {
  const id = String(row.userId ?? row.id ?? '').trim();
  const role =
    id && listingSellerId && id === listingSellerId ? 'seller' : 'buyer';
  return {
    id,
    fullName: toUserFullName(row),
    username: toUserUsername(row),
    role,
  };
}

async function buildQaThreads({ questionRows, listingSellerId, viewerUserId }) {
  const rows = Array.isArray(questionRows) ? questionRows : [];
  const questionIds = rows.map((q) => q.id);

  const likeRows =
    questionIds.length === 0
      ? []
      : await db
          .prepare(
            `SELECT question_id AS questionId,
                    COUNT(*) AS likesCount,
                    SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS likedByViewer
               FROM listing_question_likes
              WHERE question_id IN (${questionIds.map(() => '?').join(', ')})
              GROUP BY question_id`,
          )
          .all(viewerUserId || '__no_user__', ...questionIds);

  const likesByQuestionId = new Map();
  for (const r of likeRows) {
    likesByQuestionId.set(String(r.questionId), {
      likesCount: Number(r.likesCount ?? 0),
      likedByMe: Number(r.likedByViewer ?? 0) > 0,
    });
  }

  const replyRows =
    questionIds.length === 0
      ? []
      : await db
          .prepare(
            `SELECT r.id,
                    r.question_id AS questionId,
                    r.reply,
                    r.created_at AS createdAt,
                    u.id AS userId,
                    u.username,
                    u.display_name AS display_name,
                    u.avatar_url AS avatarUrl
               FROM listing_question_replies r
               JOIN users u ON u.id = r.user_id
              WHERE r.question_id IN (${questionIds.map(() => '?').join(', ')})
              ORDER BY r.created_at ASC`,
          )
          .all(...questionIds);

  const repliesByQuestionId = new Map();
  for (const r of replyRows) {
    const key = String(r.questionId);
    const arr = repliesByQuestionId.get(key) ?? [];
    arr.push({
      id: r.id,
      text: r.reply,
      createdAt: r.createdAt,
      author: formatQaAuthor({ row: r, listingSellerId }),
    });
    repliesByQuestionId.set(key, arr);
  }

  return rows.map((q) => ({
    id: q.id,
    question: {
      id: q.id,
      text: q.question,
      createdAt: q.createdAt,
      author: formatQaAuthor({ row: q, listingSellerId }),
    },
    replies: repliesByQuestionId.get(String(q.id)) ?? [],
    likesCount: likesByQuestionId.get(String(q.id))?.likesCount ?? 0,
    likedByMe: likesByQuestionId.get(String(q.id))?.likedByMe ?? false,
  }));
}

function normalizeUploadedScreenshots(value, listingId) {
  const list = Array.isArray(value) ? value : [];
  const prefix = `mehor/listings/${listingId}/shot_`;

  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;

      const url = String(item.url ?? '').trim();
      const publicId = String(item.publicId ?? '').trim();
      const width = Number(item.width ?? 0);
      const height = Number(item.height ?? 0);

      if (!url || !/cloudinary\.com\//i.test(url)) return null;
      if (!publicId || !publicId.startsWith(prefix)) return null;

      return {
        url,
        publicId,
        width:
          Number.isFinite(width) && width > 0 ? Math.round(width) : undefined,
        height:
          Number.isFinite(height) && height > 0
            ? Math.round(height)
            : undefined,
      };
    })
    .filter(Boolean);
}

async function createListingScreenshotUploadSignature(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = String(req.body?.listingId ?? '').trim();
  const index = toInt(req.body?.index, { min: 1, max: 20 });

  if (!isUuid(listingId)) {
    return res.status(400).json({ error: 'Invalid listing id' });
  }
  if (!Number.isFinite(index)) {
    return res.status(400).json({ error: 'Invalid screenshot index' });
  }

  const existing = await getListingById(listingId);
  if (existing && existing.sellerId !== sellerId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const signed = createSignedImageUploadParams({
      folder: `mehor/listings/${listingId}`,
      publicId: `shot_${index}`,
    });
    return res.json({ ok: true, upload: signed });
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    const message =
      e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED'
        ? 'Image storage is not configured'
        : 'Could not prepare image upload';
    return res.status(status).json({ error: message });
  }
}

async function createListing(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const status = normalizeListingStatus(req.body?.status) || 'active';

  const title = String(req.body?.title ?? '').trim();
  const category = normalizeCategory(req.body?.category);
  const description = String(req.body?.description ?? '').trim();
  const stack =
    typeof req.body?.stack === 'string' ? req.body.stack.trim() : '';
  const demoUrl =
    typeof req.body?.demoUrl === 'string' ? req.body.demoUrl.trim() : '';
  const priceUsd = toInt(req.body?.price, { min: 1, max: 500_000 });
  const includes = String(req.body?.includes ?? '').trim();
  const notIncluded =
    typeof req.body?.notIncluded === 'string'
      ? req.body.notIncluded.trim()
      : '';
  const notes =
    typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  const supportDays = req.body?.supportDays
    ? toInt(req.body.supportDays, { min: 0, max: 365 })
    : null;
  const deliveryMethod = normalizeDeliveryMethod(req.body?.deliveryMethod);

  const addOns = safeJsonParse(req.body?.addOns, []);
  const addOnPrices = safeJsonParse(req.body?.addOnPrices, {});
  const addOnTimes = safeJsonParse(req.body?.addOnTimes, {});

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!category) return res.status(400).json({ error: 'Invalid category' });
  if (!description)
    return res.status(400).json({ error: 'Description is required' });
  if (!Number.isFinite(priceUsd))
    return res.status(400).json({ error: 'Price is required' });
  if (!includes) return res.status(400).json({ error: 'Includes is required' });
  if (!deliveryMethod)
    return res.status(400).json({ error: 'Invalid delivery method' });

  const requestedId = String(req.body?.id ?? '').trim();
  if (requestedId && !isUuid(requestedId)) {
    return res.status(400).json({ error: 'Invalid listing id' });
  }

  const id = requestedId || crypto.randomUUID();
  if (await getListingById(id)) {
    return res.status(409).json({ error: 'Listing already exists' });
  }
  const now = new Date().toISOString();

  const uploadedScreenshots = normalizeUploadedScreenshots(
    safeJsonParse(req.body?.uploadedScreenshots, []),
    id,
  );

  const screenshots =
    uploadedScreenshots.length > 0 ? [...uploadedScreenshots] : [];

  await db
    .prepare(
      `INSERT INTO listings (
      id,
      seller_id,
      status,
      title,
      category,
      description,
      stack,
      demo_url,
      price_usd,
      add_ons_json,
      includes,
      not_included,
      notes,
      support_days,
      delivery_method,
      screenshots_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sellerId,
      status,
      title,
      category,
      description,
      stack || null,
      demoUrl || null,
      priceUsd,
      JSON.stringify({ addOns, addOnPrices, addOnTimes }),
      includes,
      notIncluded || null,
      notes || null,
      supportDays,
      deliveryMethod,
      JSON.stringify(screenshots),
      now,
      now,
    );

  return res.json({ ok: true, listing: { id } });
}

async function listPublicListings(req, res) {
  const page = toInt(req.query?.page, { min: 1, max: 100_000 }) || 1;
  const limit = toInt(req.query?.limit, { min: 1, max: 48 }) || 16;
  const offset = (page - 1) * limit;

  const categoryRaw =
    typeof req.query?.category === 'string' ? req.query.category : '';
  const category = publicTypeToListingCategory(categoryRaw);
  if (categoryRaw.trim() && category === undefined) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  const minPrice =
    req.query?.minPrice === undefined
      ? null
      : toInt(req.query?.minPrice, { min: 0, max: 500_000 });
  const maxPrice =
    req.query?.maxPrice === undefined
      ? null
      : toInt(req.query?.maxPrice, { min: 0, max: 500_000 });

  if (req.query?.minPrice !== undefined && minPrice === null) {
    return res.status(400).json({ error: 'Invalid minimum price' });
  }
  if (req.query?.maxPrice !== undefined && maxPrice === null) {
    return res.status(400).json({ error: 'Invalid maximum price' });
  }
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    return res.status(400).json({ error: 'Invalid price range' });
  }

  const where = [`status = 'active'`];
  const args = [];

  if (category) {
    where.push(`category = ?`);
    args.push(category);
  }
  if (minPrice !== null) {
    where.push(`price_usd >= ?`);
    args.push(minPrice);
  }
  if (maxPrice !== null) {
    where.push(`price_usd <= ?`);
    args.push(maxPrice);
  }

  const whereSql = where.join(' AND ');

  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM listings
        WHERE ${whereSql}`,
    )
    .get(...args);
  const total = Number(totalRow?.total ?? 0);

  const rows = await db
    .prepare(
      `SELECT id,
              title,
              description,
              category,
              stack,
              demo_url,
              price_usd,
              delivery_method,
              screenshots_json AS screenshotsJson,
              created_at
         FROM listings
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset);

  const listings = rows.map(rowToPublicListing);
  return res.json({ listings, total, page, limit });
}

async function searchPublicListings(req, res) {
  const qRaw = typeof req.query?.q === 'string' ? req.query.q : '';
  const q = qRaw.trim();

  const limitRaw = typeof req.query?.limit === 'string' ? req.query.limit : '';
  const limitParsed = Number.parseInt(limitRaw || '5', 10);
  const limit = Number.isFinite(limitParsed)
    ? Math.max(1, Math.min(10, limitParsed))
    : 5;

  if (!q) return res.json({ listings: [] });

  const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
  const like = `%${escapeLike(q)}%`;

  const rows = await db
    .prepare(
      `SELECT id,
              title,
              description,
              category,
              stack,
              demo_url,
              price_usd,
              delivery_method,
              screenshots_json AS screenshotsJson,
              created_at
       FROM listings
       WHERE status = 'active'
         AND (
           LOWER(title) LIKE LOWER(?) ESCAPE '\\'
           OR LOWER(description) LIKE LOWER(?) ESCAPE '\\'
           OR LOWER(stack) LIKE LOWER(?) ESCAPE '\\'
         )
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(like, like, like, limit);

  const listings = rows.map(rowToPublicListing);
  return res.json({ listings });
}

async function getPublicListing(req, res) {
  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const row = await db
    .prepare(
      `SELECT l.id,
              l.seller_id AS sellerId,
              l.status,
              l.title,
              l.category,
              l.description,
              l.stack,
              l.demo_url AS demoUrl,
              l.price_usd AS priceUsd,
              l.add_ons_json AS addOnsJson,
              l.includes,
              l.not_included AS notIncluded,
              l.notes,
              l.support_days AS supportDays,
              l.delivery_method AS deliveryMethod,
              l.screenshots_json AS screenshotsJson,
              l.created_at AS createdAt,
              l.updated_at AS updatedAt,
              u.display_name AS sellerDisplayName,
              u.username AS sellerUsername,
              u.avatar_url AS sellerAvatarUrl,
              u.created_at AS sellerCreatedAt
         FROM listings l
         JOIN users u ON u.id = l.seller_id
        WHERE l.id = ?
          AND l.status = 'active'
        LIMIT 1`,
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not Found' });

  const listing = rowToMyListing(row);
  return res.json({
    listing: {
      ...listing,
      seller: {
        id: row.sellerId,
        fullName: toSellerDisplayName(row),
        username: toSellerUsername(row),
        avatarUrl: String(row.sellerAvatarUrl ?? '').trim() || null,
        memberSinceYear: sellerCreatedAtToYear(row),
      },
    },
  });
}

async function listPublicListingQa(req, res) {
  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const viewerUserId = getViewerUserId(req);
  const page = toInt(req.query?.page, { min: 1, max: 100_000 }) || 1;
  const limit = toInt(req.query?.limit, { min: 1, max: 50 }) || 6;
  const offset = (page - 1) * limit;
  const questionId = String(req.query?.questionId ?? '').trim();
  const replyId = String(req.query?.replyId ?? '').trim();

  if (questionId && replyId) {
    return res
      .status(400)
      .json({ error: 'Provide either questionId or replyId' });
  }

  const listingRow = await db
    .prepare(
      `SELECT id, seller_id AS sellerId, status
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM listing_questions
        WHERE listing_id = ?`,
    )
    .get(listingId);
  const total = Number(totalRow?.total ?? 0);

  let questionRows;
  if (questionId) {
    questionRows = await db
      .prepare(
        `SELECT q.id,
                q.question,
                q.created_at AS createdAt,
                u.id AS userId,
                u.username,
                u.display_name AS display_name,
                u.avatar_url AS avatarUrl
           FROM listing_questions q
           JOIN users u ON u.id = q.user_id
          WHERE q.listing_id = ?
            AND q.id = ?
          LIMIT 1`,
      )
      .all(listingId, questionId);
  } else if (replyId) {
    questionRows = await db
      .prepare(
        `SELECT q.id,
                q.question,
                q.created_at AS createdAt,
                u.id AS userId,
                u.username,
                u.display_name AS display_name,
                u.avatar_url AS avatarUrl
           FROM listing_question_replies r
           JOIN listing_questions q ON q.id = r.question_id
           JOIN users u ON u.id = q.user_id
          WHERE q.listing_id = ?
            AND r.id = ?
          LIMIT 1`,
      )
      .all(listingId, replyId);
  } else {
    questionRows = await db
      .prepare(
        `SELECT q.id,
                q.question,
                q.created_at AS createdAt,
                u.id AS userId,
                u.username,
                u.display_name AS display_name,
                u.avatar_url AS avatarUrl
           FROM listing_questions q
           JOIN users u ON u.id = q.user_id
          WHERE q.listing_id = ?
          ORDER BY q.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(listingId, limit, offset);
  }

  const threads = await buildQaThreads({
    questionRows,
    listingSellerId: listingRow.sellerId,
    viewerUserId,
  });

  const resolvedHasMore =
    questionId || replyId
      ? page * limit < total
      : offset + threads.length < total;

  return res.json({
    threads,
    total,
    page,
    limit,
    hasMore: resolvedHasMore,
  });
}

async function createPublicListingQuestion(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id, seller_id AS sellerId, status
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Question is required' });
  if (text.length > 800)
    return res.status(400).json({ error: 'Question is too long' });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO listing_questions (id, listing_id, user_id, question, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, listingId, userId, text, now);

  const userRow = await db
    .prepare(
      `SELECT id AS userId,
              username,
              display_name AS display_name
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId);

  if (!userRow) return res.status(401).json({ error: 'Not authenticated' });

  const author = formatQaAuthor({
    row: { ...userRow, id: userId },
    listingSellerId: listingRow.sellerId,
  });

  // Notify seller about new Q&A question (best-effort).
  try {
    const sellerId = String(listingRow?.sellerId ?? '').trim();
    if (sellerId && sellerId !== String(userId)) {
      const listingTitleRow = await db
        .prepare(
          `SELECT title
             FROM listings
            WHERE id = ?
            LIMIT 1`,
        )
        .get(listingId);

      const listingTitle = String(listingTitleRow?.title ?? '').trim();
      const trimmed = text.length > 120 ? `${text.slice(0, 120)}…` : text;

      await createNotification({
        userId: sellerId,
        type: 'seller.listing_question',
        title: 'New Q&A question',
        detail: listingTitle
          ? `On “${listingTitle}”: ${trimmed}`
          : `On your listing: ${trimmed}`,
        entityType: 'listing',
        entityId: listingId,
        data: { questionId: id },
      });
    }
  } catch {
    // Best-effort.
  }

  await notifyMentionsInQa({
    text,
    fromUserId: userId,
    listingId,
    questionId: id,
    replyId: null,
  });

  return res.json({
    thread: {
      id,
      question: {
        id,
        text,
        createdAt: now,
        author,
      },
      replies: [],
      likesCount: 0,
      likedByMe: false,
    },
  });
}

async function togglePublicListingQuestionLike(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const questionId = req.params?.questionId;
  if (!questionId)
    return res.status(400).json({ error: 'Question id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const qRow = await db
    .prepare(
      `SELECT id
         FROM listing_questions
        WHERE id = ?
          AND listing_id = ?
        LIMIT 1`,
    )
    .get(questionId, listingId);

  if (!qRow) return res.status(404).json({ error: 'Not Found' });

  const existing = await db
    .prepare(
      `SELECT id
         FROM listing_question_likes
        WHERE question_id = ?
          AND user_id = ?
        LIMIT 1`,
    )
    .get(questionId, userId);

  let liked = false;
  if (existing?.id) {
    await db
      .prepare(`DELETE FROM listing_question_likes WHERE id = ?`)
      .run(existing.id);
    liked = false;
  } else {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO listing_question_likes (id, question_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(id, questionId, userId, now);
    liked = true;

    // Notify the question author about the like (best-effort).
    try {
      const meta = await db
        .prepare(
          `SELECT q.user_id AS authorId,
                  q.question AS question,
                  l.title AS listingTitle
             FROM listing_questions q
             JOIN listings l ON l.id = q.listing_id
            WHERE q.id = ?
              AND q.listing_id = ?
            LIMIT 1`,
        )
        .get(questionId, listingId);

      const authorId = String(meta?.authorId ?? '').trim();
      if (authorId && authorId !== String(userId)) {
        const listingTitle = String(meta?.listingTitle ?? '').trim();
        const questionText = String(meta?.question ?? '').trim();
        const trimmed =
          questionText.length > 120
            ? `${questionText.slice(0, 120)}…`
            : questionText;

        await createNotification({
          userId: authorId,
          type: 'qa.question_liked',
          title: 'Your question got a like',
          detail: listingTitle
            ? `On “${listingTitle}”: ${trimmed}`
            : `On your listing: ${trimmed}`,
          entityType: 'listing',
          entityId: listingId,
          data: { questionId, fromUserId: String(userId) },
        });
      }
    } catch {
      // Best-effort.
    }
  }

  const likesCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS likesCount
         FROM listing_question_likes
        WHERE question_id = ?`,
    )
    .get(questionId);

  const likesCount = Number(likesCountRow?.likesCount ?? 0);
  return res.json({ liked, likesCount });
}

async function createPublicListingReply(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const questionId = req.params?.questionId;
  if (!questionId)
    return res.status(400).json({ error: 'Question id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id, seller_id AS sellerId, status
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const qRow = await db
    .prepare(
      `SELECT id
         FROM listing_questions
        WHERE id = ?
          AND listing_id = ?
        LIMIT 1`,
    )
    .get(questionId, listingId);

  if (!qRow) return res.status(404).json({ error: 'Not Found' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Reply is required' });
  if (text.length > 1_200)
    return res.status(400).json({ error: 'Reply is too long' });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO listing_question_replies (id, question_id, user_id, reply, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, questionId, userId, text, now);

  // Notify the question author about the reply (best-effort).
  try {
    const meta = await db
      .prepare(
        `SELECT q.user_id AS authorId,
                q.question AS question,
                l.title AS listingTitle
           FROM listing_questions q
           JOIN listings l ON l.id = q.listing_id
          WHERE q.id = ?
            AND q.listing_id = ?
          LIMIT 1`,
      )
      .get(questionId, listingId);

    const authorId = String(meta?.authorId ?? '').trim();
    if (authorId && authorId !== String(userId)) {
      const listingTitle = String(meta?.listingTitle ?? '').trim();
      const questionText = String(meta?.question ?? '').trim();
      const replyTrimmed = text.length > 140 ? `${text.slice(0, 140)}…` : text;

      await createNotification({
        userId: authorId,
        type: 'qa.question_replied',
        title: 'New reply to your question',
        detail: listingTitle
          ? `On “${listingTitle}”: ${replyTrimmed}`
          : `Reply: ${replyTrimmed}`,
        entityType: 'listing',
        entityId: listingId,
        data: {
          questionId,
          replyId: id,
          fromUserId: String(userId),
          questionPreview:
            questionText.length > 140
              ? `${questionText.slice(0, 140)}…`
              : questionText,
        },
      });
    }
  } catch {
    // Best-effort.
  }

  const userRow = await db
    .prepare(
      `SELECT id AS userId,
              username,
              display_name AS display_name
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId);

  if (!userRow) return res.status(401).json({ error: 'Not authenticated' });

  const author = formatQaAuthor({
    row: { ...userRow, id: userId },
    listingSellerId: listingRow.sellerId,
  });

  await notifyMentionsInQa({
    text,
    fromUserId: userId,
    listingId,
    questionId,
    replyId: id,
  });

  return res.json({
    reply: {
      id,
      text,
      createdAt: now,
      author,
    },
  });
}

async function updatePublicListingQuestion(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const questionId = req.params?.questionId;
  if (!questionId)
    return res.status(400).json({ error: 'Question id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const qRow = await db
    .prepare(
      `SELECT id, user_id AS userId
         FROM listing_questions
        WHERE id = ?
          AND listing_id = ?
        LIMIT 1`,
    )
    .get(questionId, listingId);

  if (!qRow) return res.status(404).json({ error: 'Not Found' });
  if (String(qRow.userId) !== String(userId))
    return res.status(403).json({ error: 'Forbidden' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Question is required' });
  if (text.length > 800)
    return res.status(400).json({ error: 'Question is too long' });

  await db
    .prepare(
      `UPDATE listing_questions
        SET question = ?
      WHERE id = ?
        AND listing_id = ?`,
    )
    .run(text, questionId, listingId);

  return res.json({ ok: true, id: questionId, text });
}

async function deletePublicListingQuestion(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const questionId = req.params?.questionId;
  if (!questionId)
    return res.status(400).json({ error: 'Question id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const qRow = await db
    .prepare(
      `SELECT id, user_id AS userId
         FROM listing_questions
        WHERE id = ?
          AND listing_id = ?
        LIMIT 1`,
    )
    .get(questionId, listingId);

  if (!qRow) return res.status(404).json({ error: 'Not Found' });
  if (String(qRow.userId) !== String(userId))
    return res.status(403).json({ error: 'Forbidden' });

  await db
    .prepare(
      `DELETE FROM listing_questions
      WHERE id = ?
        AND listing_id = ?`,
    )
    .run(questionId, listingId);

  return res.json({ ok: true });
}

async function updatePublicListingReply(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const questionId = req.params?.questionId;
  if (!questionId)
    return res.status(400).json({ error: 'Question id is required' });

  const replyId = req.params?.replyId;
  if (!replyId) return res.status(400).json({ error: 'Reply id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const meta = await db
    .prepare(
      `SELECT r.id,
              r.user_id AS userId
         FROM listing_question_replies r
         JOIN listing_questions q ON q.id = r.question_id
        WHERE r.id = ?
          AND r.question_id = ?
          AND q.listing_id = ?
        LIMIT 1`,
    )
    .get(replyId, questionId, listingId);

  if (!meta) return res.status(404).json({ error: 'Not Found' });
  if (String(meta.userId) !== String(userId))
    return res.status(403).json({ error: 'Forbidden' });

  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Reply is required' });
  if (text.length > 1_200)
    return res.status(400).json({ error: 'Reply is too long' });

  await db
    .prepare(
      `UPDATE listing_question_replies
        SET reply = ?
      WHERE id = ?
        AND question_id = ?`,
    )
    .run(text, replyId, questionId);

  return res.json({ ok: true, id: replyId, text });
}

async function deletePublicListingReply(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = req.params?.id;
  if (!listingId)
    return res.status(400).json({ error: 'Listing id is required' });

  const questionId = req.params?.questionId;
  if (!questionId)
    return res.status(400).json({ error: 'Question id is required' });

  const replyId = req.params?.replyId;
  if (!replyId) return res.status(400).json({ error: 'Reply id is required' });

  const listingRow = await db
    .prepare(
      `SELECT id
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listingRow) return res.status(404).json({ error: 'Not Found' });

  const meta = await db
    .prepare(
      `SELECT r.id,
              r.user_id AS userId
         FROM listing_question_replies r
         JOIN listing_questions q ON q.id = r.question_id
        WHERE r.id = ?
          AND r.question_id = ?
          AND q.listing_id = ?
        LIMIT 1`,
    )
    .get(replyId, questionId, listingId);

  if (!meta) return res.status(404).json({ error: 'Not Found' });
  if (String(meta.userId) !== String(userId))
    return res.status(403).json({ error: 'Forbidden' });

  await db
    .prepare(
      `DELETE FROM listing_question_replies
      WHERE id = ?
        AND question_id = ?`,
    )
    .run(replyId, questionId);

  return res.json({ ok: true });
}

async function listMyListings(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const rows = await db
    .prepare(
      `SELECT id,
              title,
              price_usd AS priceUsd,
              updated_at AS updatedAt,
              status,
              (
                SELECT o.id
                  FROM orders o
                 WHERE o.listing_id = listings.id
                 ORDER BY COALESCE(o.paid_at, o.created_at) DESC
                 LIMIT 1
              ) AS orderId
         FROM listings
        WHERE seller_id = ?
          AND status IN ('active', 'in_progress')
        ORDER BY updated_at DESC
        LIMIT 200`,
    )
    .all(sellerId);

  const listings = rows.map((r) => ({
    id: r.id,
    title: r.title,
    price: Number(r.priceUsd ?? 0),
    updatedAt: r.updatedAt ?? null,
    status: String(r.status || '').trim() || 'active',
    orderId: r.orderId ? String(r.orderId) : null,
  }));

  return res.json({ listings });
}

async function getMyListing(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const row = await getListingById(id);
  if (!row) return res.status(404).json({ error: 'Not Found' });
  if (String(row.sellerId ?? '') !== String(sellerId))
    return res.status(403).json({ error: 'Not authorized' });

  return res.json({ listing: rowToMyListing(row) });
}

async function getLatestDraft(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const row = await db
    .prepare(
      `SELECT id
         FROM listings
        WHERE seller_id = ?
          AND status = 'draft'
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(sellerId);

  if (!row?.id) return res.json({ draft: null });

  const listingRow = await getListingById(row.id);
  if (!listingRow) return res.json({ draft: null });
  if (listingRow.sellerId !== sellerId)
    return res.status(403).json({ error: 'Not authorized' });

  return res.json({
    draft: {
      id: listingRow.id,
      listing: rowToMyListing(listingRow),
    },
  });
}

async function updateListing(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const existing = await getListingById(id);
  if (!existing) return res.status(404).json({ error: 'Not Found' });
  if (existing.sellerId !== sellerId)
    return res.status(403).json({ error: 'Not authorized' });

  const nextStatus =
    String(existing.status).toLowerCase() === 'disabled'
      ? 'disabled'
      : normalizeListingStatus(req.body?.status) || existing.status;

  const title = String(req.body?.title ?? '').trim();
  const category = normalizeCategory(req.body?.category);
  const description = String(req.body?.description ?? '').trim();
  const stack =
    typeof req.body?.stack === 'string' ? req.body.stack.trim() : '';
  const demoUrl =
    typeof req.body?.demoUrl === 'string' ? req.body.demoUrl.trim() : '';
  const priceUsd = toInt(req.body?.price, { min: 1, max: 500_000 });
  const includes = String(req.body?.includes ?? '').trim();
  const notIncluded =
    typeof req.body?.notIncluded === 'string'
      ? req.body.notIncluded.trim()
      : '';
  const notes =
    typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  const supportDays = req.body?.supportDays
    ? toInt(req.body.supportDays, { min: 0, max: 365 })
    : null;
  const deliveryMethod = normalizeDeliveryMethod(req.body?.deliveryMethod);

  const addOns = safeJsonParse(req.body?.addOns, []);
  const addOnPrices = safeJsonParse(req.body?.addOnPrices, {});
  const addOnTimes = safeJsonParse(req.body?.addOnTimes, {});

  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (!category) return res.status(400).json({ error: 'Invalid category' });
  if (!description)
    return res.status(400).json({ error: 'Description is required' });
  if (!Number.isFinite(priceUsd))
    return res.status(400).json({ error: 'Price is required' });
  if (!includes) return res.status(400).json({ error: 'Includes is required' });
  if (!deliveryMethod)
    return res.status(400).json({ error: 'Invalid delivery method' });

  const keepPublicIds = safeJsonParse(req.body?.keepScreenshotPublicIds, null);
  const currentShots = safeJsonParse(existing.screenshotsJson, []);
  const uploadedScreenshots = normalizeUploadedScreenshots(
    safeJsonParse(req.body?.uploadedScreenshots, []),
    id,
  );

  let nextShots = Array.isArray(currentShots) ? currentShots : [];

  if (Array.isArray(keepPublicIds)) {
    const keep = new Set(keepPublicIds.map((x) => String(x)));
    const toDelete = nextShots.filter(
      (s) => s?.publicId && !keep.has(String(s.publicId)),
    );
    nextShots = nextShots.filter(
      (s) => s?.publicId && keep.has(String(s.publicId)),
    );

    // Best-effort cleanup.
    await Promise.all(
      toDelete.map((s) =>
        deleteListingScreenshotByPublicId({ publicId: s.publicId }).catch(
          () => null,
        ),
      ),
    );
  }

  if (uploadedScreenshots.length > 0) {
    nextShots = [...nextShots, ...uploadedScreenshots];
  }

  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE listings
     SET status = ?,
         title = ?,
         category = ?,
         description = ?,
         stack = ?,
         demo_url = ?,
         price_usd = ?,
         add_ons_json = ?,
         includes = ?,
         not_included = ?,
         notes = ?,
         support_days = ?,
         delivery_method = ?,
         screenshots_json = ?,
         updated_at = ?
     WHERE id = ?`,
    )
    .run(
      nextStatus,
      title,
      category,
      description,
      stack || null,
      demoUrl || null,
      priceUsd,
      JSON.stringify({ addOns, addOnPrices, addOnTimes }),
      includes,
      notIncluded || null,
      notes || null,
      supportDays,
      deliveryMethod,
      JSON.stringify(nextShots),
      now,
      id,
    );

  return res.json({ ok: true });
}

async function deleteListing(req, res) {
  const sellerId = req.user?.id;
  if (!sellerId) return res.status(401).json({ error: 'Not authenticated' });

  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: 'Listing id is required' });

  const existing = await getListingById(id);
  if (!existing) return res.status(404).json({ error: 'Not Found' });
  if (existing.sellerId !== sellerId)
    return res.status(403).json({ error: 'Not authorized' });

  const currentShots = safeJsonParse(existing.screenshotsJson, []);
  const toDelete = Array.isArray(currentShots) ? currentShots : [];

  // Best-effort cleanup.
  await Promise.all(
    toDelete
      .filter((s) => s?.publicId)
      .map((s) =>
        deleteListingScreenshotByPublicId({ publicId: s.publicId }).catch(
          () => null,
        ),
      ),
  );

  await db.prepare('DELETE FROM listings WHERE id = ?').run(id);

  return res.json({ ok: true });
}

module.exports = {
  createListing,
  createListingScreenshotUploadSignature,
  listMyListings,
  listPublicListings,
  searchPublicListings,
  getPublicListing,
  listPublicListingQa,
  createPublicListingQuestion,
  createPublicListingReply,
  updatePublicListingQuestion,
  deletePublicListingQuestion,
  updatePublicListingReply,
  deletePublicListingReply,
  togglePublicListingQuestionLike,
  getMyListing,
  getLatestDraft,
  updateListing,
  deleteListing,
};
