'use strict';

const express = require('express');

const { requireAuth } = require('../middlewares/requireAuth');
const {
  listThreads,
  getThreadMessages,
  downloadThreadMessageAttachment,
  sendMessage,
  createThreadImageUploadSignature,
  setThreadArchived,
  setThreadReadState,
  createOrGetThread,
  createOrGetThreadByOrder,
  createOrGetDisputeThreadByOrder,
} = require('../controllers/messages.controller');

const router = express.Router();

router.get('/threads', requireAuth, listThreads);
router.post('/threads', requireAuth, createOrGetThread);
router.post('/threads/by-order', requireAuth, createOrGetThreadByOrder);
router.post(
  '/threads/dispute-by-order',
  requireAuth,
  createOrGetDisputeThreadByOrder,
);

router.get('/threads/:threadId/messages', requireAuth, getThreadMessages);
router.get(
  '/threads/:threadId/messages/:messageId/attachment',
  requireAuth,
  downloadThreadMessageAttachment,
);
router.post('/threads/:threadId/messages', requireAuth, sendMessage);
router.post(
  '/threads/:threadId/images/upload',
  requireAuth,
  createThreadImageUploadSignature,
);

router.post('/threads/:threadId/archive', requireAuth, setThreadArchived);
router.post('/threads/:threadId/read', requireAuth, setThreadReadState);

module.exports = { messagesRouter: router };
