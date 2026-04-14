'use strict';

const express = require('express');
const multer = require('multer');

const { requireAuth } = require('../middlewares/requireAuth');
const { requireSeller } = require('../middlewares/requireSeller');
const {
  createListing,
  createListingScreenshotUploadSignature,
  listMyListings,
  listPublicListings,
  searchPublicListings,
  getPublicListing,
  listPublicListingQa,
  createPublicListingQuestion,
  createPublicListingReply,
  updatePublicListingQuestion,
  deletePublicListingQuestion,
  updatePublicListingReply,
  deletePublicListingReply,
  togglePublicListingQuestionLike,
  getMyListing,
  getLatestDraft,
  updateListing,
  deleteListing,
} = require('../controllers/listings.controller');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 0,
  },
});

router.get('/public', listPublicListings);

router.get('/public/search', searchPublicListings);

router.get('/public/:id', getPublicListing);

router.get('/public/:id/qa', listPublicListingQa);
router.post('/public/:id/qa', requireAuth, createPublicListingQuestion);
router.put(
  '/public/:id/qa/:questionId',
  requireAuth,
  updatePublicListingQuestion,
);
router.delete(
  '/public/:id/qa/:questionId',
  requireAuth,
  deletePublicListingQuestion,
);
router.post(
  '/public/:id/qa/:questionId/replies',
  requireAuth,
  createPublicListingReply,
);
router.put(
  '/public/:id/qa/:questionId/replies/:replyId',
  requireAuth,
  updatePublicListingReply,
);
router.delete(
  '/public/:id/qa/:questionId/replies/:replyId',
  requireAuth,
  deletePublicListingReply,
);
router.post(
  '/public/:id/qa/:questionId/like',
  requireAuth,
  togglePublicListingQuestionLike,
);

router.get('/mine', requireAuth, requireSeller, listMyListings);

router.get('/draft/latest', requireAuth, requireSeller, getLatestDraft);
router.post(
  '/upload-signature',
  requireAuth,
  requireSeller,
  createListingScreenshotUploadSignature,
);

router.post('/', requireAuth, requireSeller, upload.none(), createListing);
router.get('/:id', requireAuth, requireSeller, getMyListing);
router.put('/:id', requireAuth, requireSeller, upload.none(), updateListing);

router.delete('/:id', requireAuth, requireSeller, deleteListing);

module.exports = { listingsRouter: router };
