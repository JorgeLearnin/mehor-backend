'use strict';

const { Resend } = require('resend');

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getWebBaseUrl() {
  const raw = (process.env.WEB_BASE_URL || '').trim();
  if (raw) return raw.replace(/\/$/, '');

  const allowed = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length > 0) return allowed[0].replace(/\/$/, '');

  return 'http://localhost:3000';
}

async function sendPasswordResetEmail(toEmail, token) {
  const baseUrl = getWebBaseUrl();
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;

  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.RESEND_FROM_EMAIL || '').trim();

  if (!apiKey || !from) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'RESEND_API_KEY and RESEND_FROM_EMAIL are required in production',
      );
    }

    // Dev fallback: log the link so you can test without email.
    // eslint-disable-next-line no-console
    console.log('[forgot-password] Reset link:', resetUrl);
    return;
  }

  const resend = new Resend(apiKey);

  const subject = 'Reset your password';
  const html = `
    <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height:1.5">
      <h2 style="margin:0 0 12px">Reset your password</h2>
      <p style="margin:0 0 12px">You requested a password reset. This link expires in 2 minutes.</p>
      <p style="margin:0 0 16px"><a href="${resetUrl}">Reset password</a></p>
      <p style="margin:0;color:#666">If you didn’t request this, you can ignore this email.</p>
    </div>
  `;

  await resend.emails.send({
    from,
    to: toEmail,
    subject,
    html,
  });
}

async function sendContactEmail({
  toEmail,
  fromEmail,
  fromName,
  subject,
  topic,
  orderId,
  listing,
  message,
  meta,
}) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const from = (process.env.RESEND_FROM_EMAIL || '').trim();
  const inbox = (toEmail || process.env.SUPPORT_INBOX_EMAIL || '').trim();

  if (!apiKey || !from || !inbox) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'RESEND_API_KEY, RESEND_FROM_EMAIL, and a support inbox email are required in production',
      );
    }

    // Dev fallback: log payload so you can test without email.
    // eslint-disable-next-line no-console
    console.log('[contact] Message (dev fallback):', {
      inbox,
      fromEmail,
      fromName,
      subject,
      topic,
      orderId,
      listing,
      message,
      meta,
    });
    return;
  }

  const resend = new Resend(apiKey);

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height:1.5">
      <h2 style="margin:0 0 12px">New contact message</h2>
      <p style="margin:0 0 12px"><strong>From:</strong> ${escapeHtml(fromName)} (${escapeHtml(fromEmail)})</p>
      <p style="margin:0 0 12px"><strong>Topic:</strong> ${escapeHtml(topic)}</p>
      ${orderId ? `<p style="margin:0 0 12px"><strong>Order ID:</strong> ${escapeHtml(orderId)}</p>` : ''}
      ${listing ? `<p style="margin:0 0 12px"><strong>Listing:</strong> ${escapeHtml(listing)}</p>` : ''}
      <div style="margin:0 0 12px"><strong>Message:</strong></div>
      <div style="white-space:pre-wrap; border:1px solid #eee; padding:12px; border-radius:12px">${escapeHtml(
        message,
      )}</div>
      <hr style="margin:16px 0; border:none; border-top:1px solid #eee" />
      <div style="font-size:12px; color:#666">
        <div><strong>IP:</strong> ${escapeHtml(meta?.ip || '')}</div>
        <div><strong>User-Agent:</strong> ${escapeHtml(meta?.userAgent || '')}</div>
        <div><strong>Received:</strong> ${escapeHtml(meta?.receivedAt || '')}</div>
      </div>
    </div>
  `;

  await resend.emails.send({
    from,
    to: inbox,
    subject,
    html,
    replyTo: fromEmail,
  });
}

module.exports = { sendPasswordResetEmail, sendContactEmail };
