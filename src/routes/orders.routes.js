'use strict';

const express = require('express');
const multer = require('multer');
const requireAuth = require('../middleware/requireAuth');
const {
  getBuyerOrders,
  getSellerOrders,
  getOrderById,
  submitOrderDelivery,
  approveMainDelivery,
  completeAddonsDelivery,
  approveAddonsDelivery,
  approveDisputedDelivery,
  openOrderDispute,
  replyToOrderDispute,
  extendOrderTime,
  downloadOrderDisputeAttachment,
  downloadOrderReceipt,
  downloadOrderDeliveryZip,
  createPaymentIntent,
  getPaymentIntentOrderStatus,
} = require('../controllers/order.controller.js');

const router = express.Router();

const deliveryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

const disputeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

router.get('/buyer', requireAuth, getBuyerOrders);
router.get('/seller', requireAuth, getSellerOrders);
router.post('/payment-intent', requireAuth, createPaymentIntent);
router.get(
  '/payment-intent/:paymentIntentId',
  requireAuth,
  getPaymentIntentOrderStatus,
);

router.post(
  '/:orderId/delivery',
  requireAuth,
  deliveryUpload.single('zip'),
  submitOrderDelivery,
);

router.post(
  '/:orderId/approve-main-delivery',
  requireAuth,
  approveMainDelivery,
);

router.post(
  '/:orderId/complete-addons-delivery',
  requireAuth,
  completeAddonsDelivery,
);

router.post(
  '/:orderId/approve-addons-delivery',
  requireAuth,
  approveAddonsDelivery,
);

router.post('/:orderId/time-extensions', requireAuth, extendOrderTime);

router.post(
  '/:orderId/disputes',
  requireAuth,
  disputeUpload.array('screenshots', 5),
  openOrderDispute,
);

router.post(
  '/:orderId/disputes/:disputeId/messages',
  requireAuth,
  disputeUpload.array('attachments', 5),
  replyToOrderDispute,
);

router.post(
  '/:orderId/disputes/:disputeId/approve-delivery',
  requireAuth,
  approveDisputedDelivery,
);

router.get('/:orderId/receipt', requireAuth, downloadOrderReceipt);

router.get(
  '/:orderId/deliveries/:deliveryId/download-zip',
  requireAuth,
  downloadOrderDeliveryZip,
);

router.get(
  '/:orderId/dispute-attachments/:attachmentId/download',
  requireAuth,
  downloadOrderDisputeAttachment,
);

router.get('/:orderId', requireAuth, getOrderById);

module.exports = router;
