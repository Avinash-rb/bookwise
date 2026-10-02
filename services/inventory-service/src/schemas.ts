import { Type } from '@fastify/type-provider-typebox'

// Request/response contracts. Fastify validates every request against these
// (bad input -> 400 before our handler runs) and TypeBox derives the TS types
// from the same definitions, so the runtime check and the type can't drift.

export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

export const CreateMovieBody = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 255 }),
  duration_mins: Type.Integer({ minimum: 1, maximum: 600 }),
  language: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  genre: Type.Optional(Type.String({ maxLength: 100 })),
  rating: Type.Optional(Type.String({ maxLength: 10 })),
})

export const CreateTheatreBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  city: Type.String({ minLength: 1, maxLength: 100 }),
  address: Type.String({ minLength: 1, maxLength: 1000 }),
})

export const SeatType = Type.Union([
  Type.Literal('REGULAR'),
  Type.Literal('PREMIUM'),
  Type.Literal('RECLINER'),
])

export const CreateScreenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  rows: Type.Integer({ minimum: 1, maximum: 26 }), // row labels A..Z
  seatsPerRow: Type.Integer({ minimum: 1, maximum: 50 }),
  seatType: Type.Optional(SeatType),
})

export const ListShowsQuery = Type.Object({
  movieId: Type.Optional(Type.String({ format: 'uuid' })),
})

export const CreateShowBody = Type.Object({
  movie_id: Type.String({ format: 'uuid' }),
  screen_id: Type.String({ format: 'uuid' }),
  start_time: Type.String({ format: 'date-time' }),
  price: Type.Number({ exclusiveMinimum: 0 }),
})

// Seat map response. Declaring it means Fastify serialises ONLY these fields:
// internal columns such as reserved_by_order can never leak to customers.
// Money stays a decimal string (Postgres NUMERIC) to avoid float rounding.
const SeatView = Type.Object({
  show_seat_id: Type.String(),
  status: Type.String(),
  row_label: Type.String(),
  seat_number: Type.Integer(),
  seat_type: Type.String(),
  price: Type.String(),
})

export const SeatMapResponse = Type.Object({
  show_id: Type.String(),
  total: Type.Integer(),
  available: Type.Integer(),
  seats_by_row: Type.Record(Type.String(), Type.Array(SeatView)),
})

// ── Saga endpoints (called by the order service) ─────────────
export const ReserveSeatsBody = Type.Object({
  seat_ids: Type.Array(Type.String({ format: 'uuid' }), {
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
  }),
  order_id: Type.String({ format: 'uuid' }),
})

export const OrderRefBody = Type.Object({ order_id: Type.String({ format: 'uuid' }) })
