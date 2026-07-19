-- Raphael — migration 006: Google account connection (OAuth2 tokens).
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/006_google.sql
--
-- SEPARATE table, not provider_credentials: that table's CHECK restricts provider
-- to the model providers and oauth to anthropic, and it enforces one-active-
-- credential — none of which fit a Google account. The refresh token is the most
-- sensitive secret in the system (long-lived read access to the user's calendar),
-- so it is AES-256-GCM encrypted with the SAME CREDENTIAL_ENC_KEY / cryptor as
-- provider_credentials and is NEVER returned on a public route.
--
-- Scopes are deliberately no-CASA: calendar.readonly (sensitive, brand-verifiable,
-- NOT restricted) + openid/email/profile (non-sensitive). No Gmail, no broad Drive.
CREATE TABLE IF NOT EXISTS google_credentials (
    user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_enc       bytea NOT NULL,        -- crown jewel; never leaves user-svc
    access_token_enc        bytea,                 -- cached; refreshed on expiry
    access_token_expires_at timestamptz,
    scopes                  text[] NOT NULL DEFAULT '{}',  -- exactly what Google granted
    google_email            text,                  -- connected account, for display only
    google_sub              text,                  -- stable Google account id, for audit
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
