const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/requireAuth');

const {
  getThreads,
  createThread,
  getUnreadMessageStatus,
  getThreadMessages,
  createMessage,
  markThreadRead,
  archiveThread,
} = require('../controllers/message.controller');

router.get('/unread-status', requireAuth, getUnreadMessageStatus);
router.get('/threads', requireAuth, getThreads);
router.post('/threads', requireAuth, createThread);
router.get('/threads/:threadId/messages', requireAuth, getThreadMessages);
router.post('/threads/:threadId/messages', requireAuth, createMessage);
router.patch('/threads/:threadId/read', requireAuth, markThreadRead);
router.patch('/threads/:threadId/archive', requireAuth, archiveThread);

module.exports = router;
