-- Raphael — migration 002: make the lifeboat portable across environments.
--
-- WHY THIS EXISTS
--
-- 001 defined the lifeboat implicitly as "the user's provider='local' row".
-- That works on a laptop. It does not exist in ECS or Kubernetes, where there
-- is no localhost Ollama — so the Provider Independence guarantee held only in
-- development. Containerising the app is what surfaced the hole.
--
-- The lifeboat is now an explicit, provider-agnostic designation:
--
--   laptop / self-host :  active = Claude       lifeboat = local Ollama
--   cloud              :  active = Claude       lifeboat = OpenRouter
--   fully offline      :  active = local Ollama lifeboat = none (nothing to fall back from)
--
-- resolver.lifeboat(user) no longer looks for provider='local'. It reads this flag.

-- STATUS: applied, together with the resolver and user-svc changes that read it.

ALTER TABLE provider_credentials
    ADD COLUMN IF NOT EXISTS is_lifeboat boolean NOT NULL DEFAULT false;

-- At most one designated lifeboat per user.
CREATE UNIQUE INDEX IF NOT EXISTS one_lifeboat_credential
    ON provider_credentials (user_id)
    WHERE is_lifeboat;

-- A credential cannot be both the brain and the fallback. If the active
-- credential is the one that died, falling back to it is not a fallback.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'active_is_not_lifeboat'
    ) THEN
        ALTER TABLE provider_credentials
            ADD CONSTRAINT active_is_not_lifeboat
            CHECK (NOT (is_active AND is_lifeboat));
    END IF;
END $$;

-- Note on the dev seed: 001 seeds the local Ollama row as ACTIVE, so it is not
-- a lifeboat and must not be. A lifeboat only matters once the active
-- credential is a paid provider that can be rejected. The integration test
-- deactivates local, activates an (invalid) anthropic row, and marks local as
-- the lifeboat — which is precisely the production shape.
