-- Theatres belong to a vendor: the user id of a vendor account in auth-service.
-- No foreign key, because users live in another service's database.
ALTER TABLE theatres ADD COLUMN vendor_id UUID;

-- Every NEW (or updated) theatre must have an owner. NOT VALID skips checking
-- the rows that already exist: they were created before ownership existed and
-- have no known owner, so a plain NOT NULL would fail. It also avoids a full
-- table scan while holding a lock, which matters on a big live table.
-- Those legacy theatres can only be managed by an admin.
ALTER TABLE theatres
  ADD CONSTRAINT theatres_vendor_required CHECK (vendor_id IS NOT NULL) NOT VALID;

-- "My theatres" for the vendor dashboard.
CREATE INDEX idx_theatres_vendor ON theatres (vendor_id);
