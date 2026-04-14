'use strict';

const express = require('express');
const multer = require('multer');

const { requireAuth } = require('../middlewares/requireAuth');
const {
  createOrder,
  getOrder,
  finalizePaidOrder,
  createDeliveryZipUploadSignature,
  uploadDeliveryZipDraft,
  updateDeliveryRepoDraft,
  markDelivered,
  downloadDeliveryZip,
  downloadReceiptPdf,
  markCompleted,
  markAddOnsCompleted,
  requestMoreTime,
  approveMoreTimeRequest,
  declineMoreTimeRequest,
  openDispute,
  cancelDispute,
  setDisputeSeedImages,
} = require('../controllers/orders.controller');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 80 * 1024 * 1024, // 80MB
  },
});

router.post('/', requireAuth, createOrder);
router.post('/finalize', requireAuth, finalizePaidOrder);
router.get('/:id', requireAuth, getOrder);
router.post(
  '/:id/delivery-zip-upload',
  requireAuth,
  createDeliveryZipUploadSignature,
);
router.post(
  '/:id/delivery-zip-draft',
  requireAuth,
  upload.single('zip'),
  uploadDeliveryZipDraft,
);
router.post('/:id/delivery-repo-draft', requireAuth, updateDeliveryRepoDraft);
router.get('/:id/delivery-zip', requireAuth, downloadDeliveryZip);
router.get('/:id/receipt', requireAuth, downloadReceiptPdf);
router.post('/:id/deliver', requireAuth, upload.single('zip'), markDelivered);
router.post('/:id/complete', requireAuth, markCompleted);
router.post('/:id/addons/complete', requireAuth, markAddOnsCompleted);
router.post('/:id/more-time', requireAuth, requestMoreTime);
router.post(
  '/:id/more-time/:requestId/approve',
  requireAuth,
  approveMoreTimeRequest,
);
router.post(
  '/:id/more-time/:requestId/decline',
  requireAuth,
  declineMoreTimeRequest,
);
router.post('/:id/dispute', requireAuth, openDispute);
router.post('/:id/dispute/cancel', requireAuth, cancelDispute);
router.post(
  '/:id/disputes/:disputeId/seed-images',
  requireAuth,
  setDisputeSeedImages,
);

module.exports = { ordersRouter: router };
