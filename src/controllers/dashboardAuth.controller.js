'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { signSession, verifySession } = require('../utils/jwt');

const DASHBOARD_COOKIE_NAME =
  process.env.DASHBOARD_COOKIE_NAME || 'mehor_admin_session';

function setDashboardSessionCookie(res, token, opts = {}) {
  const remember = opts.remember !== false;
  const isProd = process.env.NODE_ENV === 'production';

  const options = {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    path: '/',
  };

  if (remember) {
    options.maxAge =
      typeof opts.maxAgeMs === 'number'
        ? opts.maxAgeMs
        : 30 * 24 * 60 * 60 * 1000;
  }

  res.cookie(DASHBOARD_COOKIE_NAME, token, options);
}

function clearDashboardSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(DASHBOARD_COOKIE_NAME, {
    path: '/',
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
  });
}

function login(req, res) {
  const { email, password, remember } = req.body || {};
  const resolvedEmail = String(email ?? '').trim();

  if (!resolvedEmail || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = db
    .prepare(
      `SELECT id, email, password_hash, role, status
         FROM dashboard_users
        WHERE email = ?`,
    )
    .get(resolvedEmail);

  if (!user?.password_hash || user.status !== 'active') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const ok = bcrypt.compareSync(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signSession({
    type: 'dashboard',
    id: user.id,
    email: user.email,
    role: user.role,
  });

  const rememberMe = remember === false ? false : true;
  setDashboardSessionCookie(res, token, { remember: rememberMe });

  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE dashboard_users SET last_login_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, user.id);
  } catch {
    // ignore
  }

  return res.json({ ok: true });
}

function logout(req, res) {
  clearDashboardSessionCookie(res);
  return res.json({ ok: true });
}

function me(req, res) {
  const token = req.cookies?.[DASHBOARD_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let payload;
  try {
    payload = verifySession(token);
  } catch {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!payload || payload.type !== 'dashboard' || !payload.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = db
    .prepare(
      `SELECT id, email, role, status, created_at AS createdAt, last_login_at AS lastLoginAt
         FROM dashboard_users
        WHERE id = ?`,
    )
    .get(payload.id);

  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  return res.json({ user });
}

module.exports = { login, logout, me };
