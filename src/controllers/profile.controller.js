const pool = require('../db');
const cloudinary = require('../lib/cloudinary');

let usersHasUpdatedAtColumn;

async function usersHasUpdatedAt() {
  if (typeof usersHasUpdatedAtColumn === 'boolean') {
    return usersHasUpdatedAtColumn;
  }

  try {
    const result = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'users'
         AND column_name = 'updated_at'
       LIMIT 1`,
    );

    usersHasUpdatedAtColumn = result.rows.length > 0;
    return usersHasUpdatedAtColumn;
  } catch {
    usersHasUpdatedAtColumn = false;
    return false;
  }
}

const normalizeOptionalString = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isValidHttpUrlOrNull = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (!trimmed) return true;

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

async function destroyAvatarAsset(publicId) {
  const cleanedPublicId = String(publicId || '').trim();

  if (!cleanedPublicId) return;

  try {
    await cloudinary.uploader.destroy(cleanedPublicId, {
      resource_type: 'image',
    });
  } catch (error) {
    console.error('Avatar cleanup error:', error);
  }
}

async function fetchProfileByUserId(userId) {
  const result = await pool.query(
    `SELECT
      id,
      email,
      username,
      role,
      created_at AS "createdAt",
      full_name AS "fullName",
      location,
      bio,
      avatar_url AS "avatarUrl",
      avatar_public_id AS "avatarPublicId"
    FROM users
WHERE id = $1
  AND status = 'active'
  AND deleted_at IS NULL
LIMIT 1`,
    [userId],
  );

  return result.rows[0] || null;
}

const getMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const profile = await fetchProfileByUserId(userId);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.json({ profile });
  } catch (err) {
    console.error('Get my profile error:', err);
    return res.status(500).json({ error: 'Failed to get profile' });
  }
};

const updateMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

    if (
      has('fullName') &&
      body.fullName !== null &&
      body.fullName !== undefined &&
      typeof body.fullName !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid full name' });
    }

    if (
      has('location') &&
      body.location !== null &&
      body.location !== undefined &&
      typeof body.location !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid location' });
    }

    if (
      has('bio') &&
      body.bio !== null &&
      body.bio !== undefined &&
      typeof body.bio !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid bio' });
    }

    if (
      has('avatarUrl') &&
      body.avatarUrl !== null &&
      body.avatarUrl !== undefined &&
      typeof body.avatarUrl !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid avatar url' });
    }

    if (
      has('avatarPublicId') &&
      body.avatarPublicId !== null &&
      body.avatarPublicId !== undefined &&
      typeof body.avatarPublicId !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid avatar public id' });
    }

    const fullName = has('fullName')
      ? normalizeOptionalString(body.fullName)
      : undefined;
    const location = has('location')
      ? normalizeOptionalString(body.location)
      : undefined;
    const bio = has('bio') ? normalizeOptionalString(body.bio) : undefined;
    const avatarUrl = has('avatarUrl')
      ? normalizeOptionalString(body.avatarUrl)
      : undefined;
    const avatarPublicId = has('avatarPublicId')
      ? normalizeOptionalString(body.avatarPublicId)
      : undefined;

    let oldAvatarPublicId = null;

    if (avatarUrl !== undefined || avatarPublicId !== undefined) {
      const currentAvatarResult = await pool.query(
        `
        SELECT avatar_public_id
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId],
      );

      oldAvatarPublicId = currentAvatarResult.rows[0]?.avatar_public_id || null;
    }

    if (
      fullName !== undefined &&
      fullName !== null &&
      typeof fullName === 'string' &&
      fullName.length > 20
    ) {
      return res.status(400).json({ error: 'Invalid full name' });
    }

    if (
      location !== undefined &&
      location !== null &&
      typeof location === 'string' &&
      location.length > 100
    ) {
      return res.status(400).json({ error: 'Invalid location' });
    }

    if (
      bio !== undefined &&
      bio !== null &&
      typeof bio === 'string' &&
      bio.length > 450
    ) {
      return res.status(400).json({ error: 'Invalid bio' });
    }

    if (avatarUrl !== undefined && !isValidHttpUrlOrNull(avatarUrl)) {
      return res.status(400).json({ error: 'Invalid avatar url' });
    }

    const updates = [];
    const values = [];

    if (fullName !== undefined) {
      values.push(fullName);
      updates.push(`full_name = $${values.length}`);
    }

    if (location !== undefined) {
      values.push(location);
      updates.push(`location = $${values.length}`);
    }

    if (bio !== undefined) {
      values.push(bio);
      updates.push(`bio = $${values.length}`);
    }

    if (avatarUrl !== undefined) {
      values.push(avatarUrl);
      updates.push(`avatar_url = $${values.length}`);
    }

    if (avatarPublicId !== undefined) {
      values.push(avatarPublicId);
      updates.push(`avatar_public_id = $${values.length}`);
    }

    const shouldSetUpdatedAt =
      updates.length > 0 && (await usersHasUpdatedAt());
    if (shouldSetUpdatedAt) {
      updates.push('updated_at = NOW()');
    }

    if (updates.length > 0) {
      values.push(userId);
      await pool.query(
        `UPDATE users
         SET ${updates.join(', ')}
         WHERE id = $${values.length}`,
        values,
      );
    }

    const profile = await fetchProfileByUserId(userId);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    if (
      (avatarUrl !== undefined || avatarPublicId !== undefined) &&
      oldAvatarPublicId &&
      oldAvatarPublicId !== profile.avatarPublicId
    ) {
      await destroyAvatarAsset(oldAvatarPublicId);
    }

    return res.json({ profile });
  } catch (err) {
    console.error('Update my profile error:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile,
};
