const express = require('express');
const router = express.Router();

const {
  register,
  login,
  logout,
  changePassword,
  deleteAccount,
  me,
  usernameSuggestions,
  forgotPassword,
  resetPassword,
} = require('../controllers/auth.controller');

const requireAuth = require('../middleware/requireAuth');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.get('/username-suggestions', usernameSuggestions);
router.get('/me', requireAuth, me);
router.patch('/password', requireAuth, changePassword);
router.post('/delete-account', requireAuth, deleteAccount);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;