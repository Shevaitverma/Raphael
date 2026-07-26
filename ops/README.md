# Ops — running the stack and reading its logs

## Run the stack

```bash
./dev.sh            # infra + all five services
NO_WEB=1 ./dev.sh   # skip the Next.js UI
./stop.sh           # stop the host processes (containers untouched)
./stop.sh --all     # also stop postgres + redis containers
```

`dev.sh` sources `.env` **once** and exports it, so every service gets identical
config; force-frees ports 8080/8081/8082/8000/3000; waits for `raphael_db` to be
healthy; builds the Go binaries; starts `user-svc → conv-svc → gateway →
agent-svc → web`; then polls each service's `/health` (falling back to `/healthz`,
then a TCP probe) and prints an UP/FAILED summary.

Two things in there exist only to prevent bugs that already cost hours — do not
"simplify" them away:

- **web is started with `env -u NEXT_PUBLIC_GATEWAY_URL`.** A process env var
  beats `web/.env.local`, and an absolute `localhost:8080` baked into the client
  bundle breaks the same-origin proxy and tunnelled login.
- **agent-svc uses `agent-svc/.venv/bin/python -m uvicorn`**, run from
  `agent-svc/src`. Bare `python` is not on PATH here.

Each service's stdout+stderr lands in `logs/<service>.log` (gitignored). All four
backend services log **JSON lines** with a shared schema: `time`, `level`, `msg`,
`service`, and where applicable `request_id`, `user_id`, `method`, `path`,
`status`, `duration_ms`, `err`. Verbosity: `LOG_LEVEL` in `.env`.

## Tail the logs

```bash
./logs.sh                      # all services, one interleaved stream
./logs.sh gateway              # one service
./logs.sh gateway agent-svc    # a few
./logs.sh -n 200               # 200 lines of history first (default 20)
```

Every line is prefixed with its service. JSON lines are pretty-printed through
`jq` (`time LEVEL msg  key=val …`); non-JSON lines (Next.js output, Go panics,
Python tracebacks) pass through verbatim. Without `jq` installed everything is
raw — it never hard-fails. Colour is emitted only to a TTY, so pipes stay clean:

```bash
./logs.sh -n 5000 | grep 3f9c1a2b                  # one request, every service
./logs.sh | grep -E 'ERROR|"level":"error"'        # errors only
```

## Central log aggregation (Loki + Grafana + Alloy)

Opt-in, behind the `observability` compose profile — a plain `docker compose up`
is unchanged.

```bash
docker compose --profile observability up -d
docker compose --profile observability down     # stop just these
```

| Component | Image | URL |
|---|---|---|
| Grafana | `grafana/grafana:12.0.2` | <http://localhost:3001> |
| Loki | `grafana/loki:3.5.7` | <http://localhost:3100> |
| Alloy (shipper) | `grafana/alloy:v1.11.0` | <http://localhost:12345> (debug UI) |

**Grafana login:** `admin` / `raphael`. Override with `GRAFANA_USER` /
`GRAFANA_PASSWORD` in `.env` before first start. The Loki datasource is
pre-provisioned (`ops/grafana/provisioning/datasources/loki.yaml`) — no click-ops.
Go to **Explore → Loki**.

**Alloy, not Promtail:** Promtail is feature-frozen/EOL and Grafana's own
migration target is Alloy. Alloy tails the same host files in `logs/*.log` that
`dev.sh` writes (the services are host processes in local dev, not containers),
bind-mounted read-only at `/var/log/raphael`. Config: `ops/alloy/config.alloy`.

Persistence: named volumes `loki_data`, `grafana_data`, `alloy_data`. Retention
is 7 days (`ops/loki/loki-config.yaml`).

### Label scheme

Cardinality is the only thing that makes a Loki install slow, so the split is
deliberate:

| | Fields | Why |
|---|---|---|
| **Labels** (indexed, one stream per combination) | `service`, `level`, `job` | Bounded: ~6 services × 4 levels |
| **Structured metadata** (queryable, no new streams) | `request_id`, `user_id` | Unbounded — as labels they would create one stream per request/user and melt the index |
| **Line body** (parse at query time with `\| json`) | `method`, `path`, `status`, `duration_ms`, `err`, everything else | Cheap to filter, pointless to index |

`service` comes from the JSON `service` field, falling back to the log filename
(`logs/gateway.log` → `gateway`) so non-JSON output is still attributed.
`level` is lowercased, because Go emits `INFO` and Python emits `info`.

### Example queries

Trace one request across every service (this is the one that matters):

```logql
{job="raphael"} | request_id = "3f9c1a2b"
```

Errors only, everywhere:

```logql
{job="raphael", level="error"}
```

Every HTTP 5xx the gateway served, slowest fields visible:

```logql
{service="gateway"} | json | status >= 500
```

Slow requests (over 1s) in any service:

```logql
{job="raphael"} | json | duration_ms > 1000
```

Error rate per service over 5m (graph it):

```logql
sum by (service) (rate({job="raphael", level="error"}[5m]))
```

Everything one user did:

```logql
{job="raphael"} | user_id = "89dc1446-0284-46f2-875c-2994faa3b8ad"
```
