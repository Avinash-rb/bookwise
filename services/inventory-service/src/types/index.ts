// ── Movie ────────────────────────────────────────────────
export interface Movie {
  id: string
  title: string
  duration_mins: number
  language: string
  genre?: string
  rating?: string
  created_at: Date
}

export interface CreateMovieBody {
  title: string
  duration_mins: number
  language?: string
  genre?: string
  rating?: string
}

// ── Theatre / Screen / Seat ──────────────────────────────
export interface Theatre {
  id: string
  name: string
  city: string
  address: string
  created_at: Date
}

export interface CreateTheatreBody {
  name: string
  city: string
  address: string
}

export interface CreateScreenBody {
  name: string
  rows: number      // e.g. 10 rows
  seatsPerRow: number  // e.g. 15 seats per row
  seatType?: string    // REGULAR / PREMIUM / RECLINER
}

// ── Show ─────────────────────────────────────────────────
export interface Show {
  id: string
  movie_id: string
  screen_id: string
  start_time: Date
  end_time: Date
  price: number
  created_at: Date
}

export interface CreateShowBody {
  movie_id: string
  screen_id: string
  start_time: string   // ISO string
  price: number
}

// ── Show Seat (availability view) ────────────────────────
export interface ShowSeat {
  id: string
  show_id: string
  seat_id: string
  row_label: string
  seat_number: number
  seat_type: string
  status: 'AVAILABLE' | 'RESERVED' | 'BOOKED'
  price: number
}
