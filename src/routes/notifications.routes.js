const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/requireAuth');

const {
  getNotifications,
  markNotificationsSeen,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../controllers/notification.controller');

router.get('/', requireAuth, getNotifications);
router.patch('/seen', requireAuth, markNotificationsSeen);
router.patch('/read-all', requireAuth, markAllNotificationsRead);
router.patch('/:notificationId/read', requireAuth, markNotificationRead);

module.exports = router;