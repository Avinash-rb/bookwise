-- Payments become race-free and idempotent.
--
-- The payments row itself is now the idempotency record: one payment per
-- order (order_id is already UNIQUE). A charge first inserts the row as
-- PENDING with ON CONFLICT DO NOTHING, so two identical requests can never
-- both start a charge. The separate check-then-insert idempotency_keys table
-- (racy: two requests could both pass the check) is no longer used.
DROP TABLE idempotency_keys;

-- Our stand-in for an external payment provider (Stripe, Razorpay...). In
-- production these records live at the provider; we keep them here so the
-- demo is self-contained. Like a real provider it is idempotent: the same
-- idempotency key always gets the same answer and is never charged twice.
CREATE TABLE provider_charges (
  idempotency_key  VARCHAR(255) PRIMARY KEY,
  amount           NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  outcome          VARCHAR(20) NOT NULL CHECK (outcome IN ('SUCCEEDED', 'DECLINED')),
  reference        VARCHAR(255) NOT NULL,
  refunded_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
