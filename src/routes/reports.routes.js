'use strict';

const express = require('express');

const { requireAuth } = require('../middlewares/requireAuth');
const {
  listReportReasons,
  submitReport,
} = require('../controllers/reports.controller');

const router = express.Router();

router.get('/options', listReportReasons);
router.post('/', requireAuth, submitReport);

module.exports = { reportsRouter: router };
