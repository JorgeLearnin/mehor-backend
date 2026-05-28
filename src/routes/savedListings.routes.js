const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/requireAuth');

const {
  saveListing,
  getSavedListingStatus,
  getSavedListings,
  removeSavedListing,
} = require('../controllers/savedListing.controller');

router.get('/', requireAuth, getSavedListings);
router.get('/check/:listingId', requireAuth, getSavedListingStatus);
router.post('/:listingId', requireAuth, saveListing);
router.delete('/:listingId', requireAuth, removeSavedListing);

module.exports = router;
