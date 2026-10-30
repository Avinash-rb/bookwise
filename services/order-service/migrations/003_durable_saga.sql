-- The order row becomes the saga's durable state: which step is next, how
-- many times it was tried, and when to run it. A background worker reads this,
-- so a booking survives a crash of the process that started it.

-- Next step to run. Existing orders were finished by the old synchronous saga,
-- so they get 'DONE'; new orders start at 'RESERVE_SEATS' (second statement).
ALTER TABLE orders ADD COLUMN saga_step VARCHAR(30) NOT NULL DEFAULT 'DONE'
  CHECK (saga_step IN ('RESERVE_SEATS', 'PROCESS_PAYMENT', 'CONFIRM_SEATS',
                       'REFUND_PAYMENT', 'RELEASE_SEATS', 'DONE'));
ALTER TABLE orders ALTER COLUMN saga_step SET DEFAULT 'RESERVE_SEATS';

-- When the worker should run the step. NULL = nothing to do (finished, or
-- waiting for a human). Existing rows get NULL; new rows "now".
ALTER TABLE orders ADD COLUMN next_run_at TIMESTAMPTZ;
ALTER TABLE orders ALTER COLUMN next_run_at SET DEFAULT now();

ALTER TABLE orders
  ADD COLUMN attempts       INTEGER NOT NULL DEFAULT 0,  -- tries of the current step
  ADD COLUMN locked_until   TIMESTAMPTZ,                 -- lease: a worker is on it until then
  ADD COLUMN version        INTEGER NOT NULL DEFAULT 0,  -- bumped on every claim (fencing)
  ADD COLUMN last_error     TEXT,                        -- latest temporary error, for debugging
  ADD COLUMN failure_reason VARCHAR(50),                 -- why it failed, shown to the customer
  ADD COLUMN idempotency_key VARCHAR(255);               -- client's Idempotency-Key header

-- The total is now set by the saga from inventory's prices, after seats are
-- reserved, so it's unknown when the order is created. Same for seat prices.
ALTER TABLE orders ALTER COLUMN total_amount DROP NOT NULL;
ALTER TABLE order_seats ALTER COLUMN price DROP NOT NULL;

-- NEEDS_ATTENTION: retries ran out after money was taken; a human decides.
-- (Old statuses stay allowed for the legacy rows.)
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'NEEDS_ATTENTION',
                    'SEATS_RESERVED', 'PAYMENT_COMPLETED', 'CANCELLED'));

-- RETRY: a step hit a temporary error and was rescheduled.
ALTER TABLE saga_logs DROP CONSTRAINT saga_logs_action_check;
ALTER TABLE saga_logs ADD CONSTRAINT saga_logs_action_check
  CHECK (action IN ('STARTED', 'COMPLETED', 'FAILED', 'RETRY', 'COMPENSATED'));

-- The same Idempotency-Key from the same customer = the same order.
CREATE UNIQUE INDEX uq_orders_idempotency ON orders (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The worker's query: "orders due to run". Partial: finished orders (the vast
-- majority) aren't in this index at all.
CREATE INDEX idx_orders_saga_due ON orders (next_run_at) WHERE next_run_at IS NOT NULL;
