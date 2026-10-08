import { type Caller, forbidden, notFound, type Pool, type PoolClient } from '@bookwise/common'

type Db = Pool | PoolClient

// Ownership (a decision only this service can make, because it needs our data):
// a vendor manages only their own theatres; an admin manages any, including
// legacy theatres that have no owner.
export function canManageTheatre(caller: Caller, vendorId: string | null): boolean {
  return caller.role === 'admin' || (caller.role === 'vendor' && vendorId === caller.id)
}

// Theatres are publicly listed, so "not yours" is a 403: hiding them with a
// 404 would protect nothing. (Orders are private, so they use 404 instead.)
function assertCanManage(caller: Caller, row: { vendor_id: string | null } | undefined, what: string) {
  if (!row) throw notFound(`${what} not found`)
  if (!canManageTheatre(caller, row.vendor_id)) throw forbidden('You can only manage your own theatres')
}

export async function assertOwnsTheatre(db: Db, caller: Caller, theatreId: string) {
  const { rows } = await db.query<{ vendor_id: string | null }>(
    'SELECT vendor_id FROM theatres WHERE id = $1',
    [theatreId],
  )
  assertCanManage(caller, rows[0], 'Theatre')
}

// A screen belongs to a theatre, so the owner is found through it.
export async function assertOwnsScreen(db: Db, caller: Caller, screenId: string) {
  const { rows } = await db.query<{ vendor_id: string | null }>(
    `SELECT t.vendor_id FROM screens s JOIN theatres t ON t.id = s.theatre_id WHERE s.id = $1`,
    [screenId],
  )
  assertCanManage(caller, rows[0], 'Screen')
}
