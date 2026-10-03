-- BookWise Auth Service DB
-- Owns: user accounts and refresh-token sessions.

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lower-cased so "A@x.com" and "a@x.com" can't become two accounts.
  email          VARCHAR(255) NOT NULL UNIQUE CHECK (email = lower(email)),
  -- Self-describing scrypt hash: scrypt$N$r$p$<salt>$<hash>. Never the password itself.
  password_hash  TEXT NOT NULL,
  full_name      VARCHAR(100) NOT NULL,
  role           VARCHAR(20) NOT NULL DEFAULT 'customer'
                 CHECK (role IN ('customer', 'vendor', 'admin')),
  -- Lets an admin disable an account without deleting its history.
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per refresh token ever issued. Every token from one login shares a
-- family_id; rotating a token marks it used and inserts its successor.
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   UUID NOT NULL,
  -- SHA-256 of the token. The token itself is never stored, so a DB leak
  -- doesn't hand out usable sessions.
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,              -- set when rotated (exchanged for a new one)
  revoked_at  TIMESTAMPTZ,              -- set on logout or when reuse is detected
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_tokens_user   ON refresh_tokens (user_id);
