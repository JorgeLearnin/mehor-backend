'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middlewares/requireAuth');
const {
  register,
  lookupUsernamesPublic,
  login,
  me,
  createAvatarUploadSignature,
  updateFullName,
  updateProfile,
  changePassword,
  deleteAccount,
  logout,
  activateSeller,
  forgotPassword,
  resetPasswordStatus,
  resetPassword,
} = require('../controllers/auth.controller');

const router = express.Router();

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const usernameLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

router.post('/register', register);
router.post('/usernames/lookup', usernameLookupLimiter, lookupUsernamesPublic);
router.post('/login', login);
router.get('/me', requireAuth, me);
router.post('/me/avatar-upload', requireAuth, createAvatarUploadSignature);
router.post('/me/full-name', requireAuth, updateFullName);
router.post('/me/profile', requireAuth, updateProfile);
router.post('/me/change-password', requireAuth, changePassword);
router.post('/me/delete-account', requireAuth, deleteAccount);
router.post('/logout', logout);

router.post('/activate-seller', requireAuth, activateSeller);

router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password/status', resetPasswordStatus);
router.post('/reset-password', resetPassword);

module.exports = { authRouter: router };
