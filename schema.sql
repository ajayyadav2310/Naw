-- NOTE: Reference schema for a possible future native SQLite migration. The current app stores data
-- as a validated JSON document in Capacitor Preferences (see www/app.js); this file is NOT used at runtime.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS accounts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL UNIQUE,
 bank_code TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
 id TEXT PRIMARY KEY,
 account_id INTEGER,
 direction TEXT NOT NULL CHECK(direction IN ('income','expense','transfer')),
 amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
 person TEXT, purpose TEXT, category TEXT, payment_method TEXT, reference TEXT,
 occurred_at TEXT NOT NULL, notes TEXT,
 source TEXT NOT NULL DEFAULT 'manual',
 source_key TEXT UNIQUE,
 account_confidence TEXT DEFAULT 'user_confirmed',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_direction_date ON transactions(direction, occurred_at);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
