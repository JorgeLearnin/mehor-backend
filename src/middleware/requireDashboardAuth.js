const pool = require('../db');
const { verifyDashboardSessionToken } = require('../utils/token');
const { clearDashboardSessionCookie } = require('../utils/cookies');

const requireDashboardAuth = async (req, res, next) => {
  const cookieName =
    process.env.DASHBOARD_COOKIE_NAME || 'mehor_dashboard_session';
  const token = req.cookies?.[cookieName];

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const sessionUser = verifyDashboardSessionToken(token);

    const result = await pool.query(
      `
      SELECT
        id,
        email,
        full_name,
        role,
        status
      FROM dashboard_users
      WHERE id = $1
      LIMIT 1
      `,
      [sessionUser.id],
    );

    const user = result.rows[0];

    if (!user || user.status !== 'active') {
      clearDashboardSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }

    req.dashboardUser = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
    };

    return next();
  } catch {
    clearDashboardSessionCookie(res);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
};

module.exports = requireDashboardAuth;