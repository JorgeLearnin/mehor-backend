'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || './data/app.db';
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
  created_at TEXT NOT NULL
);

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
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications(user_id, read_at, created_at);

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
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_listings_seller_id ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at);

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
  total_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_checkout_intents_listing_status
  ON checkout_intents(listing_id, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_listing_open_unique
  ON checkout_intents(listing_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS saved_listings (
  user_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, listing_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_saved_listings_user_created
  ON saved_listings(user_id, created_at);

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
  delivery_zip_size_bytes INTEGER,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE
);

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
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_more_time_requests_order_created
  ON order_more_time_requests(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_more_time_requests_order_stage
  ON order_more_time_requests(order_id, stage, created_at);
CREATE INDEX IF NOT EXISTS idx_more_time_requests_order_stage_requester
  ON order_more_time_requests(order_id, stage, requester_role, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_buyer_created
  ON orders(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_seller_created
  ON orders(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_listing_created
  ON orders(listing_id, created_at);

CREATE TABLE IF NOT EXISTS listing_questions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_listing_questions_listing_id
  ON listing_questions(listing_id, created_at);

CREATE TABLE IF NOT EXISTS listing_question_replies (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES listing_questions(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_listing_question_replies_question_id
  ON listing_question_replies(question_id, created_at);

CREATE TABLE IF NOT EXISTS listing_question_likes (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES listing_questions(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(question_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_question_likes_question_id
  ON listing_question_likes(question_id, created_at);

CREATE TABLE IF NOT EXISTS message_threads (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'listing',
  order_id TEXT,
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
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_thread_listing_refs (
  thread_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, listing_id),
  FOREIGN KEY(thread_id) REFERENCES message_threads(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_thread_listing_refs_thread_created
  ON message_thread_listing_refs(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_thread_listing_refs_listing
  ON message_thread_listing_refs(listing_id, created_at);

CREATE INDEX IF NOT EXISTS idx_message_threads_buyer
  ON message_threads(buyer_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_message_threads_seller
  ON message_threads(seller_id, updated_at);

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
  FOREIGN KEY(thread_id) REFERENCES message_threads(id) ON DELETE CASCADE,
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_thread_messages_thread
  ON message_thread_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

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
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created
  ON feedback_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_submissions_removed
  ON feedback_submissions(removed_at, created_at);

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
  FOREIGN KEY(reporter_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_report_submissions_created
  ON report_submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_report_submissions_removed
  ON report_submissions(removed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_report_submissions_target
  ON report_submissions(target_type, target_id, created_at);

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
);

CREATE INDEX IF NOT EXISTS idx_dashboard_reports_removed
  ON dashboard_reports(removed_at, generated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_hash
  ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON password_reset_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);
`);

function ensureUsersSchema() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  const names = new Set(cols.map((c) => c.name));

  if (!names.has('name')) {
    db.exec(`ALTER TABLE users ADD COLUMN name TEXT`);
  }

  if (!names.has('avatar_url')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
  }

  if (!names.has('username')) {
    db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
  }

  if (!names.has('display_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
  }

  if (!names.has('is_seller')) {
    db.exec(
      `ALTER TABLE users ADD COLUMN is_seller INTEGER NOT NULL DEFAULT 0`,
    );
  }

  if (!names.has('location')) {
    db.exec(`ALTER TABLE users ADD COLUMN location TEXT`);
  }

  if (!names.has('bio')) {
    db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`);
  }

  if (!names.has('stripe_account_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN stripe_account_id TEXT`);
  }

  if (!names.has('stripe_customer_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`);
  }

  if (!names.has('is_restricted')) {
    db.exec(
      `ALTER TABLE users ADD COLUMN is_restricted INTEGER NOT NULL DEFAULT 0`,
    );
  }

  if (!names.has('used_free_first_sale_platform_fee')) {
    db.exec(
      `ALTER TABLE users ADD COLUMN used_free_first_sale_platform_fee INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // Enforce unique usernames (case-insensitive) when provided.
  // Multiple NULL usernames are allowed.
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique
       ON users(LOWER(username))
       WHERE username IS NOT NULL`,
    );
  } catch {
    // If an existing DB already contains duplicates, this index creation would fail.
    // Registration still checks for duplicates in code.
  }

  // Backfill new columns from legacy `name` when present.
  try {
    db.exec(
      `UPDATE users
       SET username = COALESCE(username, name)
       WHERE username IS NULL AND name IS NOT NULL`,
    );
    db.exec(
      `UPDATE users
       SET display_name = COALESCE(display_name, username)
       WHERE display_name IS NULL`,
    );
  } catch {
    // Best-effort backfill; ignore if running during an incompatible migration.
  }
}

ensureUsersSchema();

function ensurePlatformFeePromoSchema() {
  try {
    const FREE_FIRST_SALE_SLOTS_TOTAL = 10;

    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_fee_promo_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        free_first_sale_slots_remaining INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const exists = db
      .prepare(`SELECT 1 AS ok FROM platform_fee_promo_state WHERE id = 1`)
      .get();

    if (!exists) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO platform_fee_promo_state (id, free_first_sale_slots_remaining, updated_at)
         VALUES (1, ?, ?)`,
      ).run(FREE_FIRST_SALE_SLOTS_TOTAL, now);
      return;
    }

    // If the promo pool size changes (e.g. 20 -> 10), reconcile remaining slots
    // based on how many sellers have already used the free first sale.
    // This keeps the global cap consistent for existing databases.
    try {
      const usedRow = db
        .prepare(
          `SELECT COUNT(1) AS usedCount
             FROM users
            WHERE used_free_first_sale_platform_fee = 1`,
        )
        .get();

      const usedCount = Math.max(0, Number(usedRow?.usedCount ?? 0));
      const desiredRemaining = Math.max(
        0,
        FREE_FIRST_SALE_SLOTS_TOTAL - usedCount,
      );

      const stateRow = db
        .prepare(
          `SELECT free_first_sale_slots_remaining AS remaining
             FROM platform_fee_promo_state
            WHERE id = 1
            LIMIT 1`,
        )
        .get();
      const currentRemaining = Math.max(0, Number(stateRow?.remaining ?? 0));

      if (currentRemaining !== desiredRemaining) {
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE platform_fee_promo_state
              SET free_first_sale_slots_remaining = ?,
                  updated_at = ?
            WHERE id = 1`,
        ).run(desiredRemaining, now);
      }
    } catch {
      // Best-effort reconciliation.
    }
  } catch {
    // Best-effort migration.
  }
}

ensurePlatformFeePromoSchema();

function ensureDashboardReportsSeed() {
  try {
    const base = {
      format: 'csv',
      generated_at: null,
      removed_at: null,
      file_mime: null,
      file_name: null,
      file_content: null,
    };

    const seed = [
      {
        id: 'rep_001',
        name: 'Transactions summary',
        range: 'Last 30 days',
        description:
          'Summary of paid, refunded (subtotal), and completed transactions.',
        ...base,
      },
      {
        id: 'rep_002',
        name: 'Disputes overview',
        range: 'Last 90 days',
        description:
          'Overview of disputes opened vs resolved across the selected time window.',
        ...base,
      },
    ];

    const stmt = db.prepare(
      `INSERT INTO dashboard_reports (id, name, range, description, format, generated_at, removed_at, file_mime, file_name, file_content)
       VALUES (@id, @name, @range, @description, @format, @generated_at, @removed_at, @file_mime, @file_name, @file_content)`,
    );

    const existsStmt = db.prepare(
      `SELECT 1 AS ok FROM dashboard_reports WHERE id = ? LIMIT 1`,
    );

    for (const r of seed) {
      const ex = existsStmt.get(r.id);
      if (!ex?.ok) stmt.run(r);
    }
  } catch {
    // Best-effort seed.
  }
}

ensureDashboardReportsSeed();

function ensureOrdersSchema() {
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='orders'`,
    )
    .get();
  if (!exists) return;

  const cols = db.prepare(`PRAGMA table_info(orders)`).all();
  const names = new Set(cols.map((c) => c.name));

  if (!names.has('order_number')) {
    db.exec(`ALTER TABLE orders ADD COLUMN order_number TEXT`);
  }

  if (!names.has('stripe_checkout_session_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN stripe_checkout_session_id TEXT`);
  }
  if (!names.has('stripe_payment_intent_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN stripe_payment_intent_id TEXT`);
  }
  if (!names.has('paid_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN paid_at TEXT`);
  }

  if (!names.has('delivered_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivered_at TEXT`);
  }

  if (!names.has('delivery_due_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_due_at TEXT`);
  }

  if (!names.has('review_ends_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN review_ends_at TEXT`);
  }

  if (!names.has('seller_more_time_requested_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN seller_more_time_requested_at TEXT`);
  }
  if (!names.has('seller_more_time_hours')) {
    db.exec(`ALTER TABLE orders ADD COLUMN seller_more_time_hours INTEGER`);
  }
  if (!names.has('buyer_more_time_requested_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN buyer_more_time_requested_at TEXT`);
  }
  if (!names.has('buyer_more_time_hours')) {
    db.exec(`ALTER TABLE orders ADD COLUMN buyer_more_time_hours INTEGER`);
  }

  if (!names.has('delivery_zip_url')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_zip_url TEXT`);
  }
  if (!names.has('delivery_zip_public_id')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_zip_public_id TEXT`);
  }
  if (!names.has('delivery_zip_filename')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_zip_filename TEXT`);
  }
  if (!names.has('delivery_zip_size_bytes')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_zip_size_bytes INTEGER`);
  }
  if (!names.has('delivery_repo_link')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_repo_link TEXT`);
  }
  if (!names.has('delivery_repo_username')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_repo_username TEXT`);
  }
  if (!names.has('delivery_repo_email')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_repo_email TEXT`);
  }
  if (!names.has('delivery_repo_message')) {
    db.exec(`ALTER TABLE orders ADD COLUMN delivery_repo_message TEXT`);
  }

  // Earnings / payouts
  if (!names.has('refunded_usd')) {
    // Amount refunded to the buyer (USD integer). Used to derive "Partial refund".
    db.exec(
      `ALTER TABLE orders ADD COLUMN refunded_usd INTEGER NOT NULL DEFAULT 0`,
    );
  }

  if (!names.has('refunded_subtotal_usd')) {
    // Portion of refunds that reduce the order subtotal (excludes buyer service fee).
    db.exec(
      `ALTER TABLE orders ADD COLUMN refunded_subtotal_usd INTEGER NOT NULL DEFAULT 0`,
    );

    // Best-effort backfill for existing DBs that only tracked refunded_usd.
    // Historical refunded_usd was effectively "subtotal refunded" since fee refunds weren't supported.
    try {
      db.exec(
        `UPDATE orders
            SET refunded_subtotal_usd = refunded_usd
          WHERE refunded_subtotal_usd = 0 AND refunded_usd > 0`,
      );
    } catch {
      // Ignore backfill errors; schema may differ in older DBs.
    }
  }

  if (!names.has('payout_status')) {
    // When seller withdraws funds for a completed order, set to 'paid'.
    // Keep order lifecycle status separate (paid/delivered/completed/etc.).
    db.exec(
      `ALTER TABLE orders ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'unpaid'`,
    );
  }

  if (!names.has('paid_out_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN paid_out_at TEXT`);
  }

  if (!names.has('seller_paid_out_usd')) {
    // Amount paid out to the seller (USD integer) excluding platform fee.
    db.exec(
      `ALTER TABLE orders ADD COLUMN seller_paid_out_usd INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // Fee snapshots (basis points) for seller earnings and future fee flexibility.
  if (!names.has('seller_platform_fee_bps')) {
    db.exec(`ALTER TABLE orders ADD COLUMN seller_platform_fee_bps INTEGER`);
  }
  if (!names.has('buyer_service_fee_bps')) {
    db.exec(`ALTER TABLE orders ADD COLUMN buyer_service_fee_bps INTEGER`);
  }

  if (!names.has('dispute_resolved_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_resolved_at TEXT`);
  }

  // Disputes
  if (!names.has('dispute_opened_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_opened_at TEXT`);
  }
  if (!names.has('dispute_reason')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_reason TEXT`);
  }
  if (!names.has('dispute_other_reason')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_other_reason TEXT`);
  }
  if (!names.has('dispute_message')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_message TEXT`);
  }
  if (!names.has('dispute_edited_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_edited_at TEXT`);
  }
  if (!names.has('dispute_opened_stage')) {
    db.exec(`ALTER TABLE orders ADD COLUMN dispute_opened_stage TEXT`);
  }

  // Add-ons lifecycle
  if (!names.has('addons_started_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN addons_started_at TEXT`);
  }
  if (!names.has('addons_completed_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN addons_completed_at TEXT`);
  }
  if (!names.has('addons_due_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN addons_due_at TEXT`);
  }
  if (!names.has('addons_review_ends_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN addons_review_ends_at TEXT`);
  }

  // Timer reminders (one-time)
  if (!names.has('seller_delivery_due_soon_notified_at')) {
    db.exec(
      `ALTER TABLE orders ADD COLUMN seller_delivery_due_soon_notified_at TEXT`,
    );
  }
  if (!names.has('buyer_review_ends_soon_notified_at')) {
    db.exec(
      `ALTER TABLE orders ADD COLUMN buyer_review_ends_soon_notified_at TEXT`,
    );
  }
  if (!names.has('seller_addons_due_soon_notified_at')) {
    db.exec(
      `ALTER TABLE orders ADD COLUMN seller_addons_due_soon_notified_at TEXT`,
    );
  }
  if (!names.has('buyer_addons_review_ends_soon_notified_at')) {
    db.exec(
      `ALTER TABLE orders ADD COLUMN buyer_addons_review_ends_soon_notified_at TEXT`,
    );
  }

  // Finalization tracking (immutable once set)
  if (!names.has('finalized_reason')) {
    db.exec(`ALTER TABLE orders ADD COLUMN finalized_reason TEXT`);
  }
  if (!names.has('finalized_at')) {
    db.exec(`ALTER TABLE orders ADD COLUMN finalized_at TEXT`);

    // Best-effort backfill: if an order is already in a final state,
    // treat its updated_at as the finalized timestamp.
    try {
      db.exec(
        `UPDATE orders
            SET finalized_at = updated_at
          WHERE finalized_at IS NULL
            AND status IN ('completed', 'canceled')`,
      );
    } catch {
      // ignore
    }
  }

  // Enforce unique public-facing order numbers when present.
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_number_unique
       ON orders(order_number)
       WHERE order_number IS NOT NULL`,
    );
  } catch {
    // Best-effort: if an existing DB already contains duplicates, index creation would fail.
  }

  // Enforce unique Stripe payment intent id when present (prevents double-finalize).
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripe_payment_intent_unique
       ON orders(stripe_payment_intent_id)
       WHERE stripe_payment_intent_id IS NOT NULL`,
    );
  } catch {
    // ignore
  }
}

ensureOrdersSchema();

function ensureOrderDisputesSchema() {
  // Stores dispute history per order + stage (delivery vs add-ons).
  // This avoids overwriting the delivery dispute when a later add-ons dispute is opened.
  try {
    db.exec(`
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
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_order_disputes_order
        ON order_disputes(order_id, opened_at);
      CREATE INDEX IF NOT EXISTS idx_order_disputes_order_stage
        ON order_disputes(order_id, stage, opened_at);
      CREATE INDEX IF NOT EXISTS idx_order_disputes_open
        ON order_disputes(order_id, stage, resolved_at, opened_at);
    `);
  } catch {
    // ignore
  }

  // Best-effort forward migration: add seed screenshot ids column if missing.
  // Existing DBs created before this column was introduced will not have it.
  try {
    db.exec(
      `ALTER TABLE order_disputes ADD COLUMN seed_image_message_ids TEXT`,
    );
  } catch {
    // ignore (already exists or table missing)
  }

  // Best-effort legacy migration: if an order has dispute_* columns set,
  // backfill a single dispute record (idempotent via deterministic id).
  try {
    const legacyRows = db
      .prepare(
        `SELECT id,
                dispute_opened_at AS openedAt,
                dispute_opened_stage AS openedStage,
                dispute_resolved_at AS resolvedAt,
                dispute_reason AS reason,
                dispute_other_reason AS otherReason,
                dispute_message AS message,
                dispute_edited_at AS editedAt
           FROM orders
          WHERE dispute_opened_at IS NOT NULL
            AND dispute_opened_at <> ''`,
      )
      .all();

    const insert = db.prepare(
      `INSERT OR IGNORE INTO order_disputes (
          id,
          order_id,
          stage,
          opened_at,
          edited_at,
          resolved_at,
          reason,
          other_reason,
          message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const r of legacyRows) {
      const orderId = String(r.id || '').trim();
      const openedAt = String(r.openedAt || '').trim();
      if (!orderId || !openedAt) continue;

      const stageRaw = String(r.openedStage || '')
        .trim()
        .toLowerCase();
      const stage = stageRaw === 'addons' ? 'addons' : 'delivery';

      const legacyId = `legacy:${orderId}`;
      const editedAt = String(r.editedAt || '').trim() || null;
      const resolvedAt = String(r.resolvedAt || '').trim() || null;
      const updatedAt = editedAt || resolvedAt || openedAt;

      insert.run(
        legacyId,
        orderId,
        stage,
        openedAt,
        editedAt,
        resolvedAt,
        r.reason ?? null,
        r.otherReason ?? null,
        r.message ?? null,
        openedAt,
        updatedAt,
      );
    }
  } catch {
    // ignore legacy migration errors
  }
}

ensureOrderDisputesSchema();

function ensureCheckoutIntentsSchema() {
  try {
    const exists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='checkout_intents'`,
      )
      .get();
    if (!exists) {
      // The main schema above will create this table on fresh DBs.
      // For older DBs, run a minimal create.
      db.exec(`
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
          total_usd INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
          FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_checkout_intents_listing_status
          ON checkout_intents(listing_id, status, expires_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_listing_open_unique
          ON checkout_intents(listing_id)
          WHERE status = 'open';
      `);
      return;
    }

    // Columns may be missing if the table was created partially.
    const cols = db.prepare(`PRAGMA table_info(checkout_intents)`).all();
    const names = new Set(cols.map((c) => String(c.name)));

    const addCol = (sql) => {
      try {
        db.exec(sql);
      } catch {
        // ignore
      }
    };

    if (!names.has('stripe_payment_intent_id')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN stripe_payment_intent_id TEXT`,
      );
    }
    if (!names.has('listing_id')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN listing_id TEXT`);
    }
    if (!names.has('buyer_id')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN buyer_id TEXT`);
    }
    if (!names.has('status')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN status TEXT`);
    }
    if (!names.has('selected_add_ons_json')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN selected_add_ons_json TEXT`,
      );
    }
    if (!names.has('listing_price_usd')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN listing_price_usd INTEGER`,
      );
    }
    if (!names.has('add_ons_total_usd')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN add_ons_total_usd INTEGER`,
      );
    }
    if (!names.has('platform_fee_usd')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN platform_fee_usd INTEGER`,
      );
    }

    if (!names.has('seller_platform_fee_bps')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN seller_platform_fee_bps INTEGER`,
      );
    }

    if (!names.has('buyer_service_fee_bps')) {
      addCol(
        `ALTER TABLE checkout_intents ADD COLUMN buyer_service_fee_bps INTEGER`,
      );
    }
    if (!names.has('total_usd')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN total_usd INTEGER`);
    }
    if (!names.has('created_at')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN created_at TEXT`);
    }
    if (!names.has('expires_at')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN expires_at TEXT`);
    }
    if (!names.has('updated_at')) {
      addCol(`ALTER TABLE checkout_intents ADD COLUMN updated_at TEXT`);
    }

    // Indexes.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_checkout_intents_listing_status
         ON checkout_intents(listing_id, status, expires_at)`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_listing_open_unique
         ON checkout_intents(listing_id)
         WHERE status = 'open'`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_pi_unique
         ON checkout_intents(stripe_payment_intent_id)
         WHERE stripe_payment_intent_id IS NOT NULL`,
    );
  } catch {
    // Best-effort migration.
  }
}

ensureCheckoutIntentsSchema();

function ensureListingsSchema() {
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='listings'`,
    )
    .get();
  if (!exists) return;

  const cols = db.prepare(`PRAGMA table_info(listings)`).all();
  const names = new Set(cols.map((c) => c.name));

  if (!names.has('screenshots_json')) {
    db.exec(`ALTER TABLE listings ADD COLUMN screenshots_json TEXT`);
  }

  if (!names.has('status')) {
    db.exec(
      `ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    );
  }

  if (!names.has('add_ons_json')) {
    db.exec(`ALTER TABLE listings ADD COLUMN add_ons_json TEXT`);
  }

  if (!names.has('updated_at')) {
    db.exec(
      `ALTER TABLE listings ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
    );
    try {
      db.exec(
        `UPDATE listings SET updated_at = created_at WHERE updated_at = ''`,
      );
    } catch {
      // ignore
    }
  }

  if (!names.has('notes')) {
    db.exec(`ALTER TABLE listings ADD COLUMN notes TEXT`);
  }
}

ensureListingsSchema();

function ensureMessagesSchema() {
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='message_thread_messages'`,
    )
    .get();
  if (!exists) return;

  const cols = db.prepare(`PRAGMA table_info(message_thread_messages)`).all();
  const names = new Set(cols.map((c) => String(c.name)));

  const addCol = (sql) => {
    try {
      db.exec(sql);
    } catch {
      // ignore
    }
  };

  if (!names.has('image_url')) {
    addCol(`ALTER TABLE message_thread_messages ADD COLUMN image_url TEXT`);
  }

  if (!names.has('reply_to_id')) {
    addCol(`ALTER TABLE message_thread_messages ADD COLUMN reply_to_id TEXT`);
  }

  if (!names.has('listing_context_json')) {
    addCol(
      `ALTER TABLE message_thread_messages ADD COLUMN listing_context_json TEXT`,
    );
  }

  if (!names.has('image_public_id')) {
    addCol(
      `ALTER TABLE message_thread_messages ADD COLUMN image_public_id TEXT`,
    );
  }

  if (!names.has('attachment_name')) {
    addCol(
      `ALTER TABLE message_thread_messages ADD COLUMN attachment_name TEXT`,
    );
  }
}

ensureMessagesSchema();

function ensureMessageThreadsSchema() {
  const exists = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name='message_threads'`,
    )
    .get();
  if (!exists) return;

  const createSql = String(exists.sql || '');
  const cols = db.prepare(`PRAGMA table_info(message_threads)`).all();
  const names = new Set(cols.map((c) => String(c.name)));

  const hasKind = names.has('kind');
  const hasOrderId = names.has('order_id');
  const hasDisputeStage = names.has('dispute_stage');

  if (!hasDisputeStage) {
    try {
      db.exec(`ALTER TABLE message_threads ADD COLUMN dispute_stage TEXT`);
    } catch {
      // ignore
    }
  }

  // If the table was created with a UNIQUE(listing_id, buyer_id) constraint,
  // we must rebuild it to allow dispute threads (which reuse listing_id/buyer_id).
  const hasLegacyUniqueConstraint =
    /UNIQUE\s*\(\s*listing_id\s*,\s*buyer_id\s*\)/i.test(createSql);

  if (hasKind && hasOrderId && !hasLegacyUniqueConstraint) {
    // Ensure indexes exist (idempotent).
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_listing_unique
           ON message_threads(listing_id, buyer_id)
           WHERE kind = 'listing' AND order_id IS NULL;`,
      );
    } catch {
      // ignore
    }

    // Backfill stage for existing dispute threads (best-effort).
    try {
      db.exec(
        `UPDATE message_threads
            SET dispute_stage = COALESCE(dispute_stage, (
              SELECT CASE
                WHEN LOWER(COALESCE(orders.dispute_opened_stage, '')) = 'addons' THEN 'addons'
                ELSE 'delivery'
              END
              FROM orders
              WHERE orders.id = message_threads.order_id
              LIMIT 1
            ), 'delivery')
          WHERE kind = 'dispute' AND order_id IS NOT NULL;`,
      );
    } catch {
      // ignore
    }

    // Replace the old "one dispute thread per order" index with a per-stage unique index.
    try {
      db.exec(`DROP INDEX IF EXISTS idx_message_threads_dispute_order_unique`);
    } catch {
      // ignore
    }
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_dispute_order_stage_unique
           ON message_threads(order_id, dispute_stage)
           WHERE kind = 'dispute' AND order_id IS NOT NULL;`,
      );
    } catch {
      // ignore
    }
    return;
  }

  // Migration path:
  // - create new table with kind/order_id + no legacy UNIQUE constraint
  // - copy data
  // - swap tables
  // Safe to run multiple times; will no-op if already migrated.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_threads__new (
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
        FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
        FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Copy rows; default kind/order_id for legacy threads.
    // If columns already exist (partial migration), preserve them.
    if (hasKind && hasOrderId) {
      db.exec(`
        INSERT OR IGNORE INTO message_threads__new (
          id, listing_id, buyer_id, seller_id, kind, order_id, dispute_stage,
          created_at, updated_at, last_message_at, last_message_text,
          buyer_last_read_at, seller_last_read_at,
          buyer_archived, seller_archived, buyer_deleted, seller_deleted
        )
        SELECT
          id, listing_id, buyer_id, seller_id,
          COALESCE(NULLIF(kind, ''), 'listing') AS kind,
          NULLIF(order_id, '') AS order_id,
          COALESCE(NULLIF(dispute_stage, ''), NULL) AS dispute_stage,
          created_at, updated_at, last_message_at, last_message_text,
          buyer_last_read_at, seller_last_read_at,
          buyer_archived, seller_archived, buyer_deleted, seller_deleted
        FROM message_threads;
      `);
    } else {
      db.exec(`
        INSERT OR IGNORE INTO message_threads__new (
          id, listing_id, buyer_id, seller_id, kind, order_id, dispute_stage,
          created_at, updated_at, last_message_at, last_message_text,
          buyer_last_read_at, seller_last_read_at,
          buyer_archived, seller_archived, buyer_deleted, seller_deleted
        )
        SELECT
          id, listing_id, buyer_id, seller_id,
          'listing' AS kind,
          NULL AS order_id,
          NULL AS dispute_stage,
          created_at, updated_at, last_message_at, last_message_text,
          buyer_last_read_at, seller_last_read_at,
          buyer_archived, seller_archived, buyer_deleted, seller_deleted
        FROM message_threads;
      `);
    }

    // Swap.
    db.exec(`DROP TABLE IF EXISTS message_threads`);
    db.exec(`ALTER TABLE message_threads__new RENAME TO message_threads`);

    // Recreate indexes.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_message_threads_buyer ON message_threads(buyer_id, updated_at);`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_message_threads_seller ON message_threads(seller_id, updated_at);`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_listing_unique
         ON message_threads(listing_id, buyer_id)
         WHERE kind = 'listing' AND order_id IS NULL;`,
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_threads_dispute_order_stage_unique
        ON message_threads(order_id, dispute_stage)
        WHERE kind = 'dispute' AND order_id IS NOT NULL;`,
    );

    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Message threads migration failed:', e);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

ensureMessageThreadsSchema();

function ensureDashboardUsersSchema() {
  // Dedicated auth store for dashboard admins/helpers.
  // Keep it separate from marketplace `users`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'helper',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dashboard_users_email
      ON dashboard_users(email);
    CREATE INDEX IF NOT EXISTS idx_dashboard_users_status
      ON dashboard_users(status, updated_at);
  `);

  // Optional bootstrap/seed for the owner account.
  // Set these in backend/.env:
  // - DASHBOARD_OWNER_EMAIL
  // - DASHBOARD_OWNER_PASSWORD
  const ownerEmail = String(process.env.DASHBOARD_OWNER_EMAIL ?? '').trim();
  const ownerPassword = String(
    process.env.DASHBOARD_OWNER_PASSWORD ?? '',
  ).trim();

  if (!ownerEmail || !ownerPassword) return;

  const existing = db
    .prepare(`SELECT id FROM dashboard_users WHERE email = ?`)
    .get(ownerEmail);

  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(ownerPassword, 10);

  if (!existing) {
    db.prepare(
      `INSERT INTO dashboard_users (id, email, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
    ).run(crypto.randomUUID(), ownerEmail, passwordHash, now, now);
    return;
  }

  // If it exists, ensure it's active + role owner; update password hash (idempotent).
  db.prepare(
    `UPDATE dashboard_users
       SET password_hash = ?,
           role = 'owner',
           status = 'active',
           updated_at = ?
     WHERE email = ?`,
  ).run(passwordHash, now, ownerEmail);
}

ensureDashboardUsersSchema();

module.exports = { db };
