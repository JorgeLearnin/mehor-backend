const jwt = require('jsonwebtoken');

const getDashboardJwtSecret = () => {
  if (!process.env.DASHBOARD_JWT_SECRET) {
    throw new Error('DASHBOARD_JWT_SECRET is missing.');
  }

  return process.env.DASHBOARD_JWT_SECRET;
};

const signSessionToken = (user, remember = true) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: remember ? '14d' : '12h' },
  );
};

const verifySessionToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

const signDashboardSessionToken = (user, remember = true) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      type: 'dashboard',
    },
    getDashboardJwtSecret(),
    { expiresIn: remember ? '14d' : '12h' },
  );
};

const verifyDashboardSessionToken = (token) => {
  const payload = jwt.verify(token, getDashboardJwtSecret());

  if (payload?.type !== 'dashboard') {
    throw new Error('Invalid dashboard session');
  }

  return payload;
};

module.exports = {
  signSessionToken,
  verifySessionToken,
  signDashboardSessionToken,
  verifyDashboardSessionToken,
};
