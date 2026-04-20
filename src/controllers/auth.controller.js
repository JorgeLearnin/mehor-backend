'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { signSession } = require('../utils/jwt');
const { setSessionCookie, clearSessionCookie } = require('../utils/cookies');
const { sendPasswordResetEmail } = require('../utils/email');
const {
  deleteAvatarByUserId,
  createSignedImageUploadParams,
  deleteCloudinaryResourcesByPrefix,
} = require('../utils/cloudinary');

const RESET_TOKEN_TTL_MS = 2 * 60 * 1000;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function isPasswordStrong(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/\d/.test(password)) return false;
  return true;
}

function normalizePublicUser(user) {
  if (!user) return null;

  const id = String(user.id ?? '').trim();
  const email = String(user.email ?? '').trim();
  const username =
    typeof user.username === 'string' ? user.username.trim() || null : null;
  const fullNameRaw = typeof user.fullName === 'string' ? user.fullName : null;
  const avatarUrlRaw =
    typeof user.avatarUrl === 'string' ? user.avatarUrl : null;
  const locationRaw =
    typeof user.location === 'string' ? user.location : (user.location ?? null);
  const bioRaw = typeof user.bio === 'string' ? user.bio : (user.bio ?? null);
  const createdAtRaw =
    typeof user.createdAt === 'string' ? user.createdAt : null;
  const isSellerRaw = user.isSeller ?? 0;
  const usedPromoRaw = user.usedFreeFirstSalePlatformFee ?? 0;

  return {
    id,
    email,
    username,
    fullName:
      typeof fullNameRaw === 'string' ? fullNameRaw.trim() || null : null,
    avatarUrl:
      typeof avatarUrlRaw === 'string' ? avatarUrlRaw.trim() || null : null,
    location:
      typeof locationRaw === 'string'
        ? locationRaw.trim() || null
        : locationRaw,
    bio: typeof bioRaw === 'string' ? bioRaw || null : bioRaw,
    isSeller: Number(isSellerRaw) === 1 || isSellerRaw === true,
    usedFreeFirstSalePlatformFee:
      Number(usedPromoRaw) === 1 || usedPromoRaw === true,
    createdAt:
      typeof createdAtRaw === 'string' ? createdAtRaw.trim() || null : null,
  };
}

async function register(req, res) {
  const { email, password, fullName, username } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const resolvedUsername =
    typeof username === 'string' && username.trim() ? username.trim() : null;
  if (!resolvedUsername)
    return res.status(400).json({ error: 'Username is required' });

  const resolvedFullName =
    typeof fullName === 'string' && fullName.trim()
      ? fullName.trim()
      : resolvedUsername;

  const existing = await db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(email);
  if (existing) return res.status(409).json({ error: 'Email already in use' });

  const existingUsername = await db
    .prepare(
      `SELECT id FROM users
       WHERE username IS NOT NULL AND LOWER(username) = LOWER(?)`,
    )
    .get(resolvedUsername);
  if (existingUsername)
    return res.status(409).json({ error: 'Username already in use' });

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(password, 10);

  await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, provider, provider_id, name, username, display_name, avatar_url, created_at)
     VALUES (?, ?, ?, 'local', NULL, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      email,
      passwordHash,
      null,
      resolvedUsername,
      resolvedFullName,
      createdAt,
    );
  return res.json({ ok: true });
}

async function lookupUsernamesPublic(req, res) {
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

async function login(req, res) {
  const { email, password, remember } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = await db
    .prepare(`SELECT * FROM users WHERE email = ? AND provider='local'`)
    .get(email);
  if (!user?.password_hash)
    return res.status(401).json({ error: 'Invalid credentials' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  if (Number(user.is_restricted ?? 0) === 1) {
    return res.status(403).json({ error: 'Account restricted' });
  }

  const resolvedFullName =
    String(user.display_name ?? '').trim() ||
    String(user.username ?? '').trim() ||
    'User';

  const token = signSession({
    id: user.id,
    email: user.email,
    username: user.username ?? null,
    fullName: resolvedFullName,
    isSeller: Number(user.is_seller ?? 0) === 1,
  });
  const rememberMe = remember === false ? false : true;
  clearSessionCookie(req, res);
  setSessionCookie(req, res, token, { remember: rememberMe });
  return res.json({ ok: true });
}

async function me(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  const user = await db
    .prepare(
      `SELECT id,
              email,
              username,
              display_name AS fullName,
              avatar_url AS avatarUrl,
              location,
              bio,
              is_seller AS isSeller,
              used_free_first_sale_platform_fee AS usedFreeFirstSalePlatformFee,
              created_at AS createdAt
       FROM users
       WHERE id = ?`,
    )
    .get(id);

  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  return res.json({ user: normalizePublicUser(user) });
}

function createAvatarUploadSignature(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const signed = createSignedImageUploadParams({
      folder: 'mehor/avatars',
      publicId: String(id),
    });
    return res.json({ ok: true, upload: signed });
  } catch (e) {
    const status = typeof e?.status === 'number' ? e.status : 500;
    const message =
      e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED'
        ? 'Image storage is not configured'
        : 'Could not prepare avatar upload';
    return res.status(status).json({ error: message });
  }
}

async function updateProfile(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  const locationRaw = req.body?.location;
  const bioRaw = req.body?.bio;
  const avatarUrlRaw = req.body?.avatarUrl;

  const hasLocation = typeof locationRaw === 'string';
  const hasBio = typeof bioRaw === 'string';
  const hasAvatarUrl = typeof avatarUrlRaw === 'string';

  const location = hasLocation ? locationRaw.trim() : undefined;
  const bio = hasBio ? bioRaw : undefined;
  const avatarUrl = hasAvatarUrl ? avatarUrlRaw.trim() : undefined;

  if (typeof location !== 'undefined' && location.length > 80) {
    return res.status(400).json({ error: 'Location is too long' });
  }

  if (typeof bio !== 'undefined' && bio.length > 450) {
    return res.status(400).json({ error: 'Bio is too long' });
  }

  if (typeof avatarUrl !== 'undefined' && avatarUrl.length > 2_000) {
    return res.status(400).json({ error: 'Avatar image is too large' });
  }

  const nextLocation =
    typeof location === 'string' && location.length === 0 ? null : location;
  const nextBio = typeof bio === 'string' && bio.length === 0 ? null : bio;
  const nextAvatarUrl =
    typeof avatarUrl === 'string' && avatarUrl.length === 0 ? null : avatarUrl;

  if (hasAvatarUrl && nextAvatarUrl === null) {
    // Best-effort cleanup in Cloudinary when user removes avatar.
    try {
      await deleteAvatarByUserId({ userId: id });
    } catch {
      // ignore (do not block profile updates)
    }
  }

  if (
    typeof nextAvatarUrl === 'string' &&
    nextAvatarUrl.length > 0 &&
    !/cloudinary\.com\//i.test(nextAvatarUrl)
  ) {
    return res.status(400).json({ error: 'Invalid avatar URL' });
  }

  await db
    .prepare(
      `UPDATE users
     SET location = CASE WHEN ? = 1 THEN ? ELSE location END,
         bio = CASE WHEN ? = 1 THEN ? ELSE bio END,
         avatar_url = CASE WHEN ? = 1 THEN ? ELSE avatar_url END
     WHERE id = ?`,
    )
    .run(
      hasLocation ? 1 : 0,
      hasLocation ? nextLocation : null,
      hasBio ? 1 : 0,
      hasBio ? nextBio : null,
      hasAvatarUrl ? 1 : 0,
      hasAvatarUrl ? nextAvatarUrl : null,
      id,
    );

  const user = await db
    .prepare(
      `SELECT avatar_url AS avatarUrl,
              location,
              bio
       FROM users
       WHERE id = ?`,
    )
    .get(id);

  return res.json({ ok: true, user });
}

async function updateFullName(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  const fullNameRaw = req.body?.fullName;
  const resolvedFullName =
    typeof fullNameRaw === 'string' ? fullNameRaw.trim() : '';

  if (!resolvedFullName) {
    return res.status(400).json({ error: 'Full name is required' });
  }

  if (resolvedFullName.length > 64) {
    return res.status(400).json({ error: 'Full name is too long' });
  }

  await db
    .prepare(`UPDATE users SET display_name = ? WHERE id = ?`)
    .run(resolvedFullName, id);

  return res.json({ ok: true });
}

async function changePassword(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  const currentPassword = req.body?.currentPassword;
  const newPassword = req.body?.newPassword;

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return res.status(400).json({ error: 'Current password is required' });
  }

  if (!isPasswordStrong(newPassword)) {
    return res.status(400).json({
      error:
        'Password must be at least 8 characters and include an uppercase letter and a number',
    });
  }

  if (currentPassword === newPassword) {
    return res
      .status(400)
      .json({ error: 'New password must be different from current password' });
  }

  const user = await db
    .prepare(
      `SELECT password_hash AS passwordHash
       FROM users
       WHERE id = ? AND provider='local'`,
    )
    .get(id);

  if (!user?.passwordHash) {
    return res.status(400).json({ error: 'Password cannot be changed' });
  }

  const ok = bcrypt.compareSync(currentPassword, user.passwordHash);
  if (!ok)
    return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  await db
    .prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
    .run(passwordHash, id);

  // Invalidate any outstanding reset links for this user.
  await db
    .prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`)
    .run(id);

  return res.json({ ok: true });
}

async function deleteAccount(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  // Cleanup Cloudinary assets before deleting the account.
  // If Cloudinary is configured and this fails, block account deletion
  // to avoid orphaning user content.
  try {
    await deleteAvatarByUserId({ userId: id });

    const listingIds = (
      await db.prepare(`SELECT id FROM listings WHERE seller_id = ?`).all(id)
    ).map((r) => String(r.id));

    const threadIds = (
      await db
        .prepare(
          `SELECT id FROM message_threads WHERE buyer_id = ? OR seller_id = ?`,
        )
        .all(id, id)
    ).map((r) => String(r.id));

    await Promise.all([
      ...listingIds.map((listingId) =>
        deleteCloudinaryResourcesByPrefix({
          prefix: `mehor/listings/${listingId}/`,
          resourceType: 'image',
        }),
      ),
      ...threadIds.map((threadId) =>
        deleteCloudinaryResourcesByPrefix({
          prefix: `mehor/messages/${threadId}/`,
          resourceType: 'image',
        }),
      ),
    ]);
  } catch (e) {
    if (!(e instanceof Error && e.message === 'CLOUDINARY_NOT_CONFIGURED')) {
      // eslint-disable-next-line no-console
      console.error('[delete-account] cloudinary cleanup failed:', e);
      return res
        .status(500)
        .json({ error: 'Failed to delete Cloudinary assets' });
    }
  }

  const tx = db.transaction(async () => {
    await db
      .prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`)
      .run(id);
    await db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  });

  try {
    await tx();
    clearSessionCookie(req, res);
    return res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[delete-account] failed:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

function logout(req, res) {
  clearSessionCookie(req, res);
  return res.json({ ok: true });
}

async function activateSeller(req, res) {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: 'Not authenticated' });

  await db.prepare(`UPDATE users SET is_seller = 1 WHERE id = ?`).run(id);

  const user = await db
    .prepare(
      `SELECT id,
              email,
              username,
              display_name AS fullName,
              avatar_url AS avatarUrl,
              location,
              bio,
              is_seller AS isSeller,
              used_free_first_sale_platform_fee AS usedFreeFirstSalePlatformFee,
              created_at AS createdAt
       FROM users
       WHERE id = ?`,
    )
    .get(id);

  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  req.user = { ...(req.user || {}), isSeller: true };

  return res.json({ ok: true, user: normalizePublicUser(user) });
}

async function forgotPassword(req, res) {
  const { email } = req.body || {};
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'Email is required' });

  // Always respond with ok to avoid user enumeration.
  try {
    const user = await db
      .prepare(
        `SELECT id, email FROM users WHERE email = ? AND provider='local'`,
      )
      .get(trimmed);

    if (user?.id) {
      const now = Date.now();
      const token = generateResetToken();
      const tokenHash = sha256Hex(token);
      const expiresAt = now + RESET_TOKEN_TTL_MS;

      await db
        .prepare(`DELETE FROM password_reset_tokens WHERE user_id = ?`)
        .run(user.id);

      await db
        .prepare(
          `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(crypto.randomUUID(), user.id, tokenHash, expiresAt, now);

      await sendPasswordResetEmail(user.email, token);
    }
  } catch (e) {
    // Avoid leaking whether the email exists; log only.
    // eslint-disable-next-line no-console
    console.error('[forgot-password] failed:', e);
  }

  return res.json({ ok: true });
}

async function resetPasswordStatus(req, res) {
  const { token } = req.body || {};
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'Token is required' });

  const now = Date.now();
  await db
    .prepare(
      `DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL`,
    )
    .run(now);

  const tokenHash = sha256Hex(trimmed);
  const row = await db
    .prepare(
      `SELECT expires_at AS expiresAt
       FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL`,
    )
    .get(tokenHash);

  if (!row?.expiresAt || row.expiresAt <= now) {
    return res.json({ valid: false });
  }

  return res.json({ valid: true, expiresAt: row.expiresAt });
}

async function resetPassword(req, res) {
  const { token, password } = req.body || {};
  const trimmedToken = typeof token === 'string' ? token.trim() : '';

  if (!trimmedToken)
    return res.status(400).json({ error: 'Token is required' });
  if (!isPasswordStrong(password)) {
    return res.status(400).json({
      error:
        'Password must be at least 8 characters and include an uppercase letter and a number',
    });
  }

  const now = Date.now();
  const tokenHash = sha256Hex(trimmedToken);

  const tx = db.transaction(async () => {
    const row = await db
      .prepare(
        `SELECT id, user_id AS userId, expires_at AS expiresAt
         FROM password_reset_tokens
         WHERE token_hash = ? AND used_at IS NULL`,
      )
      .get(tokenHash);

    if (!row?.id || row.expiresAt <= now) {
      throw new Error('RESET_TOKEN_INVALID');
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    await db
      .prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
      .run(passwordHash, row.userId);

    await db
      .prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`)
      .run(now, row.id);
  });

  try {
    await tx();
    return res.json({ ok: true });
  } catch (e) {
    if (e instanceof Error && e.message === 'RESET_TOKEN_INVALID') {
      return res
        .status(400)
        .json({ error: 'Reset link is invalid or expired' });
    }
    // eslint-disable-next-line no-console
    console.error('[reset-password] failed:', e);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

module.exports = {
  register,
  lookupUsernamesPublic,
  login,
  me,
  createAvatarUploadSignature,
  updateFullName,
  updateProfile,
  changePassword,
  deleteAccount,
  logout,
  activateSeller,
  forgotPassword,
  resetPasswordStatus,
  resetPassword,
};
