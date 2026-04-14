'use strict';

const express = require('express');

const { requireAuth } = require('../middlewares/requireAuth');
const {
  listFeedbackSubjectOptions,
  submitFeedback,
} = require('../controllers/feedback.controller');

const router = express.Router();

router.get('/options', requireAuth, listFeedbackSubjectOptions);
router.post('/', requireAuth, submitFeedback);

module.exports = { feedbackRouter: router };
