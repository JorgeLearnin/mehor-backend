'use strict';

const express = require('express');

const { requireDashboardAuth } = require('../middlewares/requireDashboardAuth');
const {
  listDashboardDisputes,
  listDashboardDisputeMessages,
  downloadDashboardDisputeAttachment,
  createDashboardDisputeImageUploadSignature,
  sendDashboardDisputeMessage,
  resolveDashboardDispute,
} = require('../controllers/dashboardDisputes.controller');

const router = express.Router();

router.get('/disputes', requireDashboardAuth, listDashboardDisputes);
router.get(
  '/disputes/:orderId/messages',
  requireDashboardAuth,
  listDashboardDisputeMessages,
);
router.get(
  '/disputes/:orderId/messages/:messageId/attachment',
  requireDashboardAuth,
  downloadDashboardDisputeAttachment,
);
router.post(
  '/disputes/:orderId/messages/upload',
  requireDashboardAuth,
  createDashboardDisputeImageUploadSignature,
);

router.post(
  '/disputes/:orderId/messages',
  requireDashboardAuth,
  sendDashboardDisputeMessage,
);

router.post(
  '/disputes/:orderId/resolve',
  requireDashboardAuth,
  resolveDashboardDispute,
);

module.exports = { dashboardDisputesRouter: router };
