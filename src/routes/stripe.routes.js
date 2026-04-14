'use strict';

const express = require('express');

const { requireAuth } = require('../middlewares/requireAuth');
const { requireSeller } = require('../middlewares/requireSeller');
const {
  createPaymentIntent,
  createSellerOnboardingLink,
  createPaymentMethodSetupIntent,
  listPaymentMethods,
  getDefaultPaymentMethod,
  setDefaultPaymentMethod,
  detachPaymentMethod,
} = require('../controllers/stripe.controller');

const router = express.Router();

// Buyer: start payment for a listing (Elements + PaymentIntent)
router.post('/payment-intent', requireAuth, createPaymentIntent);

// Buyer: save/update payment method (SetupIntent + Customer)
router.post(
  '/payment-methods/setup-intent',
  requireAuth,
  createPaymentMethodSetupIntent,
);
router.get('/payment-methods', requireAuth, listPaymentMethods);
router.get('/payment-methods/default', requireAuth, getDefaultPaymentMethod);
router.post(
  '/payment-methods/set-default',
  requireAuth,
  setDefaultPaymentMethod,
);
router.post('/payment-methods/detach', requireAuth, detachPaymentMethod);

// Seller: start Stripe Connect onboarding (Express)
router.post(
  '/connect/onboarding-link',
  requireAuth,
  requireSeller,
  createSellerOnboardingLink,
);

module.exports = { stripeRouter: router };
