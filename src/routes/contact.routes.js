'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { submitContact } = require('../controllers/contact.controller');

const contactRouter = express.Router();

// Tighter per-endpoint limit to reduce abuse.
contactRouter.use(
  rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);

contactRouter.post('/', submitContact);

module.exports = { contactRouter };
