export type OrderStatus =
  | 'PENDING'
  | 'SEATS_RESERVED'
  | 'PAYMENT_COMPLETED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLED'

export interface Order {
  id: string
  customer_email: string
  show_id: string
  total_amount: number
  status: OrderStatus
  created_at: Date
  updated_at: Date
}

export interface CreateOrderBody {
  customer_email: string
  show_id: string
  seat_ids: string[]   // array of show_seat_ids from inventory
  total_amount: number
}
