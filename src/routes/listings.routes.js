const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/requireAuth');
const {
  createListing,
  getListings,
  getListingSeo,
  getListingById,
  getMyListingById,
  getDraftListing,
  updateDraftListing,
  publishDraftListing,
  getMyPublishedListings,
  deleteListing,
  updatePublishedListing,
  getListingQa,
  createListingQuestion,
  updateListingQuestion,
  createListingQuestionReply,
  updateListingQuestionReply,
  toggleListingQuestionLike,
} = require('../controllers/listing.controller');

router.get('/', getListings);
router.get('/draft', requireAuth, getDraftListing);
router.patch('/draft', requireAuth, updateDraftListing);
router.post('/draft/publish', requireAuth, publishDraftListing);
router.get('/seller/me', requireAuth, getMyPublishedListings);
router.get('/seller/:listingId', requireAuth, getMyListingById);
router.patch('/:listingId', requireAuth, updatePublishedListing);
router.delete('/:listingId', requireAuth, deleteListing);
router.post('/', requireAuth, createListing);

router.get('/:listingId/seo', getListingSeo);
router.get('/:listingId/qa', getListingQa);
router.post('/:listingId/qa', requireAuth, createListingQuestion);
router.patch('/:listingId/qa/:questionId', requireAuth, updateListingQuestion);
router.post(
  '/:listingId/qa/:questionId/replies',
  requireAuth,
  createListingQuestionReply,
);
router.patch(
  '/:listingId/qa/:questionId/replies/:replyId',
  requireAuth,
  updateListingQuestionReply,
);
router.post(
  '/:listingId/qa/:questionId/like',
  requireAuth,
  toggleListingQuestionLike,
);

router.get('/:listingId', getListingById);

module.exports = router;
