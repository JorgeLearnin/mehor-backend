const { sendContactSupportEmail } = require('../utils/email');

const TOPIC_LABELS = {
  order: 'Order / delivery issue',
  listing: 'Listing question',
  account: 'Account access',
  policy: 'Report a policy issue',
  other: 'Other',
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const postContactMessage = async (req, res) => {
  const topic =
    typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email =
    typeof req.body?.email === 'string'
      ? req.body.email.trim().toLowerCase()
      : '';
  const orderId =
    typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
  const listing =
    typeof req.body?.listing === 'string' ? req.body.listing.trim() : '';
  const message =
    typeof req.body?.message === 'string' ? req.body.message.trim() : '';

  if (!TOPIC_LABELS[topic]) {
    return res
      .status(400)
      .json({ error: 'Please choose a valid support topic.' });
  }

  if (!name || name.length > 80) {
    return res
      .status(400)
      .json({ error: 'Name is required and must be 1 to 80 characters.' });
  }

  if (!email || email.length > 160 || !EMAIL_REGEX.test(email)) {
    return res
      .status(400)
      .json({ error: 'Please provide a valid email address.' });
  }

  if (orderId && (!/^\d+$/.test(orderId) || orderId.length > 8)) {
    return res
      .status(400)
      .json({
        error: 'Order ID must contain only digits and be at most 8 characters.',
      });
  }

  if (listing.length > 300) {
    return res
      .status(400)
      .json({ error: 'Listing must be 300 characters or fewer.' });
  }

  if (!message || message.length < 20 || message.length > 3000) {
    return res
      .status(400)
      .json({ error: 'Message must be between 20 and 3000 characters.' });
  }

  try {
    await sendContactSupportEmail({
      topic,
      topicLabel: TOPIC_LABELS[topic],
      name,
      email,
      orderId,
      listing,
      message,
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error('Contact support email error:', error);
    return res.status(500).json({ error: 'Could not send message.' });
  }
};

module.exports = { postContactMessage };
