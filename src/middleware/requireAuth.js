const pool = require('../db');
const { verifySessionToken } = require('../utils/token');
const { clearSessionCookie } = require('../utils/cookies');

const requireAuth = async (req, res, next) => {
  const cookieName = process.env.COOKIE_NAME || 'mehor_session';
  const token = req.cookies?.[cookieName];

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const sessionUser = verifySessionToken(token);

    const result = await pool.query(
      `
      SELECT
        id,
        email,
        username,
        role,
        status,
        deleted_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [sessionUser.id],
    );

    const user = result.rows[0];

    if (!user || user.status !== 'active' || user.deleted_at) {
      clearSessionCookie(res);

      return res.status(401).json({ error: 'Not authenticated' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
};

module.exports = requireAuth;
