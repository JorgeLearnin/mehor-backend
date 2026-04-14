'use strict';

function setSessionCookie(res, token, opts = {}) {
  const name = process.env.COOKIE_NAME || 'mehor_session';
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
        : 14 * 24 * 60 * 60 * 1000;
  }

  res.cookie(name, token, options);
}

function clearSessionCookie(res) {
  const name = process.env.COOKIE_NAME || 'mehor_session';
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie(name, {
    path: '/',
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
  });
}

module.exports = { setSessionCookie, clearSessionCookie };
