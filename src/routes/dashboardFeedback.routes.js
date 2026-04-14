'use strict';

const express = require('express');

const { requireDashboardAuth } = require('../middlewares/requireDashboardAuth');
const {
  listDashboardFeedback,
  getDashboardFeedback,
  removeDashboardFeedback,
} = require('../controllers/dashboardFeedback.controller');

const router = express.Router();

router.get('/feedback', requireDashboardAuth, listDashboardFeedback);
router.get('/feedback/:id', requireDashboardAuth, getDashboardFeedback);
router.delete('/feedback/:id', requireDashboardAuth, removeDashboardFeedback);

module.exports = { dashboardFeedbackRouter: router };
