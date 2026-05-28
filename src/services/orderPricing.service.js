'use strict';

function toSafeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.trunc(num);
}

function roundUpToWholeDollarCents(value) {
  const cents = Math.max(0, toSafeInt(value));
  if (cents <= 0) return 0;
  return Math.round(cents / 100) * 100;
}

function calculatePercentFeeCents(amountCents, rate) {
  return roundUpToWholeDollarCents(amountCents * rate);
}

function calculateOrderPricing({
  basePriceCents,
  addons,
  sellerFeeWaived = false,
}) {
  const base = roundUpToWholeDollarCents(basePriceCents);
  const safeAddons = Array.isArray(addons) ? addons : [];

  const addonsTotalCents = roundUpToWholeDollarCents(
    safeAddons.reduce((sum, addon) => {
      const priceCents =
        addon && typeof addon === 'object' ? addon.price_cents : 0;
      return sum + Math.max(0, toSafeInt(priceCents));
    }, 0),
  );

  const itemSubtotalCents = base + addonsTotalCents;

  const buyerFeeCents = calculatePercentFeeCents(itemSubtotalCents, 0.08);
  const standardSellerFeeCents = calculatePercentFeeCents(
    itemSubtotalCents,
    0.1,
  );
  const sellerFeeCents = sellerFeeWaived ? 0 : standardSellerFeeCents;

  const totalPaidCents = itemSubtotalCents + buyerFeeCents;
  const sellerPayoutCents = itemSubtotalCents - sellerFeeCents;

  return {
    base_price_cents: base,
    addons_total_cents: addonsTotalCents,
    buyer_fee_cents: buyerFeeCents,
    seller_fee_cents: sellerFeeCents,
    standard_seller_fee_cents: standardSellerFeeCents,
    seller_fee_waived: sellerFeeWaived,
    seller_fee_waived_reason: sellerFeeWaived ? 'first_sale_free' : null,
    total_paid_cents: totalPaidCents,
    seller_payout_cents: sellerPayoutCents,
    currency: 'usd',
    fees_refundable: false,
  };
}

module.exports = {
  calculateOrderPricing,
  roundUpToWholeDollarCents,
};
