import type { Caller } from '@bookwise/common'

// A customer sees only their own orders; an admin sees all (including legacy
// orders from before ownership existed, which have no customer_id).
export const canViewOrder = (caller: Caller, customerId: string | null): boolean =>
  caller.role === 'admin' || (caller.role === 'customer' && customerId === caller.id)
