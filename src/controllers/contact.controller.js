'use strict';

const { sendContactEmail } = require('../utils/email');

const TOPIC_KEYS = new Set(['order', 'listing', 'account', 'policy', 'other']);

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function clampString(value, maxLen) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function submitContact(req, res) {
  const body = req.body || {};

  const topic = String(body.topic || '').trim();
  const name = clampString(body.name, 80);
  const email = String(body.email || '').trim();
  const message = clampString(body.message, 2000);

  const orderId = clampString(digitsOnly(body.orderId), 8);
  const listing = clampString(body.listing, 220);

  if (!TOPIC_KEYS.has(topic)) {
    return res.status(400).json({ error: 'Invalid topic.' });
  }

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  if (!message || message.length < 20) {
    return res
      .status(400)
      .json({ error: 'Message must be at least 20 characters.' });
  }

  const topicLabelMap = {
    order: 'Order / delivery issue',
    listing: 'Listing question',
    account: 'Account access',
    policy: 'Report a policy issue',
    other: 'Other',
  };

  const topicLabel = topicLabelMap[topic] || topic;
  const subjectParts = [`Mehor contact: ${topicLabel}`];
  if (orderId) subjectParts.push(`Order ${orderId}`);
  const subject = subjectParts.join(' — ');

  const meta = {
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
    receivedAt: new Date().toISOString(),
  };

  await sendContactEmail({
    toEmail: process.env.SUPPORT_INBOX_EMAIL || 'support@mehor.com',
    fromEmail: email,
    fromName: name,
    subject,
    topic: topicLabel,
    orderId: orderId || undefined,
    listing: listing || undefined,
    message,
    meta,
  });

  return res.status(200).json({ ok: true });
}

module.exports = { submitContact };
