'use strict';

const Stripe = require('stripe');

const { db } = require('../db/db');
const { safeJsonParse, toInt, computeOrderTotals } = require('../utils/order');
const { finalizePaidOrderFromPaymentIntent } = require('./orders.controller');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

function getWebsiteOrigin() {
  const origin = String(process.env.WEBSITE_ORIGIN || '').trim();
  if (!origin) throw new Error('WEBSITE_ORIGIN is not set');
  return origin.replace(/\/$/, '');
}

function toCentsUsd(amountUsd) {
  const n = Number.parseInt(String(amountUsd ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * 100;
}

function minutesFromNowIso(minutes) {
  const ms = Number(minutes ?? 0) * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function getAuthedUserId(req) {
  const userId = String(req.user?.id ?? '').trim();
  return userId;
}

function serializeSelectedAddOns(selectedAddOns) {
  return JSON.stringify(Array.isArray(selectedAddOns) ? selectedAddOns : []);
}

function isReusablePaymentIntentStatus(status) {
  const value = String(status ?? '')
    .trim()
    .toLowerCase();
  return (
    value === 'requires_payment_method' ||
    value === 'requires_confirmation' ||
    value === 'requires_action' ||
    value === 'processing' ||
    value === 'requires_capture'
  );
}

async function closeCheckoutIntent({
  stripe,
  checkoutIntentId,
  paymentIntentId,
  now,
}) {
  const checkoutId = String(checkoutIntentId ?? '').trim();
  if (!checkoutId) return;

  db.prepare(
    `UPDATE checkout_intents
        SET status = 'closed', updated_at = ?
      WHERE id = ? AND status = 'open'`,
  ).run(now, checkoutId);

  const stripePaymentIntentId = String(paymentIntentId ?? '').trim();
  if (!stripePaymentIntentId) return;

  try {
    const pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    const status = String(pi?.status ?? '')
      .trim()
      .toLowerCase();
    if (
      status === 'requires_payment_method' ||
      status === 'requires_confirmation' ||
      status === 'requires_action' ||
      status === 'requires_capture' ||
      status === 'processing'
    ) {
      await stripe.paymentIntents.cancel(stripePaymentIntentId);
    }
  } catch {
    // Best-effort cleanup only.
  }
}

async function getOrCreateStripeCustomerId({ stripe, userId }) {
  const user = db
    .prepare(
      `SELECT id, email, stripe_customer_id AS stripeCustomerId
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId);

  if (!user) throw new Error('Not authenticated');

  let stripeCustomerId = String(user.stripeCustomerId ?? '').trim();
  if (stripeCustomerId) return stripeCustomerId;
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    metadata: { userId },
  });

  stripeCustomerId = customer.id;
  db.prepare(`UPDATE users SET stripe_customer_id = ? WHERE id = ?`).run(
    stripeCustomerId,
    userId,
  );
  return stripeCustomerId;
}

async function createPaymentIntent(req, res) {
  const stripe = getStripe();

  const buyerId = String(req.user?.id ?? '').trim();
  if (!buyerId) return res.status(401).json({ error: 'Not authenticated' });

  const listingId = String(req.body?.listingId ?? '').trim();
  if (!listingId)
    return res.status(400).json({ error: 'listingId is required' });

  const selectedAddOns = Array.isArray(req.body?.selectedAddOns)
    ? req.body.selectedAddOns
    : [];

  const listing = db
    .prepare(
      `SELECT id,
              seller_id AS sellerId,
              status,
              title,
              price_usd AS priceUsd,
              add_ons_json AS addOnsJson
         FROM listings
        WHERE id = ?
          AND status = 'active'
        LIMIT 1`,
    )
    .get(listingId);

  if (!listing) return res.status(404).json({ error: 'Listing not found' });
  if (String(listing.sellerId) === buyerId)
    return res.status(400).json({ error: 'You cannot buy your own listing' });

  const listingPriceUsd = toInt(listing.priceUsd, { min: 1, max: 1_000_000 });
  if (!listingPriceUsd)
    return res.status(400).json({ error: 'Listing price is invalid' });

  const addOnsJson = safeJsonParse(listing.addOnsJson, {
    addOns: [],
    addOnPrices: {},
  });

  const totals = computeOrderTotals({
    listingPriceUsd,
    selectedAddOnIds: selectedAddOns,
    addOnsJson,
  });

  const now = new Date().toISOString();
  const expiresAt = minutesFromNowIso(20);
  const selectedAddOnsJson = serializeSelectedAddOns(totals.selectedAddOns);

  // Clean up expired open locks for this listing.
  db.prepare(
    `DELETE FROM checkout_intents
      WHERE listing_id = ?
        AND status = 'open'
        AND expires_at < ?`,
  ).run(listingId, now);

  const existingOpen = db
    .prepare(
      `SELECT id,
              buyer_id AS buyerId,
              stripe_payment_intent_id AS stripePaymentIntentId,
              selected_add_ons_json AS selectedAddOnsJson,
              listing_price_usd AS listingPriceUsd,
              add_ons_total_usd AS addOnsTotalUsd,
              platform_fee_usd AS platformFeeUsd,
              seller_platform_fee_bps AS sellerPlatformFeeBps,
              buyer_service_fee_bps AS buyerServiceFeeBps,
              total_usd AS totalUsd
         FROM checkout_intents
        WHERE listing_id = ?
          AND status = 'open'
        LIMIT 1`,
    )
    .get(listingId);

  if (existingOpen?.id) {
    const existingBuyerId = String(existingOpen.buyerId ?? '').trim();
    if (existingBuyerId && existingBuyerId !== buyerId) {
      return res
        .status(409)
        .json({ error: 'This listing is currently being purchased' });
    }

    const sameSnapshot =
      String(existingOpen.selectedAddOnsJson ?? '') === selectedAddOnsJson &&
      Number(existingOpen.listingPriceUsd ?? 0) === listingPriceUsd &&
      Number(existingOpen.addOnsTotalUsd ?? 0) === totals.addOnsTotalUsd &&
      Number(existingOpen.platformFeeUsd ?? 0) === totals.platformFeeUsd &&
      Number(existingOpen.sellerPlatformFeeBps ?? 0) ===
        totals.sellerPlatformFeeBps &&
      Number(existingOpen.buyerServiceFeeBps ?? 0) ===
        totals.buyerServiceFeeBps &&
      Number(existingOpen.totalUsd ?? 0) === totals.totalUsd;

    const existingPaymentIntentId = String(
      existingOpen.stripePaymentIntentId ?? '',
    ).trim();

    if (sameSnapshot && existingPaymentIntentId) {
      try {
        const existingPaymentIntent = await stripe.paymentIntents.retrieve(
          existingPaymentIntentId,
        );
        const status = String(existingPaymentIntent?.status ?? '')
          .trim()
          .toLowerCase();

        if (status === 'succeeded') {
          return res.status(409).json({
            error: 'Payment already completed. Please refresh your order.',
          });
        }

        if (
          isReusablePaymentIntentStatus(status) &&
          existingPaymentIntent?.client_secret
        ) {
          db.prepare(
            `UPDATE checkout_intents
                SET expires_at = ?, updated_at = ?
              WHERE id = ?`,
          ).run(expiresAt, now, String(existingOpen.id));

          return res.json({
            checkout: { id: String(existingOpen.id), expiresAt },
            paymentIntent: {
              id: existingPaymentIntent.id,
              clientSecret: existingPaymentIntent.client_secret,
            },
          });
        }
      } catch {
        // Fall through to close and recreate below.
      }
    }

    await closeCheckoutIntent({
      stripe,
      checkoutIntentId: existingOpen.id,
      paymentIntentId: existingPaymentIntentId,
      now,
    });
  }

  const id = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : require('crypto').randomUUID();

  try {
    db.prepare(
      `INSERT INTO checkout_intents (
        id,
        stripe_payment_intent_id,
        listing_id,
        buyer_id,
        status,
        selected_add_ons_json,
        listing_price_usd,
        add_ons_total_usd,
        platform_fee_usd,
        seller_platform_fee_bps,
        buyer_service_fee_bps,
        total_usd,
        created_at,
        expires_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      null,
      listingId,
      buyerId,
      'open',
      selectedAddOnsJson,
      listingPriceUsd,
      totals.addOnsTotalUsd,
      totals.platformFeeUsd,
      totals.sellerPlatformFeeBps,
      totals.buyerServiceFeeBps,
      totals.totalUsd,
      now,
      expiresAt,
      now,
    );
  } catch (e) {
    const msg = String(e?.message ?? '');
    if (msg.includes('idx_checkout_intents_listing_open_unique')) {
      return res
        .status(409)
        .json({ error: 'This listing is currently being purchased' });
    }
    throw e;
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: toCentsUsd(totals.totalUsd),
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        checkoutIntentId: id,
        listingId,
        buyerId,
      },
      description: listing.title
        ? `Mehor: ${String(listing.title).slice(0, 60)}`
        : 'Mehor order',
    });
  } catch (e) {
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'closed', updated_at = ?
        WHERE id = ?`,
    ).run(now, id);
    throw e;
  }

  db.prepare(
    `UPDATE checkout_intents
        SET stripe_payment_intent_id = ?, updated_at = ?
      WHERE id = ?`,
  ).run(paymentIntent.id, now, id);

  return res.json({
    checkout: { id, expiresAt },
    paymentIntent: {
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
    },
  });
}

async function createSellerOnboardingLink(req, res) {
  const stripe = getStripe();
  const websiteOrigin = getWebsiteOrigin();

  const userId = req.user.id;

  const user = db
    .prepare(
      `SELECT id, email, stripe_account_id AS stripeAccountId
         FROM users
        WHERE id = ?
        LIMIT 1`,
    )
    .get(userId);

  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  let stripeAccountId = user.stripeAccountId;
  if (!stripeAccountId) {
    const acct = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email || undefined,
      business_type: 'individual',
      metadata: {
        userId,
      },
    });

    stripeAccountId = acct.id;
    db.prepare(`UPDATE users SET stripe_account_id = ? WHERE id = ?`).run(
      stripeAccountId,
      userId,
    );
  }

  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    type: 'account_onboarding',
    refresh_url: `${websiteOrigin}/my-profile?stripe=refresh`,
    return_url: `${websiteOrigin}/my-profile?stripe=return`,
  });

  return res.json({
    onboarding: {
      url: link.url,
    },
  });
}

async function createPaymentMethodSetupIntent(req, res) {
  const stripe = getStripe();

  const userId = getAuthedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const customerId = await getOrCreateStripeCustomerId({ stripe, userId });

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { userId },
  });

  return res.json({
    setupIntent: {
      id: setupIntent.id,
      clientSecret: setupIntent.client_secret,
    },
  });
}

async function listPaymentMethods(req, res) {
  const stripe = getStripe();

  const userId = getAuthedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const customerId = await getOrCreateStripeCustomerId({ stripe, userId });

  const list = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  });

  const methods = (list.data || []).map((pm) => ({
    id: pm.id,
    brand: pm.card?.brand || null,
    last4: pm.card?.last4 || null,
    expMonth: pm.card?.exp_month || null,
    expYear: pm.card?.exp_year || null,
  }));

  return res.json({ methods });
}

async function getDefaultPaymentMethod(req, res) {
  const stripe = getStripe();

  const userId = getAuthedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const customerId = await getOrCreateStripeCustomerId({ stripe, userId });

  const customer = await stripe.customers.retrieve(customerId, {
    expand: ['invoice_settings.default_payment_method'],
  });

  const raw = customer?.invoice_settings?.default_payment_method;
  if (!raw || typeof raw === 'string') {
    return res.json({ method: null });
  }

  const pm = raw;
  return res.json({
    method: {
      id: pm.id,
      brand: pm.card?.brand || null,
      last4: pm.card?.last4 || null,
      expMonth: pm.card?.exp_month || null,
      expYear: pm.card?.exp_year || null,
    },
  });
}

async function setDefaultPaymentMethod(req, res) {
  const stripe = getStripe();

  const userId = getAuthedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const paymentMethodId = String(req.body?.paymentMethodId ?? '').trim();
  if (!paymentMethodId)
    return res.status(400).json({ error: 'paymentMethodId is required' });

  const customerId = await getOrCreateStripeCustomerId({ stripe, userId });

  // Best-effort attach (SetupIntent usually attaches automatically).
  try {
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
  } catch {
    // ignore
  }

  // Verify ownership before setting as default.
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (String(pm?.customer ?? '') !== customerId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  return res.json({ ok: true });
}

async function detachPaymentMethod(req, res) {
  const stripe = getStripe();

  const userId = getAuthedUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const paymentMethodId = String(req.body?.paymentMethodId ?? '').trim();
  if (!paymentMethodId)
    return res.status(400).json({ error: 'paymentMethodId is required' });

  const customerId = await getOrCreateStripeCustomerId({ stripe, userId });

  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (String(pm?.customer ?? '') !== customerId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await stripe.paymentMethods.detach(paymentMethodId);
  return res.json({ ok: true });
}

async function stripeWebhook(req, res) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Webhook not configured' });

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const paymentIntentId = String(pi?.id ?? '').trim();
      if (paymentIntentId) {
        try {
          await finalizePaidOrderFromPaymentIntent({
            paymentIntentId,
          });
        } catch {
          // Best-effort: webhook should be idempotent; ignore failures.
        }
      }
    }

    return res.json({ received: true });
  } catch (e) {
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}

module.exports = {
  createPaymentIntent,
  createSellerOnboardingLink,
  createPaymentMethodSetupIntent,
  listPaymentMethods,
  getDefaultPaymentMethod,
  setDefaultPaymentMethod,
  detachPaymentMethod,
  stripeWebhook,
};
