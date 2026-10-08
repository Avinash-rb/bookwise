-- Orders belong to a customer: the user id from the verified access token
-- (auth-service owns users, so no foreign key).
ALTER TABLE orders ADD COLUMN customer_id UUID;

-- Required for every new order. NOT VALID skips the existing rows, which were
-- created with only a client-supplied email and have no known owner (see the
-- same pattern in inventory 002). Only admins can see those legacy orders.
ALTER TABLE orders
  ADD CONSTRAINT orders_customer_required CHECK (customer_id IS NOT NULL) NOT VALID;

-- "My orders", newest first. Replaces the lookup by email, which was the
-- client's claim rather than a verified identity.
CREATE INDEX idx_orders_customer_id ON orders (customer_id, created_at DESC);
DROP INDEX idx_orders_customer;
