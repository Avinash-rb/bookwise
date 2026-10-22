-- Reservations expire: a held seat goes back on sale if the booking isn't
-- confirmed in time (abandoned checkout, crashed saga, slow payment).
ALTER TABLE show_seats ADD COLUMN reserved_until TIMESTAMPTZ;

-- Seats left RESERVED by the old synchronous saga (crashed mid-booking) never
-- had an expiry; give them one so the sweeper frees them.
UPDATE show_seats
  SET reserved_until = reserved_at + interval '10 minutes'
  WHERE status = 'RESERVED';

-- The sweeper's query: "RESERVED seats whose hold has run out". Partial index:
-- only the (few) currently reserved seats are indexed, not every seat ever sold.
CREATE INDEX idx_show_seats_expiry ON show_seats (reserved_until)
  WHERE status = 'RESERVED';
