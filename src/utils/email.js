const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const getResendFromEmail = () => {
  if (!process.env.RESEND_FROM_EMAIL) {
    throw new Error('RESEND_FROM_EMAIL is missing.');
  }

  return process.env.RESEND_FROM_EMAIL;
};

const getResendNoReplyEmail = () => {
  if (!process.env.RESEND_NO_REPLY_EMAIL) {
    return getResendFromEmail();
  }

  return process.env.RESEND_NO_REPLY_EMAIL;
};

const sendPasswordResetEmail = async ({ to, resetUrl }) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing.');
  }

  return resend.emails.send({
    from: getResendNoReplyEmail(),
    to,
    subject: 'Reset your Mehor password',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <h2>Reset your password</h2>
        <p>We received a request to reset your Mehor password.</p>
        <p>
          <a href="${resetUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:10px;">
            Reset password
          </a>
        </p>
        <p>This link expires in 60 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });
};

const sendContactSupportEmail = async ({
  topic,
  topicLabel,
  name,
  email,
  orderId,
  listing,
  message,
}) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing.');
  }

  const supportEmail = process.env.SUPPORT_EMAIL || 'support@mehor.com';
  const subject = `Mehor support: ${topicLabel}${orderId ? ` — Order ${orderId}` : ''}`;
  const trimmedListing = listing ? listing.trim() : '';
  const trimmedOrderId = orderId ? orderId.trim() : '';

  const textLines = [
    'New support message received via the Mehor contact form.',
    '',
    `Topic key: ${topic}`,
    `Topic label: ${topicLabel}`,
    `Name: ${name}`,
    `Reply-to email: ${email}`,
    trimmedOrderId ? `Order ID: ${trimmedOrderId}` : null,
    trimmedListing ? `Listing: ${trimmedListing}` : null,
    '',
    'Message:',
    message,
  ].filter(Boolean);

  const htmlSections = [
    '<div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">',
    '<h2>New support message</h2>',
    '<p>A new support message was submitted through the Mehor contact form.</p>',
    '<table style="border-collapse: collapse; width: 100%; max-width: 720px;">',
    `<tr><td style="padding: 6px 12px 6px 0; font-weight: 700; vertical-align: top;">Topic key</td><td style="padding: 6px 0;">${escapeHtml(topic)}</td></tr>`,
    `<tr><td style="padding: 6px 12px 6px 0; font-weight: 700; vertical-align: top;">Topic</td><td style="padding: 6px 0;">${escapeHtml(topicLabel)}</td></tr>`,
    `<tr><td style="padding: 6px 12px 6px 0; font-weight: 700; vertical-align: top;">Name</td><td style="padding: 6px 0;">${escapeHtml(name)}</td></tr>`,
    `<tr><td style="padding: 6px 12px 6px 0; font-weight: 700; vertical-align: top;">Reply-to email</td><td style="padding: 6px 0;">${escapeHtml(email)}</td></tr>`,
    trimmedOrderId
      ? `<tr><td style="padding: 6px 12px 6px 0; font-weight: 700; vertical-align: top;">Order ID</td><td style="padding: 6px 0;">${escapeHtml(trimmedOrderId)}</td></tr>`
      : '',
    trimmedListing
      ? `<tr><td style="padding: 6px 12px 6px 0; font-weight: 700; vertical-align: top;">Listing</td><td style="padding: 6px 0;">${escapeHtml(trimmedListing)}</td></tr>`
      : '',
    '</table>',
    '<h3 style="margin-top: 24px;">Message</h3>',
    `<div style="white-space: pre-wrap; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; background: #fafafa;">${escapeHtml(message)}</div>`,
    '</div>',
  ].filter(Boolean);

  return resend.emails.send({
    from: getResendFromEmail(),
    to: supportEmail,
    replyTo: email,
    subject,
    text: textLines.join('\n'),
    html: htmlSections.join(''),
  });
};

const getPublicAppOrigin = () => {
  const explicit =
    process.env.WEBSITE_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_ORIGIN;

  if (explicit) return explicit.replace(/\/*$/, '');

  const clientOrigin = String(process.env.CLIENT_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .find((value) => value.startsWith('http'));

  if (clientOrigin) return clientOrigin.replace(/\/*$/, '');

  return '';
};

const getAbsoluteActionUrl = (actionUrl) => {
  const value = String(actionUrl ?? '').trim();
  if (!value) return '';

  if (/^https?:\/\//i.test(value)) return value;

  const origin = getPublicAppOrigin();
  if (!origin) return value;

  return `${origin}${value.startsWith('/') ? value : `/${value}`}`;
};

const sendTransactionalEmail = async ({
  to,
  subject,
  preview,
  title,
  body,
  actionUrl,
  actionLabel = 'Open Mehor',
}) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is missing.');
  }

  const absoluteActionUrl = getAbsoluteActionUrl(actionUrl);
  const safePreview = preview ? escapeHtml(preview) : '';
  const safeTitle = escapeHtml(title || subject);
  const safeBody = escapeHtml(body || '').replace(/\n/g, '<br />');
  const safeActionUrl = absoluteActionUrl ? escapeHtml(absoluteActionUrl) : '';
  const safeActionLabel = escapeHtml(actionLabel);

  return resend.emails.send({
    from: getResendNoReplyEmail(),
    to,
    subject,
    text: [title || subject, '', body || '', '', absoluteActionUrl || '']
      .filter(Boolean)
      .join('\n'),
    html: `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${safePreview}
      </div>
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
        <h2>${safeTitle}</h2>
        <p>${safeBody}</p>
        ${
          safeActionUrl
            ? `<p>
                <a href="${safeActionUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:10px;">
                  ${safeActionLabel}
                </a>
              </p>`
            : ''
        }
        <p style="color:#666;font-size:13px;">Mehor</p>
      </div>
    `,
  });
};

module.exports = {
  sendPasswordResetEmail,
  sendContactSupportEmail,
  sendTransactionalEmail,
};
