'use strict';

const express = require('express');

const { requireDashboardAuth } = require('../middlewares/requireDashboardAuth');
const {
  listDashboardListings,
  disableDashboardListing,
  enableDashboardListing,
  deleteDashboardListing,
} = require('../controllers/dashboardListings.controller');

const router = express.Router();

router.get('/listings', requireDashboardAuth, listDashboardListings);
router.patch(
  '/listings/:id/disable',
  requireDashboardAuth,
  disableDashboardListing,
);
router.patch(
  '/listings/:id/enable',
  requireDashboardAuth,
  enableDashboardListing,
);
router.delete('/listings/:id', requireDashboardAuth, deleteDashboardListing);

module.exports = { dashboardListingsRouter: router };
