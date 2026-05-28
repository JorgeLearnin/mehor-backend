'use strict';

const stripe = require('../lib/stripe');

async function createSellerTransferForCompletedOrder({
  order,
  sellerStripeAccountId,
  amountCents,
  idempotencyKey,
}) {
  const transferAmountCents = Math.max(0, Number(amountCents || 0));

  if (order?.stripe_transfer_id) {
    return {
      transferId: order.stripe_transfer_id,
      transferredCents: transferAmountCents,
    };
  }

  if (transferAmountCents <= 0) {
    return {
      transferId: null,
      transferredCents: 0,
    };
  }

  const destination = String(sellerStripeAccountId || '').trim();

  if (!destination) {
    throw new Error('Seller Stripe account is missing.');
  }

  const transferPayload = {
    amount: transferAmountCents,
    currency: String(order.currency || 'usd').toLowerCase(),
    destination,
    metadata: {
      orderId: String(order.id),
      orderNumber: String(order.order_number || ''),
      sellerId: String(order.seller_id || ''),
      reason: 'order_completed',
    },
  };

  if (order.stripe_charge_id) {
    transferPayload.source_transaction = order.stripe_charge_id;
  }

  const transfer = await stripe.transfers.create(transferPayload, {
    idempotencyKey,
  });

  return {
    transferId: transfer.id,
    transferredCents: transferAmountCents,
  };
}

module.exports = {
  createSellerTransferForCompletedOrder,
};
