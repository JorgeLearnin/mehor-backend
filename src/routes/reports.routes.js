const express = require('express');

const requireAuth = require('../middleware/requireAuth');
const {
  getReportOptions,
  createReport,
} = require('../controllers/report.controller');

const router = express.Router();

router.get('/options', getReportOptions);
router.post('/', requireAuth, createReport);

module.exports = router;
