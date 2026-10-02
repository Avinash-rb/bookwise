-- BookWise Order Service DB
-- Owns: orders (the saga state machine) and the saga audit log.
-- gen_random_uuid() is built into Postgres 13+, so no uuid-ossp extension is needed.

CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_email  VARCHAR(255) NOT NULL,
  show_id         UUID NOT NULL,              -- lives in the inventory DB (no FK across services)
  total_amount    NUMERIC(10, 2) NOT NULL CHECK (total_amount >= 0),
  status          VARCHAR(30) NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SEATS_RESERVED', 'PAYMENT_COMPLETED',
                                    'CONFIRMED', 'FAILED', 'CANCELLED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which seats belong to an order (multi-seat booking).
CREATE TABLE order_seats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  show_seat_id  UUID NOT NULL,                -- lives in the inventory DB
  price         NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  UNIQUE (order_id, show_seat_id)             -- also serves lookups by order_id
);

-- Audit trail of every saga step: debugging, crash recovery, the admin view.
CREATE TABLE saga_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  step        VARCHAR(50) NOT NULL,
  action      VARCHAR(20) NOT NULL
              CHECK (action IN ('STARTED', 'COMPLETED', 'FAILED', 'COMPENSATED')),
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer   ON orders (customer_email, created_at DESC);
CREATE INDEX idx_orders_status     ON orders (status);
CREATE INDEX idx_saga_logs_order   ON saga_logs (order_id, created_at);
