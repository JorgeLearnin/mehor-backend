'use strict';

function addHours(date, hours) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function addDays(date, days) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function createOrderEvent(
  client,
  { orderId, orderPartId = null, actorId = null, type, title, body = null, metadata = {} },
) {
  const safeMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata
      : {};

  const result = await client.query(
    `
    INSERT INTO order_events (
      order_id,
      order_part_id,
      actor_id,
      type,
      title,
      body,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      orderId,
      orderPartId,
      actorId,
      type,
      title,
      body,
      safeMetadata,
    ],
  );

  return result.rows[0];
}

function getMainSellerDeliveryDueAt({ startsAt }) {
  return addHours(startsAt, 48);
}

function getAddonSellerDeliveryDueAt({ startsAt, selectedAddons }) {
  const addons = Array.isArray(selectedAddons) ? selectedAddons : [];

  const totalDays = addons.reduce((sum, addon) => {
    const rawDays =
      addon && typeof addon === 'object' ? addon.delivery_days : 0;

    const days = Number(rawDays);
    if (!Number.isFinite(days) || days <= 0) return sum;

    return sum + Math.trunc(days);
  }, 0);

  return addDays(startsAt, totalDays);
}

function getBuyerReviewDueAt({ deliveredAt }) {
  return addHours(deliveredAt, 48);
}

module.exports = {
  addHours,
  addDays,
  createOrderEvent,
  getMainSellerDeliveryDueAt,
  getAddonSellerDeliveryDueAt,
  getBuyerReviewDueAt,
};