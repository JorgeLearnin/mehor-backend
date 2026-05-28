const { Pool } = require('pg');

const { DATABASE_URL, DATABASE_SSL } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

module.exports = pool;