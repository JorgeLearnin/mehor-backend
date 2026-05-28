const express = require('express');

const requireAuth = require('../middleware/requireAuth');
const {
  getMyProfile,
  updateMyProfile,
} = require('../controllers/profile.controller');

const router = express.Router();

router.get('/me', requireAuth, getMyProfile);
router.patch('/me', requireAuth, updateMyProfile);

module.exports = router;
