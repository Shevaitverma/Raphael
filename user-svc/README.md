# user-svc (Go, :8081)

Owns `users` and `provider_credentials`, and therefore owns the provider secrets.
`api_key` is encrypted at rest with **AES-256-GCM** and is never returned by a public route.

## Run

```sh
export DATABASE_URL="postgresql://raphael:raphael@localhost:5433/raphael"
export USER_SVC_PORT=8081
# 32 raw bytes, base64. Generate once and put it in .env (never committed):
export CREDENTIAL_ENC_KEY="$(openssl rand -base64 32)"
go run .
```

The service **refuses to boot** if `CREDENTIAL_ENC_KEY` is missing or does not decode to 32 bytes.

## Routes

Public (never expose a key):

| method | path | notes |
|---|---|---|
| GET  | `/healthz` | `{"status":"ok","deps":{"postgres":"ok"}}` |
| GET  | `/users/{uid}/credentials` | list, no key field |
| POST | `/users/{uid}/credentials` | `{provider,auth_type,api_key?,base_url?,model_id,activate}` |
| POST | `/users/{uid}/credentials/{id}/activate` | flips `is_active`; deactivates the others first |

Internal (return the **decrypted** key — not reachable from the gateway's public paths):

| method | path | notes |
|---|---|---|
| GET | `/internal/users/{uid}/credential/active` | `{provider,auth_type,api_key,base_url,model_id}`, or 409 if none active |
| GET | `/internal/users/{uid}/credential/lifeboat` | the user's `provider='local'` row, or `204 No Content` |

## Constraints surfaced as clean 409s

The DB enforces one active credential per user, one row per `(user,provider)`, and
`oauth` only on `anthropic`. Violations return **409**, not 500. `oauth`+non-anthropic is
also rejected in-service before hitting the DB.

## Test

```sh
go test ./...   # needs Postgres on :5433; DB tests skip if it is unreachable
```

Covered: AES-GCM roundtrip, boot rejects a bad key, a public response never contains the
plaintext key, activating a second credential deactivates the first, duplicate-provider and
oauth-misuse 409s, and the lifeboat 200/204 paths.
