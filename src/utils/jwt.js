'use strict';

const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && !secret) {
  throw new Error('JWT_SECRET is required in production');
}

function signSession(payload) {
  return jwt.sign(payload, secret, { expiresIn: '14d' });
}

function verifySession(token) {
  return jwt.verify(token, secret);
}

module.exports = { signSession, verifySession };
