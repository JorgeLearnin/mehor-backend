const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/requireAuth');
const {
  getSellerOnboardingStatus,
  acceptSellerTerms,
  createStripeLink,
  createStripeDashboardLink,
  syncStripeStatus,
  activateSellerAccount,
} = require('../controllers/seller.controller');

router.get('/onboarding/status', requireAuth, getSellerOnboardingStatus);
router.post('/onboarding/accept-terms', requireAuth, acceptSellerTerms);
router.post('/onboarding/stripe-link', requireAuth, createStripeLink);
router.post('/stripe-dashboard-link', requireAuth, createStripeDashboardLink);
router.post('/onboarding/stripe-sync', requireAuth, syncStripeStatus);
router.post('/onboarding/activate', requireAuth, activateSellerAccount);

module.exports = router;
