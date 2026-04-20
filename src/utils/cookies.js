'use strict';

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

function getCookieDomain(req) {
  const hostname = getRequestHostname(req);
  if (isLocalHostname(hostname)) return undefined;
  if (process.env.NODE_ENV !== 'production') return undefined;

  const value = String(process.env.COOKIE_DOMAIN || '.mehor.com').trim();
  return value || undefined;
}

function shouldUseSecureCookie(req) {
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

function getSessionCookieOptions(req, { includeDomain = true } = {}) {
  const options = {
    path: '/',
    secure: shouldUseSecureCookie(req),
    sameSite: 'lax',
  };

  if (includeDomain) {
    const domain = getCookieDomain(req);
    if (domain) options.domain = domain;
  }

  return options;
}

function setSessionCookie(req, res, token, opts = {}) {
  const name = process.env.COOKIE_NAME || 'mehor_session';
  const remember = opts.remember !== false;

  const options = {
    httpOnly: true,
    ...getSessionCookieOptions(req),
  };

  if (remember) {
    options.maxAge =
      typeof opts.maxAgeMs === 'number'
        ? opts.maxAgeMs
        : 14 * 24 * 60 * 60 * 1000;
  }

  res.cookie(name, token, options);
}

function clearSessionCookie(req, res) {
  const name = process.env.COOKIE_NAME || 'mehor_session';
  res.clearCookie(name, getSessionCookieOptions(req));
  res.clearCookie(name, getSessionCookieOptions(req, { includeDomain: false }));
}

module.exports = { setSessionCookie, clearSessionCookie };
