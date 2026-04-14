'use strict';

const express = require('express');

const { requireAuth } = require('../middlewares/requireAuth');
const {
  listNotifications,
  markNotificationRead,
  markAllRead,
  deleteAll,
} = require('../controllers/notifications.controller');

const router = express.Router();

router.get('/', requireAuth, listNotifications);
router.post('/read-all', requireAuth, markAllRead);
router.post('/:notificationId/read', requireAuth, markNotificationRead);
router.delete('/', requireAuth, deleteAll);

module.exports = { notificationsRouter: router };
