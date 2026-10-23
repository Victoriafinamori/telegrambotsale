CREATE TABLE IF NOT EXISTS platform_admins (
 firebase_uid text PRIMARY KEY CHECK(length(firebase_uid) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS merchant_accounts (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 email text NOT NULL UNIQUE CHECK(email=lower(email)),
 store_name text NOT NULL CHECK(length(store_name) BETWEEN 1 AND 80),
 channel text NOT NULL CHECK(channel IN ('whatsapp','telegram','discord','site','other')),
 reference text NOT NULL DEFAULT '' CHECK(length(reference)<=200),
 price_cents integer NOT NULL CHECK(price_cents BETWEEN 1 AND 10000000),
 firebase_uid text UNIQUE,
 purchase_confirmed_at timestamptz,
 access_status text NOT NULL DEFAULT 'pending' CHECK(access_status IN ('pending','approved','suspended')),
 approved_at timestamptz,
 suspension_reason text,
 billing_started_at timestamptz,
 paid_through timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((billing_started_at IS NULL)=(paid_through IS NULL))
);
CREATE TABLE IF NOT EXISTS merchant_invitations (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES merchant_accounts(id),
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS merchant_invitations_account_idx ON merchant_invitations(account_id);
CREATE TABLE IF NOT EXISTS platform_audit (
 id uuid PRIMARY KEY,
 actor_uid text NOT NULL,
 action text NOT NULL,
 account_id uuid REFERENCES merchant_accounts(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_created_idx ON platform_audit(created_at DESC);
CREATE TABLE IF NOT EXISTS api_rate_limits (
 bucket text PRIMARY KEY,
 hits integer NOT NULL,
 expires_at timestamptz NOT NULL
);
