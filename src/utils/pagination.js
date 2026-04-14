'use strict';

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function getPaginationParams(query, { defaultLimit = 10, maxLimit = 50 } = {}) {
  const page = Math.max(1, toInt(query?.page, 1));
  const limit = Math.max(
    1,
    Math.min(maxLimit, toInt(query?.limit, defaultLimit)),
  );
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

module.exports = {
  getPaginationParams,
  escapeLike,
};
