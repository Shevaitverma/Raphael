export const meta = {
  name: 'raphael-feature',
  description: 'Plan and implement any Raphael change end to end: recon, design panel, judge, implement, adversarially verify',
  whenToUse: 'Any substantial Raphael work stated in one line: a feature, a refactor, a bug hunt, a subsystem overhaul. Pass the request as args (a string), or {request, mode} where mode is "plan" | "implement" | "both" (default "both"). Bakes in the standing project constraints so no agent has to be re-told them.',
  phases: [
    { title: 'Recon', detail: 'parallel readers establish ground truth against the real code' },
    { title: 'Design', detail: 'three independent design lenses' },
    { title: 'Judge', detail: 'score the designs, synthesize one plan with file-owned work items' },
    { title: 'Implement', detail: 'one agent per work item, split by file ownership' },
    { title: 'Verify', detail: 'builds and tests, then adversarial skeptics per claim' },
    { title: 'Fix', detail: 'apply confirmed findings' },
  ],
}

const ROOT = '/Users/shevaitverma/Applications/shevait/Raphael'
const REQUEST = typeof args === 'string' ? args : (args && args.request) || ''
const MODE = (args && args.mode) || 'both'

if (!REQUEST) {
  return { error: 'No request given. Pass args as a string, or {request, mode}.' }
}

// Everything every agent must know. Re-stating this per prompt is what keeps a
// subagent from cheerfully violating a rule it was never told about.
const CONSTRAINTS = `
## Raphael standing constraints — these override any instinct you have

1. MICROSERVICES ARE INTENTIONAL. gateway(:8080) user-svc(:8081) conv-svc(:8082)
   agent-svc(:8000) web(:3000) + Postgres/pgvector(:5433) + Redis(:6379). NEVER propose
   merging or deleting a service. Declining to ADD a service is fine and usually right.
   Trim config, not architecture.

2. PROVIDER PORTABILITY IS THE FOUNDING THESIS. Three paths, all first-class:
   local(Ollama), openai_compat(OpenRouter), anthropic(Claude API + OAuth/CLI).
   "Works on all three" does NOT mean identical behavior — it means every feature
   declares a capability tier with a STATED fallback and degrades VISIBLY, never
   silently. Capability is a property of the MODEL, not the provider: OpenRouter
   serves both 8k Llamas and 1M Geminis, so per-provider constants are lies.
   Never design Claude-first and bolt the rest on.

3. NO PROVIDER WIRE-FORMAT IN THE DATABASE, EVER. No toolu_/call_ ids, no thinking
   blocks, no cache_control. scripts/e2e.sh section 5 asserts this; conv-svc/toolcalls.go
   validates it. Note the tool_calls column check bans even a bare "id" key — name tool
   arguments accordingly (goal_id, not id).

4. THE LIFEBOAT IS SACRED. Dead credential (401/402/403) -> visible fallback to the
   is_lifeboat credential + exactly one 'degraded' SSE event, and is_active is NEVER
   flipped. Transient fault (429/5xx/timeout) -> 'error' event, no fallback, no state
   change. 'degraded' means one specific thing; do not overload it.

5. SSE CONTRACT: token / done / degraded / error. Adding an event is a protocol change —
   justify it or don't.

6. SECRETS: .env is gitignored and holds real keys. Never commit it, never print a secret
   value, never write one to a tracked file. API keys are encrypted at rest and never
   returned by a public route.

7. BE A LAZY SENIOR DEVELOPER. Stop at the first rung that holds: does it need to exist
   at all (YAGNI)? already in this codebase? stdlib? native platform feature? an
   already-installed dep? one line? Only then the minimum code that works. Deletion over
   addition. No interface with one implementation, no config for a value that never
   changes, no scaffolding "for later". Shortest working diff wins.

8. BUT NEVER LAZY ABOUT: understanding the problem, input validation at trust boundaries,
   error handling that prevents data loss, security, accessibility, or anything explicitly
   asked for. Read the real code fully and trace the actual flow BEFORE choosing a rung.
   A small diff in the wrong place is a second bug, not laziness.

9. MARK DELIBERATE SHORTCUTS with a 'ponytail:' comment naming the ceiling and the upgrade
   path. Non-trivial logic leaves ONE runnable check behind — the smallest thing that fails
   if the logic breaks. No frameworks, no fixtures.

10. VERIFY, DON'T ASSERT. Cite file:line for every factual claim. If you did not read it,
    do not claim it. If a check fails, say so with the output. Never report a thing as done
    that you did not observe working.

11. NEVER VERIFY BY DESTROYING. A check must not delete or reset state the user did not
    name as disposable. Specifically forbidden: 'docker compose down -v' (it drops the
    pgdata volume holding real conversations, credentials, facts and memories), DROP/TRUNCATE
    on any table, deleting .env, and 'git checkout'/'git stash' over a working tree other
    agents are writing to. A migration is verified by APPLYING it to the live database and
    applying it a second time to prove idempotency — never by wiping and re-initialising.
    If a check seems to need a clean database, it does not: use a scratch schema, a fake, or
    say plainly that you could not verify it.
`

phase('Recon')
const RECON_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
    surprises: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'files'],
}

const recon = await parallel([
  () =>
    agent(
      `Recon for Raphael at ${ROOT}. THE REQUEST: "${REQUEST}"\n\n${CONSTRAINTS}\n\n` +
        `Your lens: THE CODE SURFACE. Read the actual code this request would touch — trace the real ` +
        `flow end to end, don't skim. Report what EXISTS today with file:line, what is already built ` +
        `(including anything half-built, dead, or unreachable — Raphael has a history of complete ` +
        `machinery with no consumer), and what genuinely does not exist. Distinguish "implemented and ` +
        `working" from "implemented and never called" from "absent". Do NOT design anything.`,
      { label: 'recon:code', phase: 'Recon', schema: RECON_SCHEMA },
    ),
  () =>
    agent(
      `Recon for Raphael at ${ROOT}. THE REQUEST: "${REQUEST}"\n\n${CONSTRAINTS}\n\n` +
        `Your lens: CONTRACTS, TESTS AND DOCS. Read docs/CONTRACT.md, plan.md, README.md, ` +
        `scripts/e2e.sh, and every test that touches this area. Report: what the docs CLAIM vs what ` +
        `the code DOES (Raphael has known doc drift — treat docs as a lead, never as truth); which ` +
        `existing assertions constrain this work; and critically, whether any relevant test is ` +
        `VACUOUS (asserts over a column/path that is always empty, so it has never had a chance to ` +
        `fail). A test that cannot fail is worse than no test. Do NOT design anything.`,
      { label: 'recon:contracts', phase: 'Recon', schema: RECON_SCHEMA },
    ),
  () =>
    agent(
      `Recon for Raphael at ${ROOT}. THE REQUEST: "${REQUEST}"\n\n${CONSTRAINTS}\n\n` +
        `Your lens: PROVIDER PORTABILITY. Read agent-svc/src/llm/ in full (base.py, resolver.py, ` +
        `anthropic_api.py, anthropic_cli.py, openai_compat.py, embeddings.py) plus db/001_init.sql's ` +
        `provider_credentials. Report how this request would behave differently on local(Ollama) vs ` +
        `openai_compat(OpenRouter) vs anthropic(API and OAuth/CLI). Name every capability the request ` +
        `depends on (context window, tool calling, JSON/structured output, streaming granularity, ` +
        `vision) and whether Raphael can currently DETECT it or merely assumes it. Flag any hardcoded ` +
        `per-provider constant as a probable lie and check it against reality. Do NOT design anything.`,
      { label: 'recon:providers', phase: 'Recon', schema: RECON_SCHEMA },
    ),
])

const ground = recon
  .filter(Boolean)
  .map((r, i) => `### Recon ${i + 1}\n${(r.findings || []).join('\n')}\nFiles: ${(r.files || []).join(', ')}\nSurprises: ${(r.surprises || []).join('; ')}`)
  .join('\n\n')

log(`Recon complete across ${recon.filter(Boolean).length} lenses`)

phase('Design')
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    rationale: { type: 'string' },
    workItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          check: { type: 'string' },
        },
        required: ['title', 'detail', 'files'],
      },
    },
    notBuilding: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    effortHours: { type: 'number' },
  },
  required: ['approach', 'rationale', 'workItems', 'notBuilding'],
}

const LENSES = [
  {
    key: 'minimal',
    brief:
      'THE LAZIEST THING THAT WORKS. Climb the ladder ruthlessly. Question whether each piece needs ' +
      'to exist. Prefer a DB constraint over app code, an env var over a table, a computed value over ' +
      'a stored one plus a cron to refresh it, an existing column over a new one. Your notBuilding list ' +
      'should be longer than your workItems list, and every entry needs the concrete trigger that would ' +
      'justify building it later.',
  },
  {
    key: 'correctness',
    brief:
      'CORRECTNESS AND FAILURE MODES FIRST. Where does this break? Trace: concurrent turns, a service ' +
      'down mid-flow, malformed model output, a migration against a live volume with existing rows, a ' +
      'trust boundary crossed, a race between two writers. Name every failure mode and its handling. ' +
      'Look hard for the bug that is SILENT — wrong data written with no error is the expensive kind. ' +
      'Check any threshold or predicate algebraically: can it actually fire?',
  },
  {
    key: 'portability',
    brief:
      'PROVIDER PORTABILITY FIRST. Design so it works on a 7B local model, on an arbitrary OpenRouter ' +
      'model, and on Claude — with an explicit tier and fallback for each. Assume the local model emits ' +
      'chatty non-JSON, has a far smaller REAL context window than any constant claims, and tool-calls ' +
      'unreliably. If a capability genuinely cannot be made portable, say so plainly instead of ' +
      'inventing an abstraction that pretends otherwise.',
  },
]

const designs = await parallel(
  LENSES.map((l) => () =>
    agent(
      `Design a plan for Raphael at ${ROOT}.\n\nTHE REQUEST: "${REQUEST}"\n\n${CONSTRAINTS}\n\n` +
        `## Ground truth from recon (verify anything you rely on — this is a lead, not gospel)\n${ground}\n\n` +
        `## YOUR LENS\n${l.brief}\n\n` +
        `Produce a concrete plan. Every workItem must name the exact files it owns — two work items ` +
        `must NEVER list the same file, because they will be implemented by different agents in ` +
        `parallel. Each workItem needs a 'check': the smallest runnable thing that fails if it breaks. ` +
        `Cite file:line. Give an honest effort estimate in hours.`,
      { label: `design:${l.key}`, phase: 'Design', schema: PLAN_SCHEMA },
    ),
  ),
)

const candidates = designs.filter(Boolean)
if (!candidates.length) return { error: 'All design agents failed', ground }

phase('Judge')
const judged = await agent(
  `You are the deciding engineer for Raphael at ${ROOT}.\n\nTHE REQUEST: "${REQUEST}"\n\n${CONSTRAINTS}\n\n` +
    `## Ground truth\n${ground}\n\n` +
    `## Three competing designs\n` +
    candidates
      .map((d, i) => `### Design ${i + 1} (${LENSES[i] ? LENSES[i].key : 'unknown'})\nApproach: ${d.approach}\nRationale: ${d.rationale}\nWork: ${JSON.stringify(d.workItems)}\nNot building: ${(d.notBuilding || []).join('; ')}\nRisks: ${(d.risks || []).join('; ')}\nEffort: ${d.effortHours}h`)
      .join('\n\n') +
    `\n\nSynthesize ONE plan. Do not average them — pick the strongest spine and graft the best ideas ` +
    `from the others, saying what you took and what you rejected. The minimal lens keeps the diff ` +
    `honest; the correctness lens has veto power over anything that loses or corrupts data; the ` +
    `portability lens has veto power over anything that only works on Claude.\n\n` +
    `HARD REQUIREMENT: verify the load-bearing claims yourself by reading the code before you commit ` +
    `to them. A design built on a recon claim that turns out to be false is worse than no design.\n\n` +
    `Order workItems by dependency — earlier items must not depend on later ones. Ensure NO TWO ` +
    `workItems share a file. If two pieces of work genuinely need the same file, merge them into one ` +
    `workItem.`,
  { label: 'judge', phase: 'Judge', schema: PLAN_SCHEMA, effort: 'high' },
)

if (!judged) return { error: 'Judge failed', candidates }
if (MODE === 'plan') {
  log('mode=plan — stopping before implementation')
  return { mode: 'plan', ground, candidates, plan: judged }
}

phase('Implement')
const items = judged.workItems || []
log(`Implementing ${items.length} work items, split by file ownership`)

const built = await parallel(
  items.map((item, idx) => () =>
    agent(
      `Implement ONE work item in Raphael at ${ROOT}.\n\n${CONSTRAINTS}\n\n` +
        `## The overall plan (context only — you implement ONLY your item)\n${judged.approach}\n\n` +
        `## YOUR ITEM (${idx + 1}/${items.length}): ${item.title}\n${item.detail}\n\n` +
        `## FILES YOU OWN — touch NOTHING else\n${(item.files || []).join('\n')}\n` +
        `Other agents are editing other files right now. Editing a file you do not own will be ` +
        `clobbered and will corrupt their work.\n\n` +
        `## Your check\n${item.check || 'Leave one runnable check that fails if this logic breaks.'}\n\n` +
        `Read every file you own IN FULL before editing. Match the existing style exactly. Make the ` +
        `smallest change that actually works. Comment only a constraint the code cannot show — never ` +
        `explain your change to a reviewer.\n\n` +
        `VERIFY before returning: Go -> 'go build ./... && go vet ./...' in that service dir; ` +
        `Python -> compile/import it and run any test you added; web -> './node_modules/.bin/tsc ` +
        `--noEmit' in web/. Do NOT start servers and do NOT run the full e2e — ports may be in use ` +
        `and other agents are working. If your verification fails, FIX IT; do not return a broken diff.\n\n` +
        `Return honestly: what you changed, your check's actual output, and anything you could not do.`,
      {
        label: `impl:${(item.title || 'item').slice(0, 28)}`,
        phase: 'Implement',
        schema: {
          type: 'object',
          properties: {
            changed: { type: 'array', items: { type: 'string' } },
            checkOutput: { type: 'string' },
            blocked: { type: 'string' },
          },
          required: ['changed'],
        },
      },
    ),
  ),
)

const done = built.filter(Boolean)
log(`${done.length}/${items.length} work items returned`)

phase('Verify')
const VERDICT = {
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

const VERIFIERS = [
  {
    key: 'builds',
    brief:
      'DOES IT ACTUALLY BUILD AND PASS? Run the real commands: go build/vet/test in gateway, user-svc, ' +
      'conv-svc; python compile + pytest in agent-svc; tsc --noEmit in web. Run "docker compose config -q" ' +
      'if compose changed. Report ACTUAL output, never a prediction. Do not start servers.',
  },
  {
    key: 'constraints',
    brief:
      'DID IT VIOLATE A STANDING CONSTRAINT? Check every rule in the constraints block above against ' +
      'the real diff (git diff). Especially: provider wire-format reaching the DB, a service merged or ' +
      'added, the degraded/lifeboat semantics altered, a secret written to a tracked file, an SSE event ' +
      'added, a db/ migration edited rather than added.',
  },
  {
    key: 'skeptic',
    brief:
      'ASSUME THE IMPLEMENTERS LIED. They each claim their check passed. Verify independently by ' +
      'reading the actual diff (git diff) and re-running their checks yourself. Hunt specifically for: ' +
      'a claim of done where the code is a stub; a test that cannot fail; a threshold or predicate that ' +
      'can never fire; an error swallowed that should surface; a migration that breaks on a live volume ' +
      'with existing rows; two agents that edited the same file. Default to suspicion.',
  },
]

const verdicts = await parallel(
  VERIFIERS.map((v) => () =>
    agent(
      `Verify the just-applied changes in Raphael at ${ROOT}.\n\nTHE REQUEST WAS: "${REQUEST}"\n\n${CONSTRAINTS}\n\n` +
        `## What the implementers claim they did\n` +
        done.map((d, i) => `${i + 1}. changed ${(d.changed || []).join(', ')} — check said: ${(d.checkOutput || '').slice(0, 300)}${d.blocked ? ` — BLOCKED: ${d.blocked}` : ''}`).join('\n') +
        `\n\n## YOUR LENS\n${v.brief}\n\n` +
        `Report only problems you can DEMONSTRATE, each with file:line and the evidence. An empty ` +
        `problems list with ok:true is a fine answer if the work is genuinely sound — do not invent ` +
        `findings to look thorough.`,
      { label: `verify:${v.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' },
    ),
  ),
)

const problems = verdicts
  .filter(Boolean)
  .flatMap((v) => v.problems || [])
  .filter((p) => p.severity !== 'minor')

if (!problems.length) {
  log('Verification clean')
  return { mode: MODE, plan: judged, implemented: done, verdicts, problems: [] }
}

phase('Fix')
log(`${problems.length} problems to fix`)
const fixed = await agent(
  `Fix these VERIFIED problems in Raphael at ${ROOT}.\n\n${CONSTRAINTS}\n\n` +
    problems.map((p, i) => `${i + 1}. [${p.severity || 'major'}] ${p.file} — ${p.summary}`).join('\n') +
    `\n\nSmallest correct diffs. Re-run the relevant builds and tests afterward and report their ACTUAL ` +
    `output. If a reported problem is not real, say so and leave the code alone — do not "fix" a ` +
    `non-bug to close a ticket.`,
  {
    label: 'fix',
    phase: 'Fix',
    effort: 'high',
    schema: {
      type: 'object',
      properties: {
        fixed: { type: 'array', items: { type: 'string' } },
        notReal: { type: 'array', items: { type: 'string' } },
        remaining: { type: 'array', items: { type: 'string' } },
      },
      required: ['fixed', 'remaining'],
    },
  },
)

return { mode: MODE, plan: judged, implemented: done, verdicts, problems, fix: fixed }
