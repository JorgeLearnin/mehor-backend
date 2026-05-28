const pool = require('../db');
const { comparePassword } = require('../utils/password');
const { signDashboardSessionToken } = require('../utils/token');
const {
  setDashboardSessionCookie,
  clearDashboardSessionCookie,
} = require('../utils/cookies');

const login = async (req, res) => {
  try {
    const email = req.body.email?.trim().toLowerCase();
    const { password, remember = true } = req.body;

    const fieldErrors = {
      email: '',
      password: '',
    };

    if (!email) {
      fieldErrors.email = 'Email is required.';
    }

    if (!password) {
      fieldErrors.password = 'Password is required.';
    }

    if (fieldErrors.email || fieldErrors.password) {
      return res.status(400).json({ fieldErrors });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        email,
        password_hash,
        full_name,
        role,
        status
      FROM dashboard_users
      WHERE lower(email) = lower($1)
      LIMIT 1
      `,
      [email],
    );

    const user = result.rows[0];

    if (!user || user.status !== 'active') {
      return res.status(401).json({
        fieldErrors: {
          email: 'No dashboard account found for this email.',
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

    await pool.query(
      `
      UPDATE dashboard_users
      SET last_login_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      `,
      [user.id],
    );

    const token = signDashboardSessionToken(user, remember);
    setDashboardSessionCookie(res, token, remember);

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Dashboard login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

const me = async (req, res) => {
  return res.json({
    user: req.dashboardUser,
  });
};

const logout = (req, res) => {
  clearDashboardSessionCookie(res);
  return res.json({ ok: true });
};

module.exports = {
  login,
  me,
  logout,
};