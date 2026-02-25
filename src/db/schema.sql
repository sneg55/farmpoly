CREATE TABLE IF NOT EXISTS markets (
  condition_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  token_id_yes TEXT NOT NULL,
  token_id_no TEXT NOT NULL,
  tick_size TEXT NOT NULL DEFAULT '0.01',
  neg_risk INTEGER NOT NULL DEFAULT 0,
  midpoint REAL,
  tvl REAL,
  reward_rate REAL,
  last_updated INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL REFERENCES markets(condition_id),
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
  price REAL NOT NULL,
  size REAL NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'GTC',
  status TEXT NOT NULL DEFAULT 'LIVE' CHECK(status IN ('LIVE', 'CANCELLED', 'FILLED', 'EXPIRED')),
  placed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  cancelled_at INTEGER,
  filled_size REAL NOT NULL DEFAULT 0,
  expiry INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at INTEGER,
  budget_usdc REAL NOT NULL,
  spread_cents REAL NOT NULL,
  markets_count INTEGER NOT NULL DEFAULT 0,
  orders_placed INTEGER NOT NULL DEFAULT 0,
  orders_cancelled INTEGER NOT NULL DEFAULT 0,
  orders_filled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING', 'STOPPED', 'PANIC'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS hedges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  condition_id TEXT NOT NULL REFERENCES markets(condition_id),
  fill_side TEXT NOT NULL CHECK(fill_side IN ('BUY', 'SELL')),
  fill_size REAL NOT NULL,
  fill_price REAL NOT NULL,
  hedge_order_id TEXT,
  hedge_price REAL,
  hedge_size REAL NOT NULL DEFAULT 0,
  merge_amount REAL NOT NULL DEFAULT 0,
  merge_tx_hash TEXT,
  pnl_cents REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING', 'HEDGED', 'HEDGE_FAILED', 'MERGE_FAILED', 'SKIPPED')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_condition ON orders(condition_id);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_recent ON orders(status, cancelled_at DESC, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_hedges_status ON hedges(status);
