-- Raphael — migration 013: Google Sign-In auth + admin/member RBAC.
--
-- Idempotent. Safe twice. db/ is mounted at /docker-entrypoint-initdb.d, which
-- runs ONLY on an empty volume, so an existing pgdata volume never sees this
-- file — apply it by hand:
--   docker exec -i raphael_db psql -U raphael -d raphael < db/013_auth_rbac.sql
--
-- Smallest additive schema for the auth/RBAC feature:
--   * users.role       — 'admin' | 'member' (default 'member'; fail-closed).
--   * users.google_sub — stable Google account id, set on first Google login,
--                        gives find-or-create-by-sub. UNIQUE so one Google
--                        account maps to exactly one Raphael user. (Distinct
--                        from google_credentials.google_sub, which audits the
--                        connected CALENDAR account; this is the LOGIN identity.)
--   * allowed_emails   — the invite allowlist. Adding an email IS the invite
--                        (spec: no emails sent). One row per permitted email.
--
-- Reuses the existing UNIQUE(email) on users for first-login email-linking, so
-- an existing account (incl. DEV_UID when its email matches) is LOGGED INTO,
-- never duplicated. No DROP/TRUNCATE, no down. Never deletes a row.

-- (a) role: fail-closed default 'member'. Bootstrap/admin promotion is code + (d).
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member'));

-- (b) google_sub: nullable, set on first Google login. UNIQUE for find-by-sub.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;

-- (c) allowlist. added_by is the admin who invited (nullable: bootstrap/seed).
CREATE TABLE IF NOT EXISTS allowed_emails (
    email       text PRIMARY KEY,
    added_by    uuid REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- (d) DEV_UID is the human's REAL account. The ONLY write to it: promote to
-- admin. Additive UPDATE of the new column only — never a DELETE, never touches
-- its data. Idempotent.
UPDATE users SET role = 'admin'
WHERE id = '00000000-0000-0000-0000-000000000001';

-- (e) System config owner. A SEPARATE seeded row (NOT DEV_UID) whose
-- provider_credentials ARE the system-wide provider config the resolver reads
-- for every user. Fixed sentinel uuid so code can target it (SYSTEM_CONFIG_UID).
INSERT INTO users (id, email, name, role)
VALUES ('00000000-0000-0000-0000-000000000002', 'system@raphael.local',
        'System Config', 'admin')
ON CONFLICT DO NOTHING;

-- Its active local Ollama row — mirrors the 001_init seed (base_url NULL: "local"
-- is an env concern, OLLAMA_BASE_URL) — so the system is never left with no
-- active credential. Keyed to ...002, so DEV_UID's own credentials are untouched.
INSERT INTO provider_credentials (user_id, provider, auth_type, model_id, is_active)
VALUES ('00000000-0000-0000-0000-000000000002', 'local', 'api_key',
        'qwen2.5:7b', true)
ON CONFLICT (user_id, provider) DO NOTHING;
