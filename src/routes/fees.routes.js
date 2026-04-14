'use strict';

const express = require('express');
const { getPublicFees } = require('../controllers/fees.controller');

const router = express.Router();

router.get('/public', getPublicFees);

module.exports = { feesRouter: router };
