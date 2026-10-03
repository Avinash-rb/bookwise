import { Type } from '@fastify/type-provider-typebox'

const Email = Type.String({ format: 'email', maxLength: 255 })

// 8 chars minimum (OWASP); the 128 cap stops someone posting a 10 MB
// "password" to burn CPU in the hash function.
const Password = Type.String({ minLength: 8, maxLength: 128 })

export const RegisterBody = Type.Object({
  email: Email,
  password: Password,
  full_name: Type.String({ minLength: 1, maxLength: 100 }),
  // Public registration can create customers and vendors, never admins.
  role: Type.Optional(Type.Union([Type.Literal('customer'), Type.Literal('vendor')])),
})

export const LoginBody = Type.Object({
  email: Email,
  password: Type.String({ minLength: 1, maxLength: 128 }),
})

export const RefreshBody = Type.Object({
  refresh_token: Type.String({ minLength: 1, maxLength: 200 }),
})

const PublicUser = Type.Object({
  id: Type.String(),
  email: Type.String(),
  full_name: Type.String(),
  role: Type.String(),
})

// Response schemas whitelist output fields: even if a query accidentally
// selected password_hash, it could never be serialised to the client.
export const SessionResponse = Type.Object({
  user: PublicUser,
  access_token: Type.String(),
  token_type: Type.Literal('Bearer'),
  expires_in: Type.Integer(),
  refresh_token: Type.String(),
})

export const UserResponse = PublicUser
