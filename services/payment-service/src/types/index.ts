export type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED'

export interface Payment {
  id: string
  order_id: string
  amount: number
  status: PaymentStatus
  provider_reference?: string
  created_at: Date
  updated_at: Date
}

export interface ProcessPaymentBody {
  order_id: string
  amount: number
  idempotency_key: string  // = order_id (sent by saga)
}
