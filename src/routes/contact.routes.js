const express = require('express');
const { postContactMessage } = require('../controllers/contact.controller');

const router = express.Router();

router.post('/', postContactMessage);

module.exports = router;
