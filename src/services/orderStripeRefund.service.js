'use strict';

const stripe = require('../lib/stripe');
const { roundUpToWholeDollarCents } = require('./orderPricing.service');

function getOrderItemTotalCents(order) {
  return (
    Number(order?.base_price_cents || 0) +
    Number(order?.addons_total_cents || 0)
  );
}

function getRemainingItemRefundableCents(order) {
  return Math.max(
    0,
    getOrderItemTotalCents(order) - Number(order?.item_refunded_cents || 0),
  );
}

function getSellerPayoutAfterRefund({ order, itemRefundedCents }) {
  const itemTotalCents = getOrderItemTotalCents(order);
  const sellerFeeCents = Number(order?.seller_fee_cents || 0);

  return Math.max(0, itemTotalCents - itemRefundedCents - sellerFeeCents);
}

async function createStripeItemRefundIfNeeded({
  order,
  amountCents,
  reason,
  idempotencyKey,
}) {
  const refundAmountCents = Math.min(
    getRemainingItemRefundableCents(order),
    roundUpToWholeDollarCents(amountCents),
  );

  let refundId = null;
  let refundedCents = 0;

  if (refundAmountCents > 0) {
    if (!order.stripe_payment_intent_id || order.payment_status !== 'paid') {
      throw new Error('Order is not paid or is missing Stripe payment data.');
    }

    const refund = await stripe.refunds.create(
      {
        payment_intent: order.stripe_payment_intent_id,
        amount: refundAmountCents,
        reason: 'requested_by_customer',
        metadata: {
          orderId: String(order.id),
          orderNumber: String(order.order_number || ''),
          reason,
          feesRefundable: 'false',
        },
      },
      {
        idempotencyKey,
      },
    );

    refundId = refund.id;
    refundedCents = refundAmountCents;
  }

  return {
    refundId,
    refundedCents,
  };
}

module.exports = {
  createStripeItemRefundIfNeeded,
  getOrderItemTotalCents,
  getRemainingItemRefundableCents,
  getSellerPayoutAfterRefund,
};