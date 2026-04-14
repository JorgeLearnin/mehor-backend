'use strict';

const express = require('express');

const { requireAuth } = require('../middlewares/requireAuth');
const { requireSeller } = require('../middlewares/requireSeller');
const {
  listUsernames,
  lookupUsernames,
  listMySavedListings,
  mySavedContains,
  toggleMySavedListing,
  removeMySavedListing,
  listMyTransactions,
  listMyOrders,
  listMySales,
  getMyEarnings,
  withdrawMyEarnings,
} = require('../controllers/users.controller');

const router = express.Router();

router.get('/usernames', requireAuth, listUsernames);
router.post('/usernames/lookup', requireAuth, lookupUsernames);

// Saved listings
router.get('/me/saved-listings', requireAuth, listMySavedListings);
router.get(
  '/me/saved-listings/contains/:listingId',
  requireAuth,
  mySavedContains,
);
router.post('/me/saved-listings/toggle', requireAuth, toggleMySavedListing);
router.delete(
  '/me/saved-listings/:listingId',
  requireAuth,
  removeMySavedListing,
);

// Transactions (Billing)
router.get('/me/transactions', requireAuth, listMyTransactions);

// Orders (Purchases)
router.get('/me/orders', requireAuth, listMyOrders);

// Sales (Seller orders)
router.get('/me/sales', requireAuth, listMySales);

// Earnings (Seller payouts)
router.get('/me/earnings', requireAuth, requireSeller, getMyEarnings);
router.post(
  '/me/earnings/withdraw',
  requireAuth,
  requireSeller,
  withdrawMyEarnings,
);

module.exports = { usersRouter: router };
