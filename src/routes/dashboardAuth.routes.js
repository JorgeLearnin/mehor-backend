'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  login,
  logout,
  me,
} = require('../controllers/dashboardAuth.controller');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/me', me);

module.exports = { dashboardAuthRouter: router };
