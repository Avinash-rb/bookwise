-- ─────────────────────────────────────────────────────────
-- BookWise Payment Service DB
-- Owns: payments + idempotency keys
-- ─────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Payments ──────────────────────────────────────────────
CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id           UUID NOT NULL,        -- references order DB (cross-service)
  amount             NUMERIC(10, 2) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  -- PENDING / COMPLETED / FAILED / REFUNDED
  provider_reference VARCHAR(255),         -- payment gateway txn ID
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Idempotency Keys ──────────────────────────────────────
-- Prevents double-charging on saga retries
-- Key = order_id (unique per booking attempt)
-- If saga retries payment step, we return the stored result
-- instead of charging again
CREATE TABLE idempotency_keys (
  key           VARCHAR(255) PRIMARY KEY,  -- = order_id
  response_body JSONB NOT NULL,            -- what we responded the first time
  status_code   INTEGER NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX idx_payments_order_id ON payments(order_id);
CREATE INDEX idx_payments_status   ON payments(status);