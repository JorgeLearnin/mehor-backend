const express = require('express');

const requireAuth = require('../middleware/requireAuth');

const {
  getFeedbackOptions,
  createFeedback,
} = require('../controllers/feedback.controller');

const router = express.Router();

router.get('/options', getFeedbackOptions);
router.post('/', requireAuth, createFeedback);

module.exports = router;
