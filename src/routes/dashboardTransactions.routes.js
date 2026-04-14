'use strict';

const express = require('express');

const { requireDashboardAuth } = require('../middlewares/requireDashboardAuth');
const {
  listDashboardTransactions,
} = require('../controllers/dashboardTransactions.controller');

const router = express.Router();

router.get('/transactions', requireDashboardAuth, listDashboardTransactions);

module.exports = { dashboardTransactionsRouter: router };
