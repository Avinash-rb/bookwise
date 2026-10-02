-- ─────────────────────────────────────────────────────────
-- BookWise Order Service DB
-- Owns: orders (saga state machine) + saga audit log
-- ─────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Orders ────────────────────────────────────────────────
-- One row = one booking attempt
-- status column IS the saga state machine
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_email  VARCHAR(255) NOT NULL,
  show_id         UUID NOT NULL,         -- references inventory DB (cross-service)
  total_amount    NUMERIC(10, 2) NOT NULL,
  status          VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  -- Saga states:
  -- PENDING             → order created, saga not started
  -- SEATS_RESERVED      → inventory step succeeded
  -- PAYMENT_COMPLETED   → payment step succeeded
  -- CONFIRMED           → saga complete, booking confirmed
  -- FAILED              → saga failed, compensations ran
  -- CANCELLED           → user cancelled
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Order Seats ───────────────────────────────────────────
-- Which seats belong to this order (supports multi-seat booking)
CREATE TABLE order_seats (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  show_seat_id UUID NOT NULL,            -- references inventory DB
  price        NUMERIC(10, 2) NOT NULL   -- price at time of booking
);

-- ── Saga Logs ─────────────────────────────────────────────
-- Audit trail: every step the saga took
-- Critical for: debugging, crash recovery, idempotency checks
CREATE TABLE saga_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  step        VARCHAR(50) NOT NULL,
  -- RESERVE_SEATS / PROCESS_PAYMENT / CONFIRM_SEATS
  -- RELEASE_SEATS (compensation) / REFUND_PAYMENT (compensation)
  action      VARCHAR(20) NOT NULL,
  -- STARTED / COMPLETED / FAILED / COMPENSATED
  payload     JSONB,                     -- request/response data for debugging
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX idx_orders_customer    ON orders(customer_email);
CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_saga_logs_order    ON saga_logs(order_id);
CREATE INDEX idx_order_seats_order  ON order_seats(order_id);
