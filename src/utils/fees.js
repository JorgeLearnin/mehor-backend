'use strict';

function toIntBps(value, { min = 0, max = 10_000 } = {}) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function getSellerPlatformFeeBps() {
  // Seller platform fee (withheld from seller earnings), in basis points.
  // Default: 10%.
  return (
    toIntBps(process.env.SELLER_PLATFORM_FEE_BPS, {
      min: 0,
      max: 10_000,
    }) ?? 1000
  );
}

function getBuyerServiceFeeBps() {
  // Buyer service fee (charged to buyer), in basis points.
  // Default: 8%.
  return (
    toIntBps(process.env.BUYER_SERVICE_FEE_BPS, {
      min: 0,
      max: 10_000,
    }) ?? 800
  );
}

function getFreeFirstSaleSlotsTotal() {
  return (
    toIntBps(process.env.FREE_FIRST_SALE_PLATFORM_FEE_SLOTS, {
      min: 0,
      max: 1_000,
    }) ?? 10
  );
}

function computeFeeUsd({ amountUsd, feeBps }) {
  const amt = Math.max(0, Number(amountUsd ?? 0));
  const bps = Math.min(10_000, Math.max(0, Number(feeBps ?? 0)));
  // Round to nearest USD integer (amounts in this codebase are USD ints).
  return Math.round((amt * bps) / 10_000);
}

module.exports = {
  getSellerPlatformFeeBps,
  getBuyerServiceFeeBps,
  getFreeFirstSaleSlotsTotal,
  computeFeeUsd,
};
