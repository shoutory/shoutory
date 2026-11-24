-- These tables have no row security: the grants below are the whole defence (only shoutory_auth holds any privilege).
-- Every email is stored lower-case: the library lower-cases what it writes and looks up, and the CHECK refuses
-- any other writer.
CREATE TABLE auth."user" (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL,
  email text NOT NULL CHECK (email = lower(email)),
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  two_factor_enabled boolean DEFAULT false,
  UNIQUE (email)
);

-- ip_hmac holds the keyed digest of the client address, never the address itself.
CREATE TABLE auth.session (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_hmac text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE
);

CREATE TABLE auth.account (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.verification (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.two_factor (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  verified boolean,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);

-- shoutory:accepted-lock new empty table in this file
CREATE INDEX session_user_id_idx ON auth.session (user_id);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX account_user_id_idx ON auth.account (user_id);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX verification_identifier_idx ON auth.verification (identifier);
-- shoutory:accepted-lock new empty table in this file
CREATE INDEX two_factor_user_id_idx ON auth.two_factor (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  auth."user", auth.session, auth.account, auth.verification, auth.two_factor
  TO shoutory_auth;
