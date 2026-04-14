'use strict';

const {
  getBuyerServiceFeeBps,
  getSellerPlatformFeeBps,
} = require('../utils/fees');

function getPublicFees(req, res) {
  return res.json({
    buyerServiceFeeBps: getBuyerServiceFeeBps(),
    sellerPlatformFeeBps: getSellerPlatformFeeBps(),
  });
}

module.exports = {
  getPublicFees,
};
