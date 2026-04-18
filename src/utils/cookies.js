'use strict';

function getCookieDomain() {
  if (process.env.NODE_ENV !== 'production') return undefined;

  const value = String(process.env.COOKIE_DOMAIN || '.mehor.com').trim();
  return value || undefined;
}

function setSessionCookie(res, token, opts = {}) {
  const name = process.env.COOKIE_NAME || 'mehor_session';
  const remember = opts.remember !== false;
  const isProd = process.env.NODE_ENV === 'production';

  const options = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    domain: getCookieDomain(),
    path: '/',
  };

  if (remember) {
    options.maxAge =
      typeof opts.maxAgeMs === 'number'
        ? opts.maxAgeMs
        : 14 * 24 * 60 * 60 * 1000;
  }

  res.cookie(name, token, options);
}

function clearSessionCookie(res) {
  const name = process.env.COOKIE_NAME || 'mehor_session';
  res.clearCookie(name, {
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: getCookieDomain(),
  });
}

module.exports = { setSessionCookie, clearSessionCookie };
