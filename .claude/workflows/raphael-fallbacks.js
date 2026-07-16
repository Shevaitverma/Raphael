export const meta = {
  name: 'raphael-fallbacks',
  description: 'Design, implement and PROVE the degradation paths for a feature across every provider tier and failure mode',
  whenToUse: 'After (or alongside) building a feature, to make it honest on a 7B local model, an arbitrary OpenRouter model, a dead credential, a downed service, and a model that emits garbage. Pass the feature as args (a string), or {feature, mode} where mode is "plan" | "implement" | "both" (default "both"). Its center of gravity is the Prove phase: a fallback nobody has watched fire is a rumour.',
  phases: [
    { title: 'Enumerate', detail: 'map the failure surface — capabilities, services, model behavior, data' },
    { title: 'Design', detail: 'one fallback per failure mode, or an argued refusal to fall back' },
    { title: 'Judge', detail: 'one coherent degradation contract, file-owned work items' },
    { title: 'Implement', detail: 'one agent per work item, split by file ownership' },
    { title: 'Prove', detail: 'force each degraded condition and watch the fallback fire' },
    { title: 'Fix', detail: 'apply confirmed findings' },
  ],
}

const ROOT = '/Users/shevaitverma/Applications/shevait/Raphael'
const FEATURE = typeof args === 'string' ? args : (args && (args.feature || args.request)) || ''
const MODE = (args && args.mode) || 'both'

if (!FEATURE) {
  return { error: 'No feature given. Pass args as a string, or {feature, mode}.' }
}

const CONSTRAINTS = `
## Raphael standing constraints — these override any instinct you have

1. MICROSERVICES ARE INTENTIONAL. gateway(:8080) user-svc(:8081) conv-svc(:8082)
   agent-svc(:8000) web(:3000) + Postgres/pgvector(:5433) + Redis(:6379). NEVER propose
   merging or deleting a service.

2. PROVIDER PORTABILITY IS THE FOUNDING THESIS. Three paths — local(Ollama),
   openai_compat(OpenRouter), anthropic(Claude API + OAuth/CLI). Note anthropic is TWO
   adapters: api_key does native tools, oauth/CLI structurally CANNOT (max_turns=1,
   allowed_tools=[]). So "all three" is really four paths.
   Capability is a property of the MODEL, not the provider: OpenRouter serves both 8k
   Llamas and 1M Geminis, so per-provider constants are lies. Known live examples of
   exactly that lie: openai_compat.py reports native_tools via \`"qwen2.5" in model\`
   (so qwen3.5 silently loses tools), and hardcodes max_context_tokens=32768 for every
   model while Ollama's real default num_ctx is far smaller.

3. NO PROVIDER WIRE-FORMAT IN THE DATABASE, EVER. No toolu_/call_ ids, no thinking
   blocks, no cache_control. conv-svc/toolcalls.go validates the neutral shape at the
   write boundary; scripts/e2e.sh section 5 is the backstop. A fallback path must produce
   the SAME neutral rows as the native path — if it doesn't, the fallback is a wire-format
   leak wearing a disguise.

4. THE LIFEBOAT IS SACRED, AND IT IS NOT A CAPABILITY FALLBACK. Dead credential
   (401/402/403) -> visible fallback to the is_lifeboat credential + exactly one
   'degraded' SSE event; is_active is NEVER flipped. Transient fault (429/5xx/timeout)
   -> 'error' event, NO fallback, no state change. Do not overload 'degraded' to mean
   "your model can't do tools" — that is a different fact, and e2e asserts n_degraded==1
   on the lifeboat turn, so overloading it provably breaks a live test.

5. SSE CONTRACT: token / done / degraded / error. Adding an event is a protocol change.

6. SECRETS: .env is gitignored. Never commit it, never print a secret, never write one to
   a tracked file.

7. BE A LAZY SENIOR DEVELOPER. YAGNI. Deletion over addition. No interface with one
   implementation. Shortest working diff.

8. BUT NEVER LAZY ABOUT: understanding the problem, trust boundaries, error handling that
   prevents data loss, or security. Read the real code and trace the actual flow first.

9. Mark deliberate shortcuts with a 'ponytail:' comment naming the ceiling and upgrade path.

10. VERIFY, DON'T ASSERT. Cite file:line. If you did not read it, do not claim it. If a
    check fails, say so with the output.

11. NEVER VERIFY BY DESTROYING. Forcing a degraded condition must not delete or reset state
    the user did not name as disposable. Specifically forbidden: 'docker compose down -v'
    (it drops the pgdata volume holding real conversations, credentials, facts and memories),
    DROP/TRUNCATE on any table, deleting .env, and 'git checkout'/'git stash' over a working
    tree other agents are writing to. This phase FORCES FAILURES for a living, so the
    temptation is real and the rule is absolute: force a fault with a stub, a bad credential,
    an unreachable URL, or an env var — never by destroying the user's data. If a fallback
    can only be triggered by wiping something real, say you could not trigger it.
`

// The specific ways a fallback rots. This project has shipped every one of these.
const FALLBACK_DOCTRINE = `
## Fallback doctrine — the reason this workflow exists

A fallback is a promise about the worst day. Nobody watches it, so it rots silently and
you find out during the outage. Raphael and its reference implementation have shipped
EVERY failure below — treat them as live hazards, not theory:

- **The unreachable fallback.** A decay job archived rows at \`importance < 0.05\` while
  importance's algebraic floor was \`0.2 * confidence\` = 0.14. It could never fire. It ran
  for a year doing nothing and nothing told anyone. ALWAYS solve your predicate: can this
  branch be entered at all? Prove it with numbers, not vibes.
- **The half-wired handshake.** Storage helpers written, DB column added, consumer never
  wired, the write disabled — and the prompt still telling the model it worked. Either
  finish it or delete it. Never both-and-neither.
- **The vacuous test.** An assertion scanning a column nothing ever writes has never had a
  chance to fail. If your test passes against the UNFIXED code, it proves nothing. Every
  test this workflow adds must be confirmed FAILING first.
- **Silent degradation.** The cardinal sin. A capability quietly absent, a context window
  quietly truncated, an image quietly dropped, a memory quietly not stored. The user
  believes they got the real thing. Worse than an error, because an error can be seen.
- **The capability lie.** A hardcoded constant that claims more than the runtime has.
  Every optimistic wrong answer costs the TURN (a 400 mid-stream, a silent truncation).
  Every conservative wrong answer costs only quality. Be conservative, always.
- **The fallback nobody chose.** Building a prompt-and-parse rescue for a tier the plan
  already decided to cut. Effort in the wrong direction. Check whether the tier is one we
  actually promised.

## The three legitimate responses to a missing capability — pick one, per tier, explicitly

1. **DEGRADE** — do the thing worse, by a stated mechanism. (native tools -> prompted JSON)
2. **REFUSE** — do not do the thing, and SAY SO in the reply. Zero code. Often correct.
3. **FAIL** — surface an error. Correct when silently continuing would corrupt data or
   mislead. A transient provider fault is a FAIL, not a DEGRADE — that is rule 4.

"Works on all three" NEVER means identical behavior. It means: the turn completes, and
nothing lies to the user.
`

phase('Enumerate')
const SURFACE_SCHEMA = {
  type: 'object',
  properties: {
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          trigger: { type: 'string' },
          todayBehavior: { type: 'string' },
          silent: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['mode', 'trigger', 'todayBehavior', 'evidence'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['failures'],
}

const LENSES = [
  {
    key: 'capability',
    brief:
      'PROVIDER CAPABILITY ABSENCE. Read agent-svc/src/llm/ in full — base.py (the Capabilities ' +
      'dataclass), resolver.py, anthropic_api.py, anthropic_cli.py, openai_compat.py, embeddings.py. ' +
      'Enumerate every capability this feature depends on: context window size, native tool calling, ' +
      'JSON/structured output, streaming granularity, vision, embeddings. For EACH, across all FOUR ' +
      'paths (local, openai_compat, anthropic+api_key, anthropic+oauth): does the path have it, can ' +
      'Raphael DETECT whether it has it, and what happens today when it does not? Flag every hardcoded ' +
      'constant as a suspected lie and check it against what the runtime actually does.',
  },
  {
    key: 'infra',
    brief:
      'DEPENDENCY AND DATA ABSENCE. What does this feature need besides the model? Trace each: ' +
      'conv-svc down or slow, user-svc down, Postgres down, Redis down, the embedding model failing ' +
      'to load, a migration not applied, no active credential, no lifeboat configured, an empty result ' +
      'set. For each, what happens TODAY — read the actual except/error handling and say whether it ' +
      'swallows, degrades, or breaks the turn. Note especially anything that swallows an error that ' +
      'SHOULD surface, and anything that breaks a turn over a non-essential enhancement.',
  },
  {
    key: 'behavior',
    brief:
      'THE MODEL MISBEHAVING. Assume a 7B local model doing its worst: chatty preamble around JSON, ' +
      'markdown fences, trailing prose, truncated output, hallucinated fields, a tool call with ' +
      'malformed arguments, a model that CLAIMS a capability and then fails to use it, non-alternating ' +
      'roles, an empty response. For each: what does this feature do today, and can it tell the ' +
      'difference between "the model correctly found nothing" and "the model failed"? That distinction ' +
      'is where retry logic goes wrong — retrying a correct empty answer doubles cost to punish success.',
  },
]

const surface = await parallel(
  LENSES.map((l) => () =>
    agent(
      `Map the FAILURE SURFACE of a feature in Raphael at ${ROOT}.\n\nTHE FEATURE: "${FEATURE}"\n\n` +
        `${CONSTRAINTS}\n${FALLBACK_DOCTRINE}\n\n## YOUR LENS\n${l.brief}\n\n` +
        `Report ONLY what you verified in the real code, with file:line evidence. Do NOT design ` +
        `fallbacks — that is the next phase. For each failure mode set 'silent' to true if the user ` +
        `would NOT be able to tell it happened; those are the dangerous ones and the whole point of ` +
        `this exercise. If the feature is not yet built, say so and enumerate the failure surface the ` +
        `PLAN for it would have.`,
      { label: `enum:${l.key}`, phase: 'Enumerate', schema: SURFACE_SCHEMA },
    ),
  ),
)

const modes = surface.filter(Boolean).flatMap((s) => s.failures || [])
if (!modes.length) return { error: 'No failure modes enumerated', surface }
log(`${modes.length} failure modes found; ${modes.filter((m) => m.silent).length} are SILENT today`)

const surfaceText = modes
  .map((m, i) => `${i + 1}. [${m.silent ? 'SILENT' : 'visible'}] ${m.mode}\n   trigger: ${m.trigger}\n   today: ${m.todayBehavior}\n   evidence: ${m.evidence}`)
  .join('\n')

phase('Design')
const CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    tiers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          response: { type: 'string', enum: ['degrade', 'refuse', 'fail'] },
          mechanism: { type: 'string' },
          visibility: { type: 'string' },
          canItFire: { type: 'string' },
        },
        required: ['mode', 'response', 'mechanism', 'visibility', 'canItFire'],
      },
    },
    workItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          forceCondition: { type: 'string' },
          check: { type: 'string' },
        },
        required: ['title', 'detail', 'files', 'forceCondition'],
      },
    },
    notBuilding: { type: 'array', items: { type: 'string' } },
    effortHours: { type: 'number' },
  },
  required: ['approach', 'tiers', 'workItems', 'notBuilding'],
}

const DESIGNERS = [
  {
    key: 'minimal',
    brief:
      'REFUSE BEFORE YOU DEGRADE. Every degrade path is permanent maintenance for a worse version ' +
      'of the feature. A refusal is zero code and honest. For each failure mode, argue hard for ' +
      'REFUSE, and only concede DEGRADE when the tier genuinely matters and the mechanism is small. ' +
      'Your notBuilding list should be long, each entry with the concrete trigger that would justify ' +
      'it later. Ask of every proposed fallback: has anyone actually promised this tier?',
  },
  {
    key: 'honest',
    brief:
      'VISIBILITY ABOVE ALL. Hunt silent degradation. For every mode, answer precisely: how does the ' +
      'user find out? Weigh the real options — an SSE event (but rule 4: degraded is taken and ' +
      'overloading it breaks a live assertion), text in the reply itself, a field on the done payload, ' +
      'a queryable /capabilities endpoint, a log line nobody reads (that is not visibility). Prefer ' +
      'making the fact QUERYABLE and self-describing over announcing it, unless the user must act on ' +
      'it mid-turn. A degrade the user cannot detect is a lie with extra steps.',
  },
  {
    key: 'adversary',
    brief:
      'ASSUME THE FALLBACK IS BROKEN. For each mode you design, immediately attack it: can the branch ' +
      'be entered AT ALL — solve the predicate algebraically and show your work. Can it be forced in a ' +
      'test? What does the fallback do when IT fails? Does it double a side effect (re-running a tool ' +
      'that already wrote to the DB is data corruption dressed as resilience)? Does it produce the ' +
      'same neutral DB rows as the native path? Does the lifeboat interact with it — the lifeboat ' +
      'model may have DIFFERENT capabilities than the credential that just died, and mid-turn ' +
      'transcripts are NOT portable across providers. Name every fallback you cannot force in a test; ' +
      'that is a fallback that will rot.',
  },
]

const designs = await parallel(
  DESIGNERS.map((d) => () =>
    agent(
      `Design the DEGRADATION CONTRACT for a feature in Raphael at ${ROOT}.\n\nTHE FEATURE: "${FEATURE}"\n\n` +
        `${CONSTRAINTS}\n${FALLBACK_DOCTRINE}\n\n` +
        `## The verified failure surface (confirm anything you rely on)\n${surfaceText}\n\n` +
        `## YOUR LENS\n${d.brief}\n\n` +
        `For EVERY failure mode above, choose degrade / refuse / fail and justify it. 'visibility' must ` +
        `say concretely how the user learns it happened (or argue why they need not). 'canItFire' must ` +
        `prove the branch is reachable — with algebra where a threshold is involved. Every workItem ` +
        `needs a 'forceCondition': the exact mechanism to induce this failure in a test ` +
        `(scripts/e2e.sh already does this — it registers an invalid key to force a dead credential, ` +
        `and runs scripts/stub_429.py to force a transient fault; read them and reuse the pattern). ` +
        `A fallback with no forceCondition is one nobody will ever watch fire — say so plainly rather ` +
        `than inventing a test you know is fake. No two workItems may list the same file. Cite file:line.`,
      { label: `design:${d.key}`, phase: 'Design', schema: CONTRACT_SCHEMA },
    ),
  ),
)

const candidates = designs.filter(Boolean)
if (!candidates.length) return { error: 'All designers failed', surfaceText }

phase('Judge')
const contract = await agent(
  `You are the deciding engineer for Raphael at ${ROOT}.\n\nTHE FEATURE: "${FEATURE}"\n\n` +
    `${CONSTRAINTS}\n${FALLBACK_DOCTRINE}\n\n## The verified failure surface\n${surfaceText}\n\n` +
    `## Three competing degradation contracts\n` +
    candidates
      .map((c, i) => `### Design ${i + 1} (${DESIGNERS[i] ? DESIGNERS[i].key : 'unknown'})\nApproach: ${c.approach}\nTiers: ${JSON.stringify(c.tiers)}\nWork: ${JSON.stringify(c.workItems)}\nNot building: ${(c.notBuilding || []).join('; ')}\nEffort: ${c.effortHours}h`)
      .join('\n\n') +
    `\n\nSynthesize ONE contract. Do not average them — take the strongest spine and graft the best ` +
    `from the others, saying what you took and what you rejected.\n\n` +
    `Veto rules: the 'honest' lens has veto over anything that degrades silently. The 'adversary' lens ` +
    `has veto over any fallback whose branch cannot be shown reachable, or that can double a side ` +
    `effect. The 'minimal' lens keeps the diff honest — if a degrade path cannot be justified against ` +
    `a plain refusal, drop it.\n\n` +
    `HARD REQUIREMENT: verify the load-bearing claims yourself by reading the code before committing ` +
    `to them. Resolve every disagreement between the three designs explicitly — a disagreement usually ` +
    `means one of them read the code and the others guessed. Find out which.\n\n` +
    `Order workItems by dependency. NO TWO workItems may share a file; merge them if they must.`,
  { label: 'judge', phase: 'Judge', schema: CONTRACT_SCHEMA, effort: 'high' },
)

if (!contract) return { error: 'Judge failed', candidates }
if (MODE === 'plan') {
  log('mode=plan — stopping before implementation')
  return { mode: 'plan', surface: modes, candidates, contract }
}

phase('Implement')
const items = contract.workItems || []
log(`Implementing ${items.length} fallbacks, split by file ownership`)

const built = await parallel(
  items.map((item, idx) => () =>
    agent(
      `Implement ONE fallback in Raphael at ${ROOT}.\n\n${CONSTRAINTS}\n${FALLBACK_DOCTRINE}\n\n` +
        `## The overall contract (context only — implement ONLY your item)\n${contract.approach}\n\n` +
        `## YOUR ITEM (${idx + 1}/${items.length}): ${item.title}\n${item.detail}\n\n` +
        `## FILES YOU OWN — touch NOTHING else\n${(item.files || []).join('\n')}\n` +
        `Other agents are editing other files right now.\n\n` +
        `## How this failure is forced\n${item.forceCondition}\n\n## Your check\n${item.check || 'Leave one runnable check that fails if this fallback breaks.'}\n\n` +
        `Read every file you own IN FULL before editing. Match the existing style. Smallest change that ` +
        `works. Comment only a constraint the code cannot show.\n\n` +
        `THE BAR FOR THIS WORK, specifically: your fallback must (a) actually be reachable — if a ` +
        `threshold gates it, solve it and prove the branch can be entered; (b) not degrade silently ` +
        `unless the contract explicitly says invisible is correct; (c) produce the same neutral DB rows ` +
        `as the native path; (d) not double any side effect; (e) be forcible in a test by the mechanism ` +
        `above. If you cannot satisfy (a) or (e), STOP and report it — a fallback nobody can watch fire ` +
        `is the thing this workflow exists to prevent, and shipping one is worse than shipping nothing.\n\n` +
        `VERIFY before returning: Go -> 'go build ./... && go vet ./...' in that service dir; Python -> ` +
        `compile it and run any test you added; web -> './node_modules/.bin/tsc --noEmit' in web/. Do ` +
        `NOT start servers or run the full e2e — ports may be in use and other agents are working. If ` +
        `your verification fails, FIX IT; do not return a broken diff.\n\n` +
        `Return honestly: what you changed, your check's ACTUAL output, and anything you could not do.`,
      {
        label: `impl:${(item.title || 'item').slice(0, 28)}`,
        phase: 'Implement',
        schema: {
          type: 'object',
          properties: {
            changed: { type: 'array', items: { type: 'string' } },
            checkOutput: { type: 'string' },
            reachable: { type: 'string' },
            blocked: { type: 'string' },
          },
          required: ['changed'],
        },
      },
    ),
  ),
)

const done = built.filter(Boolean)
log(`${done.length}/${items.length} fallbacks returned`)

phase('Prove')
const PROOF = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          summary: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        },
        required: ['file', 'summary'],
      },
    },
  },
  required: ['ok', 'problems'],
}

const PROVERS = [
  {
    key: 'reachable',
    brief:
      'PROVE EACH BRANCH CAN BE ENTERED. For every fallback just implemented, force its condition and ' +
      'watch it fire — do not reason about it, RUN it. Use the contract\'s forceCondition for each. ' +
      'Where a threshold or predicate gates the branch, solve it algebraically and show the work: the ' +
      'canonical bug here was archiving at importance<0.05 when importance\'s floor was 0.14, so the ' +
      'branch was unreachable and silently did nothing forever. Report any fallback you could not ' +
      'trigger — that one is already rotting.',
  },
  {
    key: 'silence',
    brief:
      'HUNT SILENT DEGRADATION. For each fallback, determine what the USER actually observes. Read the ' +
      'SSE events emitted, the reply text, the done payload, the DB rows. Then ask the only question ' +
      'that matters: could a user tell this happened? If not, and the contract did not explicitly ' +
      'justify invisibility, that is a blocker. Also verify the inverse: nothing now fires the ' +
      "'degraded' event for a capability reason (rule 4 — it means credential-death only, and e2e " +
      'asserts n_degraded==1 on the lifeboat turn, so an extra one breaks a live test).',
  },
  {
    key: 'skeptic',
    brief:
      'ASSUME THE IMPLEMENTERS LIED. They each claim their check passed. Verify independently: read the ' +
      'actual diff (git diff) and re-run their checks yourself. Specifically hunt: a test that passes ' +
      'against the UNFIXED code (stash the fix, run it, confirm it fails — a test that never fails ' +
      'proves nothing); a fallback whose consumer was never wired; a fallback that re-runs a side ' +
      'effect that already happened; a fallback emitting provider wire-format into the DB where the ' +
      'native path did not; a prompt or doc claiming a fallback works when the code disagrees. ' +
      'Default to suspicion.',
  },
]

const proofs = await parallel(
  PROVERS.map((p) => () =>
    agent(
      `PROVE the fallbacks just implemented in Raphael at ${ROOT} actually work.\n\nTHE FEATURE: "${FEATURE}"\n\n` +
        `${CONSTRAINTS}\n${FALLBACK_DOCTRINE}\n\n` +
        `## The contract they were built against\n${JSON.stringify(contract.tiers)}\n\n` +
        `## What the implementers claim\n` +
        done.map((d, i) => `${i + 1}. changed ${(d.changed || []).join(', ')} — check: ${(d.checkOutput || '').slice(0, 300)}${d.reachable ? ` — reachable: ${d.reachable}` : ''}${d.blocked ? ` — BLOCKED: ${d.blocked}` : ''}`).join('\n') +
        `\n\n## YOUR LENS\n${p.brief}\n\n` +
        `You MAY start services and force conditions — that is the job. Prefer the cheapest mechanism: ` +
        `unit tests and stubs over a full stack. scripts/e2e.sh and scripts/stub_429.py show the ` +
        `established patterns for forcing a dead credential and a transient fault. If you start ` +
        `anything, stop it when you are done.\n\n` +
        `Report only problems you can DEMONSTRATE, with file:line and the evidence. An empty list with ` +
        `ok:true is a fine answer if the work is genuinely sound — do not invent findings to look ` +
        `thorough. But "I could not trigger this fallback" IS a finding, and a serious one.`,
      { label: `prove:${p.key}`, phase: 'Prove', schema: PROOF, effort: 'high' },
    ),
  ),
)

const problems = proofs
  .filter(Boolean)
  .flatMap((v) => v.problems || [])
  .filter((p) => p.severity !== 'minor')

if (!problems.length) {
  log('Every fallback proven reachable and visible')
  return { mode: MODE, contract, implemented: done, proofs, problems: [] }
}

phase('Fix')
log(`${problems.length} problems to fix`)
const fixed = await agent(
  `Fix these DEMONSTRATED problems with the fallbacks in Raphael at ${ROOT}.\n\n${CONSTRAINTS}\n${FALLBACK_DOCTRINE}\n\n` +
    problems.map((p, i) => `${i + 1}. [${p.severity || 'major'}] ${p.file} — ${p.summary}`).join('\n') +
    `\n\nSmallest correct diffs. Re-run the relevant checks and report their ACTUAL output. If a ` +
    `reported problem is not real, say so and leave the code alone — do not "fix" a non-bug to close a ` +
    `ticket. If a fallback genuinely cannot be made reachable or forcible, DELETE it rather than ship ` +
    `it: dead code that claims to protect you is worse than admitting the gap.`,
  {
    label: 'fix',
    phase: 'Fix',
    effort: 'high',
    schema: {
      type: 'object',
      properties: {
        fixed: { type: 'array', items: { type: 'string' } },
        deleted: { type: 'array', items: { type: 'string' } },
        notReal: { type: 'array', items: { type: 'string' } },
        remaining: { type: 'array', items: { type: 'string' } },
      },
      required: ['fixed', 'remaining'],
    },
  },
)

return { mode: MODE, contract, implemented: done, proofs, problems, fix: fixed }
