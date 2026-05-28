const REMEMBER_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const getBaseCookieOptions = () => {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  };

  return options;
};

const applyCookieDomain = ({ options, domain }) => {
  if (domain) {
    options.domain = domain;
  }

  return options;
};

const applyRememberCookieLifetime = (options, remember = true) => {
  if (!remember) {
    return options;
  }

  return {
    ...options,
    maxAge: REMEMBER_SESSION_MAX_AGE_MS,
    expires: new Date(Date.now() + REMEMBER_SESSION_MAX_AGE_MS),
  };
};

const getMarketplaceCookieOptions = (remember = true) => {
  const options = applyCookieDomain({
    options: getBaseCookieOptions(),
    domain: process.env.COOKIE_DOMAIN,
  });

  return applyRememberCookieLifetime(options, remember);
};

const getDashboardCookieOptions = (remember = true) => {
  const options = applyCookieDomain({
    options: getBaseCookieOptions(),
    domain: process.env.DASHBOARD_COOKIE_DOMAIN,
  });

  return applyRememberCookieLifetime(options, remember);
};

const getMarketplaceClearCookieOptions = () => {
  return applyCookieDomain({
    options: {
      ...getBaseCookieOptions(),
      expires: new Date(0),
    },
    domain: process.env.COOKIE_DOMAIN,
  });
};

const getDashboardClearCookieOptions = () => {
  return applyCookieDomain({
    options: {
      ...getBaseCookieOptions(),
      expires: new Date(0),
    },
    domain: process.env.DASHBOARD_COOKIE_DOMAIN,
  });
};

const setSessionCookie = (res, token, remember = true) => {
  res.cookie(
    process.env.COOKIE_NAME || 'mehor_session',
    token,
    getMarketplaceCookieOptions(remember),
  );
};

const clearSessionCookie = (res) => {
  res.clearCookie(
    process.env.COOKIE_NAME || 'mehor_session',
    getMarketplaceClearCookieOptions(),
  );
};

const setDashboardSessionCookie = (res, token, remember = true) => {
  res.cookie(
    process.env.DASHBOARD_COOKIE_NAME || 'mehor_dashboard_session',
    token,
    getDashboardCookieOptions(remember),
  );
};

const clearDashboardSessionCookie = (res) => {
  res.clearCookie(
    process.env.DASHBOARD_COOKIE_NAME || 'mehor_dashboard_session',
    getDashboardClearCookieOptions(),
  );
};

module.exports = {
  REMEMBER_SESSION_MAX_AGE_MS,
  setSessionCookie,
  clearSessionCookie,
  setDashboardSessionCookie,
  clearDashboardSessionCookie,
};