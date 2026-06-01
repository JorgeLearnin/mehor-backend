const db = require('../db');
const stripe = require('../lib/stripe');

const getWebsiteOrigin = () => {
  const origin =
    process.env.WEBSITE_ORIGIN ||
    process.env.CLIENT_URL ||
    String(process.env.CLIENT_ORIGIN || '')
      .split(',')
      .map((value) => value.trim())
      .find((value) => value.startsWith('http'));

  return (origin || 'http://localhost:3000').replace(/\/+$/, '');
};

async function getSellerOnboardingStatus(req, res) {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `
      SELECT
        is_seller,
        seller_terms_accepted_at,
        stripe_account_id,
        stripe_onboarding_complete,
        stripe_charges_enabled,
        stripe_payouts_enabled,
        first_sale_free_rank,
        first_sale_free_used_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId],
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({
      isSeller: user.is_seller,
      sellerTermsAcceptedAt: user.seller_terms_accepted_at,
      stripeAccountId: user.stripe_account_id,
      stripeOnboardingComplete: user.stripe_onboarding_complete,
      stripeChargesEnabled: user.stripe_charges_enabled,
      stripePayoutsEnabled: user.stripe_payouts_enabled,
      firstSaleFreeRank: user.first_sale_free_rank,
      firstSaleFreeUsedAt: user.first_sale_free_used_at,
    });
  } catch (error) {
    console.error('Get seller onboarding status error:', error);
    return res.status(500).json({ message: 'Failed to load seller status.' });
  }
}

async function acceptSellerTerms(req, res) {
  try {
    const userId = req.user.id;

    await db.query(
      `
      UPDATE users
      SET seller_terms_accepted_at = NOW()
      WHERE id = $1
      `,
      [userId],
    );

    return res.json({ message: 'Seller terms accepted.' });
  } catch (error) {
    console.error('Accept seller terms error:', error);
    return res.status(500).json({ message: 'Failed to accept terms.' });
  }
}

async function createStripeLink(req, res) {
  try {
    const userId = req.user.id;

    // 1. Get user
    const result = await db.query(
      'SELECT email, stripe_account_id FROM users WHERE id = $1',
      [userId],
    );

    const user = result.rows[0];

    let accountId = user.stripe_account_id;

    // 2. Create Stripe account if not exists
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
      });

      accountId = account.id;

      await db.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [
        accountId,
        userId,
      ]);
    }

    // 3. Create onboarding link
    const websiteOrigin = getWebsiteOrigin();

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${websiteOrigin}/become-seller`,
      return_url: `${websiteOrigin}/become-seller`,
      type: 'account_onboarding',
    });

    return res.json({ url: accountLink.url });
  } catch (error) {
    console.error('Stripe link error:', error);
    return res.status(500).json({ message: 'Stripe onboarding failed.' });
  }
}

async function syncStripeStatus(req, res) {
  try {
    const userId = req.user.id;

    // 1. Get stripe account id
    const result = await db.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [userId],
    );

    const accountId = result.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ message: 'No Stripe account found.' });
    }

    // 2. Get account from Stripe
    const account = await stripe.accounts.retrieve(accountId);

    // 3. Extract status
    const chargesEnabled = account.charges_enabled;
    const payoutsEnabled = account.payouts_enabled;

    const onboardingComplete =
      chargesEnabled === true && payoutsEnabled === true;

    // 4. Update DB
    await db.query(
      `
      UPDATE users
      SET
        stripe_onboarding_complete = $1,
        stripe_charges_enabled = $2,
        stripe_payouts_enabled = $3
      WHERE id = $4
      `,
      [onboardingComplete, chargesEnabled, payoutsEnabled, userId],
    );

    return res.json({
      message: 'Stripe status synced.',
      chargesEnabled,
      payoutsEnabled,
      onboardingComplete,
    });
  } catch (error) {
    console.error('Stripe sync error:', error);
    return res.status(500).json({ message: 'Stripe sync failed.' });
  }
}

async function activateSellerAccount(req, res) {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `
      SELECT
        is_seller,
        seller_terms_accepted_at,
        stripe_onboarding_complete,
        stripe_payouts_enabled,
        first_sale_free_rank,
        first_sale_free_used_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId],
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.is_seller) {
      return res.json({
        message: 'Seller account is already active.',
        isSeller: true,
        firstSaleFreeRank: user.first_sale_free_rank ?? null,
        firstSaleFreeUsedAt: user.first_sale_free_used_at ?? null,
      });
    }

    if (!user.seller_terms_accepted_at) {
      return res.status(400).json({
        message: 'Seller terms must be accepted before activation.',
      });
    }

    if (
      user.stripe_onboarding_complete !== true ||
      user.stripe_payouts_enabled !== true
    ) {
      return res.status(400).json({
        message: 'Stripe onboarding must be complete before activation.',
      });
    }

    const activatedResult = await db.query(
      `
      UPDATE users
      SET
        is_seller = true,
        role = 'seller',
        updated_at = NOW()
      WHERE id = $1
      RETURNING first_sale_free_rank, first_sale_free_used_at
      `,
      [userId],
    );

    const activatedUser = activatedResult.rows[0];

    return res.json({
      message: 'Seller account activated.',
      isSeller: true,
      firstSaleFreeRank: activatedUser?.first_sale_free_rank ?? null,
      firstSaleFreeUsedAt: activatedUser?.first_sale_free_used_at ?? null,
    });
  } catch (error) {
    console.error('Activate seller account error:', error);
    return res
      .status(500)
      .json({ message: 'Failed to activate seller account.' });
  }
}

module.exports = {
  getSellerOnboardingStatus,
  acceptSellerTerms,
  createStripeLink,
  syncStripeStatus,
  activateSellerAccount,
};
