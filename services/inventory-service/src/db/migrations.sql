-- ─────────────────────────────────────────────────────────
-- BookWise Inventory Service DB
-- Owns: theatres, screens, movies, shows, seats
-- ─────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Theatres ─────────────────────────────────────────────
CREATE TABLE theatres (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) NOT NULL,
  city        VARCHAR(100) NOT NULL,
  address     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Screens ──────────────────────────────────────────────
-- A theatre has multiple screens (Screen 1, IMAX, 4DX)
CREATE TABLE screens (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  theatre_id   UUID NOT NULL REFERENCES theatres(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,   -- "Screen 1", "IMAX"
  total_seats  INTEGER NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Seats ─────────────────────────────────────────────────
-- Physical seats in a screen (Row A Seat 1)
-- Seat status per show is tracked in show_seats, not here
CREATE TABLE seats (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  screen_id    UUID NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  row_label    VARCHAR(5) NOT NULL,     -- "A", "B", "C"
  seat_number  INTEGER NOT NULL,        -- 1, 2, 3
  seat_type    VARCHAR(20) NOT NULL DEFAULT 'REGULAR',
                                        -- REGULAR / PREMIUM / RECLINER
  UNIQUE(screen_id, row_label, seat_number)
);

-- ── Movies ───────────────────────────────────────────────
CREATE TABLE movies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title           VARCHAR(255) NOT NULL,
  duration_mins   INTEGER NOT NULL,
  language        VARCHAR(50) NOT NULL DEFAULT 'English',
  genre           VARCHAR(100),
  rating            VARCHAR(10),          -- "U", "UA", "A"
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Shows ────────────────────────────────────────────────
-- A movie playing at a specific screen at a specific time
CREATE TABLE shows (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  movie_id    UUID NOT NULL REFERENCES movies(id),
  screen_id   UUID NOT NULL REFERENCES screens(id),
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  price       NUMERIC(10, 2) NOT NULL,  -- base price per seat
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Show Seats ────────────────────────────────────────────
-- Status of each seat for each show (THIS is where the lock contention happens)
-- One row per (show, seat) combination
CREATE TABLE show_seats (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  show_id           UUID NOT NULL REFERENCES shows(id),
  seat_id           UUID NOT NULL REFERENCES seats(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
                    -- AVAILABLE / RESERVED / BOOKED
  reserved_by_order UUID,               -- which order reserved this seat
  reserved_at       TIMESTAMPTZ,        -- when reservation started (for TTL)
  UNIQUE(show_id, seat_id)              -- one status per (show, seat) pair
);

-- ── Indexes ───────────────────────────────────────────────
CREATE INDEX idx_shows_movie_id    ON shows(movie_id);
CREATE INDEX idx_shows_screen_id   ON shows(screen_id);
CREATE INDEX idx_show_seats_show   ON show_seats(show_id);
CREATE INDEX idx_show_seats_status ON show_seats(show_id, status);
CREATE INDEX idx_screens_theatre   ON screens(theatre_id);
CREATE INDEX idx_seats_screen      ON seats(screen_id);
