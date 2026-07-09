# Agentic AI Personal Assistant - Development Plan

## Tech Stack

- Frontend: Next.js + TypeScript + Tailwind + shadcn/ui
- API Gateway: Go (Fiber/Gin)
- Agent Orchestrator: Python FastAPI + LangGraph + Pydantic AI
- Model Layer: Anthropic SDK (Claude) + OpenAI-compatible SDK (OpenRouter / Ollama)
- Database: PostgreSQL + pgvector
- Cache/Queue: Redis
- Communication: gRPC + HTTP + WebSocket
- Infrastructure: AWS ECS + Terraform + Docker


## High Level Architecture

Next.js Web Application
        |
        |
Go API Gateway
        |
--------------------------------
|              |               |
User/Auth   Conversation   Agent Orchestrator
Service       Service          (Python)
                                |
                         LangGraph Engine
                                |
             ---------------------------------------
             |                  |                  |
        Memory Engine     Model Router      Tool Executor
             |                  |                  |
         pgvector               |         Gmail/Calendar/Web/etc
                                |
             -------------------------------------
             |                  |                |
          Claude           OpenRouter          Ollama
       (Anthropic API)   (hosted OSS)     (local machine)


The Memory Engine does not talk to pgvector alone - it asks the Model Router
for an embedding first. See Phase 4.


## Phase 1 - Core Platform

### Frontend

Tasks:

- Setup Next.js project
- Authentication pages
- Chat interface
- Agent activity UI
- Settings dashboard
- Integration management UI
- Model provider settings - one picker. Paste a key, choose a model,
  test connection before saving. Embeddings need no configuration.


### API Gateway (Go)

Responsibilities:

- Authentication middleware
- JWT validation
- Rate limiting
- Request routing
- WebSocket connections
- Streaming responses
- Logging
- OpenTelemetry tracing


Recommended:

Go Fiber
JWT
Redis
gRPC


## Phase 2 - Backend Services


### User Service (Go)

Responsibilities:

- User profiles
- OAuth connections
- Preferences
- Model provider credentials


Database:

users
- id
- email
- name
- created_at


### Conversation Service (Go)

Responsibilities:

- Store chats
- Retrieve history
- Manage sessions


Tables:

conversations

- id
- user_id
- title
- created_at


messages

- id
- conversation_id
- role
- content
- tool_calls
- created_at

content and tool_calls are vendor-neutral. No provider tool-call ids, no
thinking blocks, no cache markers. See Provider Independence.


## Phase 3 - Agent System


Agent Service Stack:

Python 3.12
FastAPI
LangGraph
Pydantic AI
uv


Structure:

agent-service/

src/
 ├── main.py
 ├── agents/
 │    ├── planner.py
 │    └── executor.py
 │
 ├── graph/
 │    ├── workflow.py
 │    └── nodes.py
 │
 ├── llm/
 │    ├── base.py
 │    ├── anthropic_api.py
 │    ├── anthropic_cli.py
 │    ├── openai_compat.py
 │    ├── embeddings.py
 │    └── resolver.py
 │
 ├── tools/
 │    ├── gmail.py
 │    ├── calendar.py
 │    └── browser.py
 │
 ├── memory/
 │    ├── retriever.py
 │    └── embeddings.py
 │
 └── config/


## Agent Workflow


User Request

↓

Planner Agent

↓

Tool Selection

↓

Executor Agent

↓

Memory Update

↓

Response


Planner and Executor never import a vendor SDK. They call the Model Router.


## Harness Decision


A harness is the agent loop: call the model, run the tool it asked for, feed the
result back, repeat. Anthropic ships three. All three are Claude only.

Tool Runner        anthropic SDK, client.beta.messages.tool_runner
                   Supplies the loop. You host it. Tools you define.

Managed Agents     anthropic SDK, client.beta.agents / sessions
                   Anthropic runs the loop AND hosts a per-session container
                   with bash, file ops, code execution. Beta.

Claude Agent SDK   separate package, claude-agent-sdk
                   Claude Code as a library. Built-in file and bash tools.
                   Supplies the loop. You host it.


None of them accept an Ollama or OpenRouter endpoint. There is no base_url
that makes them talk to a local model.

LangGraph is also a harness. Two harnesses cannot both own the loop.


Decision: LangGraph owns the loop. Claude is a provider.

The Anthropic adapter exposes chat() and stream() over
client.messages.create(). It does not use the Tool Runner, Managed Agents, or
the Agent SDK. The tool loop lives in graph/nodes.py and runs identically on
Claude, OpenRouter, and Ollama.

What this costs:
- No Anthropic-hosted sandbox. We run tools ourselves.
- No Managed Agents scheduled deployments. Phase 7 workers are ours to build.

What this buys:
- One loop. One set of tool definitions. One set of bugs.
- Swapping the brain changes no agent code.
- The agent behaves the same whether or not a Claude token exists, which is
  the entire point of this design.

Revisit only if the local-model path is ever dropped.


Prior art - ai.metastart.friday

That codebase runs the Claude Agent SDK as its harness. It is the road we did
not take, and it is worth being honest about what it gives you for free that we
now have to build:

- Built-in Read / Write / Edit / Bash / Glob / Grep / WebSearch tools.
- Subagents. AgentDefinition objects loaded from data/agents/*.md.
- MCP servers. An in-process one holding 155 custom tools, plus external ones.
- A permission gate. can_use_tool -> PermissionResultAllow / Deny, which they
  use to sandbox file writes and block dangerous Bash.
- Native session resume across restarts.

Every one of those is real work we are signing up for in graph/nodes.py.

What it costs friday, and what we avoid:

- Claude only. There is no Ollama, no OpenRouter, no local model. Their chat
  brain cannot be swapped.
- The `claude` CLI binary must live in the image. Node too. The CLI refuses to
  run as root, so the container runs as a non-root user.
- One process-global token, mutated in os.environ by a token manager. Fine for
  a single-tenant deployment. Fatal for ours - see the note below.

friday is single-tenant and Claude-only by design, so the Agent SDK is the
right call there. We are multi-user and brain-agnostic, so it is the wrong call
here. Same SDK, different answer, because the requirements differ.

Two things from friday we are copying outright:
- Local in-process embeddings. Phase 5.
- MCP as the tool interface, if we can consume it from LangGraph. Worth a
  spike before we hand-roll 155 tool definitions a second time.


Per-user tokens: pass the key explicitly.

client = anthropic.Anthropic(api_key=cred.api_key)

Never let the SDK fall back to the ANTHROPIC_API_KEY process env in a
multi-user service. An unset key does not mean no credentials - the SDK also
reads ANTHROPIC_AUTH_TOKEN and an on-disk auth profile, so one user's request
can silently bill whatever key the host happens to have.


## Phase 4 - Model Provider Layer


Goal:

Claude when a Claude token is present. Open source or a local model when it is not.
The agent code does not change either way.


Two protocols, in src/llm/base.py:

ChatProvider
- chat(messages, tools) -> response
- stream(messages, tools) -> chunks

EmbeddingProvider
- embed(texts) -> vectors


Four adapters:

anthropic_api.py    Claude     pip install anthropic
                    api key    client = anthropic.Anthropic(api_key=key)
                               client.messages.create(...)
                               Full ChatProvider. Native tool calling.

anthropic_cli.py    Claude     pip install claude-agent-sdk
                    OAuth      async for msg in query(prompt=..., options=...)
                               Completion only. See the caveat below.

openai_compat.py    OpenRouter pip install openai
                    Ollama     client = OpenAI(base_url=url, api_key=key)
                               client.chat.completions.create(...)
                               Full ChatProvider. Native tool calling.

embeddings.py       local      pip install sentence-transformers
                               model.encode(texts) -> 768-dim vectors
                               No API. No key. No network.


Base URLs:

OpenRouter   https://openrouter.ai/api/v1
Ollama       http://localhost:11434/v1


Claude models:

claude-opus-4-8     default
claude-sonnet-5     cheaper, high volume
claude-haiku-4-5    fast, simple tasks

Send thinking={"type": "adaptive"} and output_config={"effort": "high"}.
Stream when max_tokens goes above ~16000 or the request will hit an HTTP timeout.


Important - Anthropic has no embeddings endpoint.

The Messages API is the whole surface. There is no /v1/embeddings. Claude can
never serve an embedding, whatever token you hold.

We do not solve this with a provider. We solve it by not needing one.
Embeddings run in-process: sentence-transformers loading
nomic-ai/nomic-embed-text-v1.5, 768 dims, CPU, no network. Memory therefore
works for every user, no matter which chat brain they configured, with nothing
to set up and nothing to fail.

Cost: roughly 200MB of CPU-only torch in the image, and the model weights.
Worth it. The alternative was a second credential, a second failure mode, and a
Settings screen explaining why memory silently stopped working.

This is not a guess. ai.metastart.friday does exactly this today -
stealth/embeddings.py, nomic-embed-text-v1.5, 768 dims, into pgvector on pg17,
with the comment "no API calls, no cost, ~20ms per text on CPU".


Do not point the anthropic SDK's base_url at Ollama. That parameter expects an
Anthropic-compatible endpoint. Local and hosted OSS models go through the
openai SDK.


Two kinds of Claude token, and they are not interchangeable.

api_key    sk-ant-... from the console. Metered, billed per token.
           Works on every model through client.messages.create().
           This is the good path. Prefer it.

oauth      CLAUDE_CODE_OAUTH_TOKEN, a Claude Code subscription token.
           Raw Messages-API calls with it are throttled: Opus and Sonnet
           return 429, only Haiku gets through. Full model access requires
           going through the claude-agent-sdk / CLI door.

Evidence, from ai.metastart.friday/stealth/llm_direct.py:

  the subscription CLAUDE_CODE_OAUTH_TOKEN gets full model access through the
  claude-agent-sdk / CLI door (the same path the chat agent uses), whereas raw
  Messages-API calls with that token are throttled on the big models -
  Opus/Sonnet return 429, only Haiku slips through.


Caveat on the OAuth adapter. Read this before choosing it.

claude-agent-sdk is a harness. We only want a completion. So anthropic_cli.py
uses query() with tools disabled and max_turns=1 and pulls the text out - the
same trick friday uses in llm_direct.call_json. That works, but:

- It is completion-only. It does not give LangGraph native tool_use blocks.
  Tool calling on this path means prompting for JSON and parsing it, which is
  strictly worse than the api_key path.
- It spawns a `claude` CLI subprocess per call. Latency and process overhead.
- It needs the CLI binary in the image: npm install -g @anthropic-ai/claude-code,
  plus Node. The CLI refuses to run as root, so the container needs a non-root
  user. friday's Dockerfile does all three.

So: api_key is the supported path. oauth is a convenience for people who
already pay for Claude Code and accept degraded tool calling.
If we ever have to cut scope, cut oauth.


Resolution:

Only chat is resolved. Embeddings are in-process and always available, so they
have no credential and no failure mode.

Selection has no precedence and no chain. The user picks. The resolver reads
their one active credential. The lifeboat below is an error path, not a
preference ordering - it never runs while the chosen credential works.

resolver.chat(user) -> ChatProvider
resolver.embed()    -> EmbeddingProvider   always the local one

  anthropic + api_key   -> anthropic_api.py
  anthropic + oauth     -> anthropic_cli.py
  openai_compat         -> openai_compat.py, base_url = OpenRouter
  local                 -> openai_compat.py, base_url = Ollama
  no active row         -> agent disabled, UI asks for a key

Two failure classes. They are not the same and must not be treated the same.

Temporary fault - the credential is fine, the provider is not.
  429 rate limit, 5xx, timeout, connection error.
  -> The request errors. Retry or wait. We do not answer with a different
     model at a different cost and quality and say nothing about it.

Permanent fact - the credential is dead.
  401 authentication_error, 403 permission_error, 403 billing_error,
  402 where the provider uses it.
  -> The lifeboat fires. See below.


The lifeboat:

resolver.lifeboat(user) -> the user's provider = local row, if they have one
                           and it is not already the active credential

  try:
      return resolver.chat(user).chat(messages, tools)
  except (AuthenticationError, PermissionDeniedError, InsufficientCredits):
      lifeboat = resolver.lifeboat(user)
      if lifeboat is None:
          raise
      resp = lifeboat.chat(messages, tools)
      resp.degraded = "Claude credential rejected. Answered by local llama3.1."
      return resp

Rules:

- Only on a dead credential. Never on 429, never on 5xx, never on a timeout.
- Never silent. resp.degraded is set, the UI shows a banner, and the turn is
  written to the conversation with the model that actually answered it.
- The lifeboat does not change is_active. The user's configuration is theirs.
  We do not quietly move them to a local model and let them find out in a week.
- No lifeboat configured means the request errors, same as before.

Your Claude key expiring, or an unpaid OpenRouter bill, must not take the
assistant down. It should make it visibly dumber until you fix the bill.


Table:

provider_credentials

- id
- user_id
- provider         anthropic | openai_compat | local
- auth_type        api_key | oauth
- api_key_enc
- base_url
- model_id
- is_active
- is_lifeboat
- created_at

api_key_enc is encrypted at rest and never returned by the API. base_url is left
NULL for the local row: "local" means "the Ollama this deployment is configured
for" (OLLAMA_BASE_URL), which is env, not a stored per-credential host.

Exactly one active row per user, and at most one lifeboat, and they cannot be
the same row (falling back to the credential that just died is not a fallback):

  CREATE UNIQUE INDEX one_active_credential
    ON provider_credentials (user_id) WHERE is_active;
  CREATE UNIQUE INDEX one_lifeboat_credential
    ON provider_credentials (user_id) WHERE is_lifeboat;
  ALTER TABLE provider_credentials
    ADD CONSTRAINT active_is_not_lifeboat CHECK (NOT (is_active AND is_lifeboat));

auth_type = oauth is only valid when provider = anthropic. Reject it in the
service and add a CHECK so the database refuses it too.

At most one row per (user_id, provider), so a user may hold an inactive
credential (the lifeboat) alongside an active one. resolver.lifeboat() reads the
is_lifeboat row, NOT a hardcoded provider='local' — that is what makes the
guarantee hold in the cloud, where the lifeboat is an OpenRouter row, not a
localhost Ollama that does not exist on ECS.

Built: db/001_init.sql + db/002_lifeboat.sql.

Designating the lifeboat: user-svc exposes
  POST   /users/{uid}/credentials/{id}/lifeboat   (designate; 409 if the row is active)
  DELETE /users/{uid}/credentials/{id}/lifeboat   (clear)
proxied through the gateway as /api/providers/{id}/lifeboat, and driven from the
web Settings tab (list credentials, "Use this" to activate, "Set as fallback" /
"Clear fallback" to designate). Designating clears any prior lifeboat in the same
transaction; activating a row clears its own lifeboat flag. The active credential
can never also be the fallback.


## Provider Independence


The guarantee:

Three adapters. One brain. Swap the adapter and lose nothing.

If Claude expires, if the OpenRouter bill goes unpaid, if you unplug the
internet - the assistant keeps its memory, its history, its tools, and its
identity, and keeps running on a self-hosted model. No migration. No
re-embedding. No code change. Flip the active credential.

This is a requirement, not a nice-to-have. Everything below exists to make it
true.


Rule 1 - never persist a provider's wire format.

The moment you store what Anthropic handed you, your history is Anthropic
shaped and cannot be replayed to Ollama.

Postgres holds canonical, vendor-neutral records. Each adapter translates
canonical -> wire on the way out, and wire -> canonical on the way back in.
The wire format lives inside the adapter and dies there.

Specifically, these must never reach the database:

- Provider tool-call ids. Anthropic emits toolu_..., OpenAI-compatible
  emits call_.... Store our own id and map it inside the adapter.
- Thinking blocks. Claude returns thinking blocks with signatures. Replayed to
  another model they are dropped. Replayed to Claude after any edit they are
  rejected. They are transient. Never store them.
- Prompt cache breakpoints, compaction blocks, cache_control markers. All
  Anthropic-only. Adapter scratch space.
- Anything named after a vendor.


Rule 2 - the encoder ships with the app.

Already true, and it is the load-bearing decision. Embeddings are in-process.
If they came from OpenRouter, an unpaid bill would strand every vector in
memories: you keep the rows, but you can no longer produce a query vector in
the same space, so retrieval is dead and the knowledge is gone.

Because the encoder is ours, memories survives every provider change with zero
re-embedding. Losing Claude costs you reasoning quality. It must never cost you
memory.

Store the encoder's identity next to the vector so a future encoder change is a
migration and not an archaeology project:

memories

- id
- user_id
- content
- embedding          vector(768)
- embedding_model    e.g. nomic-embed-text-v1.5
- created_at


Rule 3 - messages are neutral.

messages

- id
- conversation_id
- role               user | assistant | tool
- content            text
- tool_calls         jsonb, neutral shape, nullable
- created_at

tool_calls uses our own shape, the same {name, arguments} the tool registry
speaks. Not Anthropic's tool_use block. Not OpenAI's tool_calls array. Ours.


Rule 4 - the graph asks what the provider can do.

Providers are not equal. The graph must branch on capability, not on hope.

ChatProvider.capabilities() -> Capabilities

  max_context_tokens    1_000_000 for Opus. Maybe 8_192 for a small local model.
  native_tools          True for anthropic_api and openai_compat.
                        False for anthropic_cli. Varies by local model.
  streaming             True everywhere we support.
  json_schema           True for structured output, else prompt-and-parse.

Two things follow immediately:

- Memory retrieval budgets against max_context_tokens of the ACTIVE provider.
  A retrieval sized for Claude's 1M window overflows a local 8k window on the
  exact turn you fall back to it. Size the budget at request time, never at
  boot.
- When native_tools is False, the tool loop asks for JSON and parses it. That
  is the degraded path. It works. It is worse. Ship it anyway, because the
  alternative is that the assistant stops working when the bill does.


Rule 5 - the fallback you never test is not a fallback.

CI runs the full agent suite against Ollama on every commit. Not a smoke test -
the same tests, the same tools, the same memory assertions.

Local is not a courtesy tier. It is the floor, and the floor has to hold on the
day the paid providers are gone. If it only ever runs the day you need it, it
will not run the day you need it.


Honest limits:

- Prompts tuned for Claude will underperform on a small local model. Reasoning
  quality degrades. That is the deal, and it is a good deal.
- anthropic_cli has no native tools, so the Claude OAuth path is already the
  degraded path. See Phase 4.
- Local models vary wildly at tool calling. Pin a model that can do it, and put
  its name in the config, not in someone's head.


## Phase 5 - Memory System


Stack:

PostgreSQL + pgvector


Memory Flow:

Message
 |
Model Router
 |
Embedding Model
 |
Vector Database
 |
Semantic Retrieval
 |
Agent Context


Table:

memories

- id
- user_id
- content
- embedding          vector(768)
- embedding_model    nomic-embed-text-v1.5
- created_at


The Memory Engine calls resolver.embed(). That is always the in-process
sentence-transformers model, so it cannot fail for want of a credential and it
never touches the chat provider. Claude cannot embed; nothing in this path
asks it to.

The embedding column is vector(768) for nomic-embed-text-v1.5.

The dimension is fixed by the embedding model. Changing the embedding model
means altering the column and re-embedding every row. Pick one and pin it.
Store the model name next to the vector if you ever expect to migrate.


## Phase 6 - Tools


Initial Tools:

- Gmail Agent
- Google Calendar Agent
- Google Drive Agent
- Web Search Agent
- GitHub Agent


Tool Format:

{
    name,
    description,
    parameters
}


Both adapters translate this to their own tool schema. Claude uses
input_schema. OpenAI-compatible models use parameters. Keep the plan's
neutral shape and convert inside the adapter.


## Phase 7 - Background Workers


Purpose:

Long running jobs:

Examples:

- Email monitoring
- Scheduled tasks
- Daily summaries


Architecture:

Agent

↓

Redis Stream

↓

Worker Service

↓

Notification


Workers resolve a provider the same way the request path does, using the
credentials of the user the job belongs to.


## Infrastructure


Containers. Every service has a Dockerfile; docker-compose.full.yml is the
whole stack (Postgres+pgvector, Redis, Ollama, the five services) on one network
with service-name DNS. This is the deployment artifact - ECS task definitions
and K8s manifests derive from it.

Images, as built:

gateway / user-svc / conv-svc   distroless static, non-root, ~20MB each
agent-svc                       python:3.13-slim + CPU torch + nomic weights
                                baked in, non-root, ~4.2GB
agent-svc Dockerfile.oauth      the same + Node + claude CLI, for the oauth path
web                             Next standalone, node:22-alpine, ~335MB

The agent image bakes the nomic-embed-text-v1.5 weights at BUILD time, so cold
start does zero network I/O (HF_HUB_OFFLINE=1 enforces it). ~4.2GB is heavy -
an optimization target (drop pip caches, thin the torch deps), not a blocker.

The oauth image carries Node + `npm install -g @anthropic-ai/claude-code` and
must run non-root (the CLI refuses root). The slim image omits it; the adapter
imports claude-agent-sdk lazily and errors clearly if oauth is selected without
it. Another reason api_key is the supported path.


AWS:

- CloudFront
- ALB
- ECS Fargate
- RDS PostgreSQL      (replaces the compose Postgres)
- ElastiCache Redis   (replaces the compose Redis)
- S3
- SQS


CI/CD:

GitHub Actions

Steps:

1. Test
2. Docker Build
3. Push Image to ECR
4. Deploy ECS Service


The lifeboat and the cloud. There is no localhost Ollama on ECS, so the cloud
lifeboat is an OpenRouter credential, not a local one - which is exactly why
resolver.lifeboat() reads is_lifeboat and not provider='local'. To keep a truly
self-hosted floor in the cluster, run the Ollama service (docker-compose.full.yml
has it) as an ECS service or K8s Deployment with a volume for the weights; a 7B
model on CPU Fargate is slow but real. In-process embeddings need no such thing -
they ride inside the agent image and work everywhere.


## MVP Roadmap


Week 1:

- Next.js UI
- Go Gateway
- Authentication
- Chat Service
- Basic Agent
- Claude provider
- Ollama provider


Week 2:

- LangGraph workflows
- Model Router + resolver
- provider_credentials + settings UI
- Local embeddings (sentence-transformers)
- Memory service
- pgvector
- Gmail integration


Week 3:

- Calendar
- Drive
- OpenRouter provider
- Background agents
- Monitoring


Future:

- React Native mobile app
- Voice assistant
- Multi-agent marketplace
- Custom user agents
