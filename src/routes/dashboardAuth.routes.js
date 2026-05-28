const express = require('express');
const {
  login,
  me,
  logout,
} = require('../controllers/dashboardAuth.controller');
const requireDashboardAuth = require('../middleware/requireDashboardAuth');

const router = express.Router();

router.post('/login', login);
router.get('/me', requireDashboardAuth, me);
router.post('/logout', requireDashboardAuth, logout);

module.exports = router;
