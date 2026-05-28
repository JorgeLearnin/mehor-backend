const pool = require('../db');
const cloudinary = require('../lib/cloudinary');
const { hashPassword, comparePassword } = require('../utils/password');
const { signSessionToken } = require('../utils/token');
const { setSessionCookie, clearSessionCookie } = require('../utils/cookies');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('../utils/email');
const {
  destroyListingImageAssets,
  hardDeleteListingsBySellerRecord,
} = require('../services/listingDeletion.service');

const FINAL_ORDER_STATUSES = ['completed', 'canceled'];

const buildDeletedUserIdentity = (userId) => {
  const safeId =
    String(userId)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 18) || crypto.randomBytes(8).toString('hex');

  return {
    email: `deleted-user-${safeId}@deleted.mehor.local`,
    username: `deleted_user_${safeId}`,
    passwordHash: `deleted:${crypto.randomUUID()}`,
  };
};

const normalizeRemember = (value) => {
  if (value === undefined || value === null) return true;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return Boolean(value);
};

async function destroyAvatarAsset(publicId) {
  const cleanedPublicId = String(publicId || '').trim();

  if (!cleanedPublicId) return;

  try {
    await cloudinary.uploader.destroy(cleanedPublicId, {
      resource_type: 'image',
    });
  } catch (error) {
    console.error('Delete account avatar cleanup error:', error);
  }
}

const register = async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const { username, password } = req.body;

    const fieldErrors = {
      email: '',
      username: '',
      password: '',
    };

    if (!email) {
      fieldErrors.email = 'Email is required.';
    }

    if (!username) {
      fieldErrors.username = 'Username is required.';
    }

    if (!password) {
      fieldErrors.password = 'Password is required.';
    }

    const hasSymbol = /[^A-Za-z0-9]/.test(password);

    if (password && (password.length < 8 || !hasSymbol)) {
      fieldErrors.password =
        'Password must be at least 8 characters and include a symbol.';
    }

    if (fieldErrors.email || fieldErrors.username || fieldErrors.password) {
      return res.status(400).json({ fieldErrors });
    }

    const existing = await pool.query(
      `SELECT email, username
       FROM users
       WHERE email = $1::text OR username = $2::text
       LIMIT 1`,
      [email, username],
    );

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];

      if (existingUser.email === email) {
        fieldErrors.email = 'An account already exists with this email.';
      }

      if (existingUser.username === username) {
        fieldErrors.username = 'This username is already taken.';
      }

      return res.status(400).json({ fieldErrors });
    }

    const hashed = await hashPassword(password);

    const result = await pool.query(
      `INSERT INTO users (email, username, full_name, password_hash)
       VALUES ($1::text, $2::text, $2::text, $3::text)
       RETURNING id, email, username, full_name AS "fullName", role`,
      [email, username, hashed],
    );

    const user = result.rows[0];

    return res.status(201).json({
      message: 'Account created successfully.',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Register error:', err);

    if (err.code === '23505') {
      return res.status(400).json({
        fieldErrors: {
          email: 'Email or username already exists.',
          username: '',
          password: '',
        },
      });
    }

    return res.status(500).json({ error: 'Server error' });
  }
};

const login = async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const { password } = req.body;
    const remember = normalizeRemember(
      req.body?.remember ?? req.body?.rememberMe,
    );

    const result = await pool.query(
      `
      SELECT
        id,
        email,
        username,
        full_name AS "fullName",
        password_hash,
        role,
        status,
        deleted_at
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [email],
    );

    const user = result.rows[0];

    if (!user || user.status !== 'active' || user.deleted_at) {
      return res.status(401).json({
        fieldErrors: {
          email: 'No account found for this email.',
          password: '',
        },
      });
    }

    const validPassword = await comparePassword(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({
        fieldErrors: {
          email: '',
          password: 'Incorrect password.',
        },
      });
    }

    const token = signSessionToken(user, remember);
    setSessionCookie(res, token, remember);

    return res.json({
      message: 'Signed in successfully.',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const logout = (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true });
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    const fieldErrors = {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    };

    if (!currentPassword) {
      fieldErrors.currentPassword = 'Current password is required.';
    }

    if (!newPassword) {
      fieldErrors.newPassword = 'New password is required.';
    }

    if (!confirmPassword) {
      fieldErrors.confirmPassword = 'Please confirm your new password.';
    }

    const hasSymbol = /[^A-Za-z0-9]/.test(newPassword);

    if (newPassword && (newPassword.length < 8 || !hasSymbol)) {
      fieldErrors.newPassword =
        'Password must be at least 8 characters and include a symbol.';
    }

    if (newPassword && confirmPassword && newPassword !== confirmPassword) {
      fieldErrors.confirmPassword = 'Passwords do not match.';
    }

    if (currentPassword && newPassword && currentPassword === newPassword) {
      fieldErrors.newPassword =
        'New password must be different from your current password.';
    }

    if (
      fieldErrors.currentPassword ||
      fieldErrors.newPassword ||
      fieldErrors.confirmPassword
    ) {
      return res.status(400).json({ fieldErrors });
    }

    const result = await pool.query(
      `
      SELECT id, password_hash, status, deleted_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.id],
    );

    const user = result.rows[0];

    if (!user || user.status !== 'active' || user.deleted_at) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const validPassword = await comparePassword(
      currentPassword,
      user.password_hash,
    );

    if (!validPassword) {
      return res.status(400).json({
        fieldErrors: {
          currentPassword: 'Current password is incorrect.',
          newPassword: '',
          confirmPassword: '',
        },
      });
    }

    const hashedPassword = await hashPassword(newPassword);

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hashedPassword, user.id],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const deleteAccount = async (req, res) => {
  const client = await pool.connect();

  let deletedListingImagePublicIds = [];
  let deletedAvatarPublicId = null;

  try {
    const { password } = req.body;

    const fieldErrors = {
      password: '',
    };

    if (!password) {
      fieldErrors.password = 'Password is required.';
      return res.status(400).json({ fieldErrors });
    }

    const userResult = await client.query(
      `
      SELECT
        id,
        password_hash,
        avatar_public_id,
        status,
        deleted_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.id],
    );

    const user = userResult.rows[0];

    deletedAvatarPublicId = user?.avatar_public_id || null;

    if (!user || user.status !== 'active' || user.deleted_at) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const validPassword = await comparePassword(password, user.password_hash);

    if (!validPassword) {
      return res.status(400).json({
        fieldErrors: {
          password: 'Password is incorrect.',
        },
      });
    }

    const activeOrdersResult = await client.query(
      `
      SELECT id
      FROM orders
      WHERE (buyer_id = $1 OR seller_id = $1)
        AND status <> ALL($2::text[])
      LIMIT 1
      `,
      [user.id, FINAL_ORDER_STATUSES],
    );

    if (activeOrdersResult.rows.length > 0) {
      return res.status(409).json({
        error:
          'You cannot delete your account while you have an active order. Complete or cancel your active orders first.',
      });
    }

    await client.query('BEGIN');

    const deletedListingsResult = await hardDeleteListingsBySellerRecord({
      client,
      sellerId: user.id,
    });

    deletedListingImagePublicIds = deletedListingsResult.publicIds;

    await client.query(
      `
      DELETE FROM saved_listings
      WHERE user_id = $1
      `,
      [user.id],
    );

    await client.query(
      `
      DELETE FROM listing_question_likes
      WHERE user_id = $1
      `,
      [user.id],
    );

    await client.query(
      `
      DELETE FROM order_deadline_notifications
      WHERE user_id = $1
      `,
      [user.id],
    );

    await client.query(
      `
      DELETE FROM password_reset_tokens
      WHERE user_id = $1
      `,
      [user.id],
    );

    await client.query(
      `
      DELETE FROM notifications
      WHERE user_id = $1
      `,
      [user.id],
    );

    await client.query(
      `
      UPDATE feedback_messages
      SET user_id = NULL
      WHERE user_id = $1
      `,
      [user.id],
    );

    const deletedIdentity = buildDeletedUserIdentity(user.id);

    await client.query(
      `
      UPDATE users
      SET
        status = 'deleted',
        deleted_at = NOW(),
        email = $1,
        username = $2,
        password_hash = $3,
        role = 'user',
        is_seller = false,
        seller_terms_accepted_at = NULL,
        stripe_account_id = NULL,
        stripe_onboarding_complete = false,
        stripe_charges_enabled = false,
        stripe_payouts_enabled = false,
        full_name = 'Deleted user',
        location = NULL,
        bio = NULL,
        avatar_url = NULL,
        avatar_public_id = NULL,
        first_sale_free_rank = NULL,
        first_sale_free_used_at = NULL,
        first_sale_free_used_order_id = NULL,
        notifications_seen_at = NULL,
        updated_at = NOW()
      WHERE id = $4
      `,
      [
        deletedIdentity.email,
        deletedIdentity.username,
        deletedIdentity.passwordHash,
        user.id,
      ],
    );

    await client.query('COMMIT');

    clearSessionCookie(res);

    await destroyListingImageAssets(
      deletedListingImagePublicIds,
      'delete_account_listing_cleanup',
    );

    await destroyAvatarAsset(deletedAvatarPublicId);

    return res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete account error:', err);
    return res.status(500).json({ error: 'Failed to delete account' });
  } finally {
    client.release();
  }
};

const me = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.email,
         u.username,
         u.full_name AS "fullName",
         u.role,
         u.is_seller,
         u.created_at AS "createdAt",
         u.avatar_url AS "avatarUrl",
         u.avatar_public_id AS "avatarPublicId",
         u.first_sale_free_rank AS "firstSaleFreeRank",
         u.first_sale_free_used_at AS "firstSaleFreeUsedAt",
         EXISTS (
           SELECT 1
           FROM orders o
           WHERE o.seller_id = u.id
             AND o.payment_status = 'paid'
           LIMIT 1
         ) AS "hasPaidSellerOrder"
       FROM users u
WHERE u.id = $1
  AND u.status = 'active'
  AND u.deleted_at IS NULL
LIMIT 1
      `,
      [req.user.id],
    );

    const dbUser = result.rows[0];
    if (!dbUser) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const createdAt = dbUser?.createdAt;
    const role = dbUser?.role || (dbUser?.is_seller ? 'seller' : req.user.role);

    const firstSaleFreeRank = Number(dbUser?.firstSaleFreeRank);

    const firstSaleFreeAvailable =
      role === 'seller' &&
      Number.isInteger(firstSaleFreeRank) &&
      firstSaleFreeRank >= 1 &&
      firstSaleFreeRank <= 10 &&
      !dbUser?.firstSaleFreeUsedAt &&
      dbUser?.hasPaidSellerOrder !== true;

    const sellerPlatformFeeBps = 1000;

    return res.json({
      user: {
        id: req.user.id,
        email: dbUser?.email || req.user.email,
        username: dbUser?.username || req.user.username,
        fullName: dbUser?.fullName ?? null,
        role,
        createdAt,
        avatarUrl: dbUser?.avatarUrl ?? null,
        avatarPublicId: dbUser?.avatarPublicId ?? null,
        firstSaleFreeAvailable,
        sellerPlatformFeeBps,
      },
    });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const usernameSuggestions = async (req, res) => {
  try {
    const adjectives = [
      'prime',
      'pro',
      'smart',
      'rapid',
      'elite',
      'next',
      'core',
      'alpha',
      'nova',
      'true',
      'ultra',
      'solid',
      'bright',
      'bold',
      'clear',
      'sharp',
      'clean',
      'fast',
      'meta',
      'zen',
      'hyper',
      'logic',
      'urban',
      'global',
      'direct',
      'fresh',
      'modern',
      'secure',
      'open',
      'base',
    ];

    const nouns = [
      'launch',
      'studio',
      'builder',
      'market',
      'asset',
      'stack',
      'craft',
      'code',
      'site',
      'app',
      'platform',
      'engine',
      'hub',
      'space',
      'flow',
      'works',
      'forge',
      'lab',
      'store',
      'factory',
      'system',
      'network',
      'digital',
      'product',
      'service',
      'tech',
      'design',
      'supply',
      'trade',
      'source',
      'grid',
      'point',
      'center',
      'zone',
      'field',
      'line',
      'group',
      'house',
      'core',
      'cloud',
    ];

    const suggestions = new Set();

    while (suggestions.size < 5) {
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const noun = nouns[Math.floor(Math.random() * nouns.length)];
      const number = Math.floor(1000 + Math.random() * 9000);

      const username = `${adj}${noun}${number}`.slice(0, 20);

      const existing = await pool.query(
        'SELECT id FROM users WHERE username = $1 LIMIT 1',
        [username],
      );

      if (existing.rows.length === 0) {
        suggestions.add(username);
      }
    }

    return res.json({ suggestions: Array.from(suggestions) });
  } catch (err) {
    console.error('Username suggestions error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();

    const genericMessage =
      'If an account exists, we sent password reset instructions.';

    if (!email) {
      return res.status(400).json({
        fieldErrors: {
          email: 'Email is required.',
        },
      });
    }

    const result = await pool.query(
      `
      SELECT id, email
      FROM users
      WHERE email = $1
        AND status = 'active'
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [email],
    );

    const user = result.rows[0];

    if (!user) {
      return res.json({ message: genericMessage });
    }

    await pool.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '60 minutes')`,
      [user.id, tokenHash],
    );

    if (!process.env.CLIENT_URL) {
      throw new Error('CLIENT_URL is missing.');
    }

    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${rawToken}`;

    await sendPasswordResetEmail({
      to: user.email,
      resetUrl,
    });

    return res.json({ message: genericMessage });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Reset token is required.',
      });
    }

    const hasSymbol = /[^A-Za-z0-9]/.test(password);

    if (!password || password.length < 8 || !hasSymbol) {
      return res.status(400).json({
        fieldErrors: {
          password:
            'Password must be at least 8 characters and include a symbol.',
        },
      });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const result = await pool.query(
      `
  SELECT prt.id, prt.user_id
  FROM password_reset_tokens prt
  INNER JOIN users u
    ON u.id = prt.user_id
  WHERE prt.token_hash = $1
    AND prt.used_at IS NULL
    AND prt.expires_at > NOW()
    AND u.status = 'active'
    AND u.deleted_at IS NULL
  LIMIT 1
  `,
      [tokenHash],
    );

    const resetToken = result.rows[0];

    if (!resetToken) {
      return res.status(400).json({
        error: 'This reset link is invalid or has expired.',
      });
    }

    const hashedPassword = await hashPassword(password);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hashedPassword,
        resetToken.user_id,
      ]);

      await client.query(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
        [resetToken.id],
      );

      await client.query('COMMIT');

      return res.json({
        message: 'Password reset successfully. Please sign in.',
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  register,
  login,
  logout,
  changePassword,
  deleteAccount,
  me,
  usernameSuggestions,
  forgotPassword,
  resetPassword,
};
