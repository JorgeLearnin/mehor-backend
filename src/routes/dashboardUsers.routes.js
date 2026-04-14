'use strict';

const express = require('express');

const { requireDashboardAuth } = require('../middlewares/requireDashboardAuth');
const {
  listDashboardUsers,
  restrictDashboardUser,
  unrestrictDashboardUser,
} = require('../controllers/dashboardUsers.controller');

const router = express.Router();

router.get('/users', requireDashboardAuth, listDashboardUsers);
router.patch(
  '/users/:id/restrict',
  requireDashboardAuth,
  restrictDashboardUser,
);
router.patch(
  '/users/:id/unrestrict',
  requireDashboardAuth,
  unrestrictDashboardUser,
);

module.exports = { dashboardUsersRouter: router };
