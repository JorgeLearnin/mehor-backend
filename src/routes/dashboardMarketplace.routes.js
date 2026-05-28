const express = require('express');
const multer = require('multer');

const requireDashboardAuth = require('../middleware/requireDashboardAuth');

const {
  getDashboardUsers,
  updateUserRestriction,
  getDashboardListings,
  updateListingVisibility,
  getDashboardTransactions,
  getDashboardDisputes,
  getDashboardDisputeMessages,
  createDashboardDisputeMessage,
  resolveDashboardDispute,
  getDashboardFeedback,
  getDashboardReports,
} = require('../controllers/dashboardMarketplace.controller');

const router = express.Router();

const disputeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

router.use(requireDashboardAuth);

router.get('/users', getDashboardUsers);
router.patch('/users/:userId/restriction', updateUserRestriction);

router.get('/listings', getDashboardListings);
router.patch('/listings/:listingId/visibility', updateListingVisibility);

router.get('/transactions', getDashboardTransactions);
router.get('/feedback', getDashboardFeedback);
router.get('/reports', getDashboardReports);
router.get('/disputes', getDashboardDisputes);
router.get('/disputes/:disputeId/messages', getDashboardDisputeMessages);
router.post('/disputes/:disputeId/resolve', resolveDashboardDispute);

router.post(
  '/disputes/:disputeId/messages',
  disputeUpload.array('attachments', 5),
  createDashboardDisputeMessage,
);

module.exports = router;
