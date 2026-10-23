CREATE TABLE IF NOT EXISTS merchant_bot_setup (
 account_id uuid PRIMARY KEY REFERENCES merchant_accounts(id),
 bot_id text NOT NULL UNIQUE CHECK(bot_id ~ '^[1-9][0-9]{4,15}$'),
 bot_username text NOT NULL CHECK(length(bot_username) BETWEEN 1 AND 64),
 telegram_user_id text NOT NULL CHECK(telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
 token_ciphertext text NOT NULL,
 submitted_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
