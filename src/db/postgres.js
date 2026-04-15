'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');

const FREE_FIRST_SALE_SLOTS_TOTAL = 10;
const txStorage = new AsyncLocalStorage();
let initPromise = null;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getSslConfig() {
  const raw = String(process.env.DATABASE_SSL || 'true')
    .trim()
    .toLowerCase();

  if (raw === 'false' || raw === 'disable' || raw === 'off') {
    return undefined;
  }

  return { rejectUnauthorized: false };
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  );
}

function replacePlaceholders(sql, replacer) {
  let out = '';
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (index < sql.length) {
    const char = sql[index];

    if (inSingleQuote) {
      out += char;
      if (char === "'" && sql[index + 1] === "'") {
        out += sql[index + 1];
        index += 2;
        continue;
      }
      if (char === "'") {
        inSingleQuote = false;
      }
      index += 1;
      continue;
    }

    if (inDoubleQuote) {
      out += char;
      if (char === '"') {
        inDoubleQuote = false;
      }
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      out += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      out += char;
      index += 1;
      continue;
    }

    const replacement = replacer(sql, index);
    if (replacement) {
      out += replacement.text;
      index += replacement.length;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function normalizeInsertOrIgnore(sql) {
  if (!/^\s*INSERT\s+OR\s+IGNORE\b/i.test(sql)) {
    return sql;
  }

  const rewritten = sql.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT');
  if (/\bON\s+CONFLICT\b/i.test(rewritten)) {
    return rewritten;
  }

  return rewritten.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
}

function normalizeNullSafeIs(sql) {
  return sql.replace(/\bIS\s+(\$\d+)/gi, 'IS NOT DISTINCT FROM $1');
}

function compilePreparedQuery(sql, args) {
  const normalizedSql = normalizeInsertOrIgnore(String(sql || ''));

  if (args.length === 1 && isPlainObject(args[0])) {
    const input = args[0];
    const values = [];
    const indexes = new Map();

    const text = replacePlaceholders(normalizedSql, (source, index) => {
      if (source[index] !== '@') return null;

      const rest = source.slice(index + 1);
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (!match) return null;

      const key = match[0];
      if (!Object.prototype.hasOwnProperty.call(input, key)) {
        throw new Error(`Missing named SQL parameter: @${key}`);
      }

      if (!indexes.has(key)) {
        indexes.set(key, values.length + 1);
        values.push(input[key]);
      }

      return {
        text: `$${indexes.get(key)}`,
        length: key.length + 1,
      };
    });

    return {
      text: normalizeNullSafeIs(text),
      values,
    };
  }

  const values = Array.isArray(args) ? args : [];
  let nextIndex = 1;
  const text = replacePlaceholders(normalizedSql, (source, index) => {
    if (source[index] !== '?') return null;
    return { text: `$${nextIndex++}`, length: 1 };
  });

  return {
    text: normalizeNullSafeIs(text),
    values,
  };
}

const connectionString = String(process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  throw new Error('DATABASE_URL must be set when using PostgreSQL');
}

const pool = new Pool({
  connectionString,
  ssl: getSslConfig(),
  max: toPositiveInt(process.env.PGPOOL_MAX, 10),
  idleTimeoutMillis: toPositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
});

pool.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error('PostgreSQL pool error:', error);
});

function getExecutor() {
  return txStorage.getStore()?.client ?? pool;
}

async function query(text, values = []) {
  return getExecutor().query(text, values);
}

async function exec(statement) {
  return query(String(statement || ''));
}

const db = {
  prepare(sql) {
    return {
      async get(...args) {
        const compiled = compilePreparedQuery(sql, args);
        const result = await query(compiled.text, compiled.values);
        return result.rows[0];
      },

      async all(...args) {
        const compiled = compilePreparedQuery(sql, args);
        const result = await query(compiled.text, compiled.values);
        return result.rows;
      },

      async run(...args) {
        const compiled = compilePreparedQuery(sql, args);
        const result = await query(compiled.text, compiled.values);
        return {
          changes: Number(result.rowCount ?? 0),
          rowCount: Number(result.rowCount ?? 0),
        };
      },
    };
  },

  async exec(sql) {
    return exec(sql);
  },

  transaction(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Transaction callback must be a function');
    }

    return async (...args) => {
      const existingStore = txStorage.getStore();
      if (existingStore?.client) {
        return fn(...args);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await txStorage.run({ client }, async () => fn(...args));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures so the original error surfaces.
        }
        throw error;
      } finally {
        client.release();
      }
    };
  },
};

const schemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      provider TEXT NOT NULL,
      provider_id TEXT,
      name TEXT,
      username TEXT,
      display_name TEXT,
      avatar_url TEXT,
      location TEXT,
      bio TEXT,
      is_seller INTEGER NOT NULL DEFAULT 0,
      stripe_account_id TEXT,
      stripe_customer_id TEXT,
      is_restricted INTEGER NOT NULL DEFAULT 0,
      used_free_first_sale_platform_fee INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'helper',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      stack TEXT,
      demo_url TEXT,
      price_usd INTEGER NOT NULL,
      add_ons_json TEXT,
      includes TEXT NOT NULL,
      not_included TEXT,
      notes TEXT,
      support_days INTEGER,
      delivery_method TEXT NOT NULL,
      screenshots_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      data_json TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS checkout_intents (
      id TEXT PRIMARY KEY,
      stripe_payment_intent_id TEXT UNIQUE,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      selected_add_ons_json TEXT,
      listing_price_usd INTEGER NOT NULL,
      add_ons_total_usd INTEGER NOT NULL,
      platform_fee_usd INTEGER NOT NULL,
      seller_platform_fee_bps INTEGER,
      buyer_service_fee_bps INTEGER,
      total_usd INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
      FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS saved_listings (
      user_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, listing_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_due_at TEXT,
      delivered_at TEXT,
      review_ends_at TEXT,
      addons_review_ends_at TEXT,
      seller_more_time_requested_at TEXT,
      seller_more_time_hours INTEGER,
      buyer_more_time_requested_at TEXT,
      buyer_more_time_hours INTEGER,
      delivery_zip_url TEXT,
      delivery_zip_public_id TEXT,
      delivery_zip_filename TEXT,
      delivery_zip_size_bytes BIGINT,
      delivery_repo_link TEXT,
      delivery_repo_username TEXT,
      delivery_repo_email TEXT,
      delivery_repo_message TEXT,
      selected_add_ons_json TEXT,
      listing_price_usd INTEGER NOT NULL,
      add_ons_total_usd INTEGER NOT NULL,
      platform_fee_usd INTEGER NOT NULL,
      total_usd INTEGER NOT NULL,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id TEXT,
      paid_at TEXT,
      refunded_usd INTEGER NOT NULL DEFAULT 0,
      refunded_subtotal_usd INTEGER NOT NULL DEFAULT 0,
      payout_status TEXT NOT NULL DEFAULT 'unpaid',
      paid_out_at TEXT,
      seller_paid_out_usd INTEGER NOT NULL DEFAULT 0,
      seller_platform_fee_bps INTEGER,
      buyer_service_fee_bps INTEGER,
      dispute_resolved_at TEXT,
      dispute_opened_at TEXT,
      dispute_reason TEXT,
      dispute_other_reason TEXT,
      dispute_message TEXT,
      dispute_edited_at TEXT,
      dispute_opened_stage TEXT,
      addons_started_at TEXT,
      addons_completed_at TEXT,
      addons_due_at TEXT,
      seller_delivery_due_soon_notified_at TEXT,
      buyer_review_ends_soon_notified_at TEXT,
      seller_addons_due_soon_notified_at TEXT,
      buyer_addons_review_ends_soon_notified_at TEXT,
      finalized_reason TEXT,
      finalized_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
      FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS order_more_time_requests (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      requester_role TEXT NOT NULL,
      hours INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by_id TEXT,
      decided_by_role TEXT,
      applied_at TEXT,
      deadline_before_iso TEXT,
      deadline_after_iso TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS listing_questions (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      question TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS listing_question_replies (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reply TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES listing_questions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS listing_question_likes (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES listing_questions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (question_id, user_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS message_threads (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'listing',
      order_id TEXT,
      dispute_stage TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      last_message_text TEXT,
      buyer_last_read_at TEXT,
      seller_last_read_at TEXT,
      buyer_archived INTEGER NOT NULL DEFAULT 0,
      seller_archived INTEGER NOT NULL DEFAULT 0,
      buyer_deleted INTEGER NOT NULL DEFAULT 0,
      seller_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
      FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS message_thread_listing_refs (
      thread_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, listing_id),
      FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON DELETE CASCADE,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS message_thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      body TEXT NOT NULL,
      reply_to_id TEXT,
      listing_context_json TEXT,
      image_url TEXT,
      image_public_id TEXT,
      attachment_name TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT,
      created_at BIGINT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS feedback_submissions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      from_email TEXT,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT,
      order_id TEXT,
      listing_id TEXT,
      listing_title TEXT,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS report_submissions (
      id TEXT PRIMARY KEY,
      reporter_user_id TEXT,
      reporter_email TEXT,
      reporter_username TEXT,
      reporter_name TEXT,
      reason TEXT NOT NULL,
      details TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      thread_id TEXT,
      listing_id TEXT,
      listing_title TEXT,
      target_excerpt TEXT,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS dashboard_reports (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      range TEXT NOT NULL,
      description TEXT,
      format TEXT NOT NULL DEFAULT 'csv',
      generated_at TEXT,
      removed_at TEXT,
      file_mime TEXT,
      file_name TEXT,
      file_content TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS platform_fee_promo_state (
      id INTEGER PRIMARY KEY,
      free_first_sale_slots_remaining INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (id = 1)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS order_disputes (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      edited_at TEXT,
      resolved_at TEXT,
      reason TEXT,
      other_reason TEXT,
      message TEXT,
      seed_image_message_ids TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    )
  `,
];

const indexStatements = [
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users (LOWER(username)) WHERE username IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_users_email ON dashboard_users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_users_status ON dashboard_users(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_listings_seller_id ON listings(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_checkout_intents_listing_status ON checkout_intents(listing_id, status, expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_listing_open_unique ON checkout_intents(listing_id) WHERE status = 'open'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_pi_unique ON checkout_intents(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_saved_listings_user_created ON saved_listings(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_buyer_created ON orders(buyer_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_seller_created ON orders(seller_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_listing_created ON orders(listing_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_number_unique ON orders(order_number) WHERE order_number IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripe_payment_intent_unique ON orders(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_more_time_requests_order_created ON order_more_time_requests(order_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_more_time_requests_order_stage ON order_more_time_requests(order_id, stage, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_more_time_requests_order_stage_requester ON order_more_time_requests(order_id, stage, requester_role, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_listing_questions_listing_id ON listing_questions(listing_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_listing_question_replies_question_id ON listing_question_replies(question_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_listing_question_likes_question_id ON listing_question_likes(question_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_message_threads_buyer ON message_threads(buyer_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_message_threads_seller ON message_threads(seller_id, updated_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_listing_unique ON message_threads(listing_id, buyer_id) WHERE kind = 'listing' AND order_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_dispute_order_stage_unique ON message_threads(order_id, dispute_stage) WHERE kind = 'dispute' AND order_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_message_thread_listing_refs_thread_created ON message_thread_listing_refs(thread_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_message_thread_listing_refs_listing ON message_thread_listing_refs(listing_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_message_thread_messages_thread ON message_thread_messages(thread_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created ON feedback_submissions(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_submissions_removed ON feedback_submissions(removed_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_report_submissions_created ON report_submissions(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_report_submissions_removed ON report_submissions(removed_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_report_submissions_target ON report_submissions(target_type, target_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dashboard_reports_removed ON dashboard_reports(removed_at, generated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_order_disputes_order ON order_disputes(order_id, opened_at)`,
  `CREATE INDEX IF NOT EXISTS idx_order_disputes_order_stage ON order_disputes(order_id, stage, opened_at)`,
  `CREATE INDEX IF NOT EXISTS idx_order_disputes_open ON order_disputes(order_id, stage, resolved_at, opened_at)`,
];

async function applySchema() {
  for (const statement of schemaStatements) {
    await exec(statement);
  }

  for (const statement of indexStatements) {
    await exec(statement);
  }
}

async function runDataFixups() {
  await exec(`
    UPDATE users
       SET username = COALESCE(username, name)
     WHERE username IS NULL
       AND name IS NOT NULL
  `);

  await exec(`
    UPDATE users
       SET display_name = COALESCE(display_name, username, name)
     WHERE display_name IS NULL
  `);

  await exec(`
    UPDATE listings
       SET updated_at = created_at
     WHERE COALESCE(updated_at, '') = ''
       AND created_at IS NOT NULL
  `);

  await exec(`
    UPDATE orders
       SET updated_at = created_at
     WHERE COALESCE(updated_at, '') = ''
       AND created_at IS NOT NULL
  `);

  await exec(`
    UPDATE orders
       SET refunded_subtotal_usd = refunded_usd
     WHERE refunded_subtotal_usd = 0
       AND refunded_usd > 0
  `);

  await exec(`
    UPDATE orders
       SET finalized_at = updated_at
     WHERE finalized_at IS NULL
       AND status IN ('completed', 'canceled')
  `);

  await exec(`
    UPDATE message_threads AS mt
       SET dispute_stage = CASE
         WHEN LOWER(COALESCE(o.dispute_opened_stage, '')) = 'addons' THEN 'addons'
         ELSE 'delivery'
       END
      FROM orders AS o
     WHERE mt.kind = 'dispute'
       AND mt.order_id = o.id
       AND mt.order_id IS NOT NULL
       AND mt.dispute_stage IS NULL
  `);

  await exec(`
    UPDATE message_threads
       SET dispute_stage = 'delivery'
     WHERE kind = 'dispute'
       AND order_id IS NOT NULL
       AND dispute_stage IS NULL
  `);
}

async function reconcilePlatformFeePromoState() {
  const row = await db
    .prepare(
      `SELECT COUNT(1) AS usedCount
         FROM users
        WHERE used_free_first_sale_platform_fee = 1`,
    )
    .get();

  const usedCount = Math.max(0, Number(row?.usedcount ?? row?.usedCount ?? 0));
  const remaining = Math.max(0, FREE_FIRST_SALE_SLOTS_TOTAL - usedCount);
  const now = new Date().toISOString();

  await query(
    `
      INSERT INTO platform_fee_promo_state (id, free_first_sale_slots_remaining, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET free_first_sale_slots_remaining = EXCLUDED.free_first_sale_slots_remaining,
          updated_at = EXCLUDED.updated_at
    `,
    [1, remaining, now],
  );
}

async function seedDashboardReports() {
  const seed = [
    {
      id: 'rep_001',
      name: 'Transactions summary',
      range: 'Last 30 days',
      description:
        'Summary of paid, refunded (subtotal), and completed transactions.',
    },
    {
      id: 'rep_002',
      name: 'Disputes overview',
      range: 'Last 90 days',
      description:
        'Overview of disputes opened vs resolved across the selected time window.',
    },
  ];

  for (const report of seed) {
    await query(
      `
        INSERT INTO dashboard_reports (
          id,
          name,
          range,
          description,
          format,
          generated_at,
          removed_at,
          file_mime,
          file_name,
          file_content
        )
        VALUES ($1, $2, $3, $4, 'csv', NULL, NULL, NULL, NULL, NULL)
        ON CONFLICT (id) DO NOTHING
      `,
      [report.id, report.name, report.range, report.description],
    );
  }
}

async function ensureDashboardOwner() {
  const ownerEmail = String(process.env.DASHBOARD_OWNER_EMAIL || '').trim();
  const ownerPassword = String(
    process.env.DASHBOARD_OWNER_PASSWORD || '',
  ).trim();

  if (!ownerEmail || !ownerPassword) {
    return;
  }

  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(ownerPassword, 10);

  await query(
    `
      INSERT INTO dashboard_users (
        id,
        email,
        password_hash,
        role,
        status,
        created_at,
        updated_at,
        last_login_at
      )
      VALUES ($1, $2, $3, 'owner', 'active', $4, $4, NULL)
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          role = 'owner',
          status = 'active',
          updated_at = EXCLUDED.updated_at
    `,
    [crypto.randomUUID(), ownerEmail, passwordHash, now],
  );
}

async function bootstrap({ skipSeeds = false } = {}) {
  const run = db.transaction(async () => {
    await applySchema();
    await runDataFixups();
    await reconcilePlatformFeePromoState();

    if (!skipSeeds) {
      await seedDashboardReports();
      await ensureDashboardOwner();
    }
  });

  await run();
}

async function initializeDatabase(options = {}) {
  const skipSeeds = Boolean(options.skipSeeds);

  if (skipSeeds) {
    await bootstrap({ skipSeeds: true });
    return;
  }

  if (!initPromise) {
    initPromise = bootstrap({ skipSeeds: false }).catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
}

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  db,
  pool,
  query,
  exec,
  initializeDatabase,
  closeDatabase,
  databaseDriver: 'postgres',
};
