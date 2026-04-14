'use strict';

const express = require('express');

const { requireDashboardAuth } = require('../middlewares/requireDashboardAuth');
const {
  listDashboardReports,
  getDashboardReport,
  removeDashboardReport,
} = require('../controllers/dashboardReports.controller');

const router = express.Router();

router.get('/reports', requireDashboardAuth, listDashboardReports);
router.get('/reports/:id', requireDashboardAuth, getDashboardReport);
router.delete('/reports/:id', requireDashboardAuth, removeDashboardReport);

module.exports = { dashboardReportsRouter: router };
