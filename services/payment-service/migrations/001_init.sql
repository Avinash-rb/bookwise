-- BookWise Payment Service DB
-- Owns: payments and idempotency keys.

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL UNIQUE,     -- one payment per order; lives in the order DB
  amount              NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED')),
  provider_reference  VARCHAR(255),             -- payment gateway transaction id
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevents double-charging when the saga retries the payment step:
-- a repeated key returns the stored response instead of charging again.
CREATE TABLE idempotency_keys (
  key            VARCHAR(255) PRIMARY KEY,
  response_body  JSONB NOT NULL,
  status_code    INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_status ON payments (status);
