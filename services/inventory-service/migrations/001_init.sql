-- BookWise Inventory Service DB
-- Owns: theatres, screens, seats, movies, shows, show_seats.

CREATE TABLE theatres (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  city        VARCHAR(100) NOT NULL,
  address     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A theatre has several screens ("Screen 1", "IMAX").
CREATE TABLE screens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theatre_id   UUID NOT NULL REFERENCES theatres(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  total_seats  INTEGER NOT NULL CHECK (total_seats > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (theatre_id, name)
);

-- Physical seats in a screen. Per-show status lives in show_seats, not here.
CREATE TABLE seats (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id    UUID NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  row_label    VARCHAR(5) NOT NULL,
  seat_number  INTEGER NOT NULL CHECK (seat_number > 0),
  seat_type    VARCHAR(20) NOT NULL DEFAULT 'REGULAR'
               CHECK (seat_type IN ('REGULAR', 'PREMIUM', 'RECLINER')),
  UNIQUE (screen_id, row_label, seat_number)  -- also serves lookups by screen_id
);

CREATE TABLE movies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          VARCHAR(255) NOT NULL,
  duration_mins  INTEGER NOT NULL CHECK (duration_mins > 0),
  language       VARCHAR(50) NOT NULL DEFAULT 'English',
  genre          VARCHAR(100),
  rating         VARCHAR(10),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A movie playing on a specific screen at a specific time.
CREATE TABLE shows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movie_id    UUID NOT NULL REFERENCES movies(id),
  screen_id   UUID NOT NULL REFERENCES screens(id),
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

-- Status of each seat for each show: THIS is the row two customers fight over.
CREATE TABLE show_seats (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id            UUID NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seat_id            UUID NOT NULL REFERENCES seats(id),
  status             VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE'
                     CHECK (status IN ('AVAILABLE', 'RESERVED', 'BOOKED')),
  reserved_by_order  UUID,
  reserved_at        TIMESTAMPTZ,
  UNIQUE (show_id, seat_id),                -- also serves lookups by show_id
  -- A seat is held by an order exactly when it isn't AVAILABLE.
  CHECK ((status = 'AVAILABLE') = (reserved_by_order IS NULL))
);

CREATE INDEX idx_shows_movie            ON shows (movie_id, start_time);
CREATE INDEX idx_shows_screen           ON shows (screen_id);
CREATE INDEX idx_screens_theatre        ON screens (theatre_id);
CREATE INDEX idx_show_seats_order       ON show_seats (reserved_by_order)
  WHERE reserved_by_order IS NOT NULL;
