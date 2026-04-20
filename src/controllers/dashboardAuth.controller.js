'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const { signSession, verifySession } = require('../utils/jwt');

const DASHBOARD_COOKIE_NAME =
  process.env.DASHBOARD_COOKIE_NAME || 'mehor_admin_session';

function getRequestHostname(req) {
  const rawHost =
    req?.hostname || req?.get?.('x-forwarded-host') || req?.get?.('host') || '';
  return String(rawHost).trim().split(':')[0].toLowerCase();
}

function isLocalHostname(hostname) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

function getDashboardCookieDomain(req) {
  const hostname = getRequestHostname(req);
  if (isLocalHostname(hostname)) return undefined;
  if (process.env.NODE_ENV !== 'production') return undefined;

  const value = String(process.env.COOKIE_DOMAIN || '.mehor.com').trim();
  return value || undefined;
}

function shouldUseSecureDashboardCookie(req) {
  const hostname = getRequestHostname(req);
  if (isLocalHostname(hostname)) return false;
  if (req?.secure) return true;

  const forwardedProto = String(req?.get?.('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto === 'https') return true;

  return process.env.NODE_ENV === 'production';
}

function getDashboardCookieOptions(req, { includeDomain = true } = {}) {
  const options = {
    path: '/',
    secure: shouldUseSecureDashboardCookie(req),
    sameSite: 'lax',
  };

  if (includeDomain) {
    const domain = getDashboardCookieDomain(req);
    if (domain) options.domain = domain;
  }

  return options;
}

function setDashboardSessionCookie(req, res, token, opts = {}) {
  const remember = opts.remember !== false;

  const options = {
    httpOnly: true,
    ...getDashboardCookieOptions(req),
  };

  if (remember) {
    options.maxAge =
      typeof opts.maxAgeMs === 'number'
        ? opts.maxAgeMs
        : 30 * 24 * 60 * 60 * 1000;
  }

  res.cookie(DASHBOARD_COOKIE_NAME, token, options);
}

function clearDashboardSessionCookie(req, res) {
  // Clear both domain-scoped and host-only variants so stale cookies do not
  // trap the dashboard behind client-side cookie presence checks.
  res.clearCookie(DASHBOARD_COOKIE_NAME, getDashboardCookieOptions(req));
  res.clearCookie(
    DASHBOARD_COOKIE_NAME,
    getDashboardCookieOptions(req, { includeDomain: false }),
  );
}

async function login(req, res) {
  const { email, password, remember } = req.body || {};
  const resolvedEmail = String(email ?? '').trim();

  if (!resolvedEmail || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = await db
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
  clearDashboardSessionCookie(req, res);
  setDashboardSessionCookie(req, res, token, { remember: rememberMe });

  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `UPDATE dashboard_users SET last_login_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, user.id);
  } catch {
    // ignore
  }

  return res.json({ ok: true });
}

function logout(req, res) {
  clearDashboardSessionCookie(req, res);
  return res.json({ ok: true });
}

async function me(req, res) {
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

  const user = await db
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
