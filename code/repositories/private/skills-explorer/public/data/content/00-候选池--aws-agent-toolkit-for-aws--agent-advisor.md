---
name: agent-advisor
description: "Entry point for AI-agent work on AWS: pick a runtime, plan a migration for existing workloads, and build an executable POC — one phased flow. Triggers on: which runtime for my agent, AgentCore vs ECS vs EKS vs Lambda, AgentCore vs Lambda MicroVMs, deploy an AI agent on AWS, agent architecture on AWS, I have an agent idea what do I build, move/migrate my agents to AWS, agent migration plan, add AgentCore services (memory, gateway, identity, policy, observability) to an agent already on AWS, Temporal on AWS (migrate/run Temporal workers on AWS, a service orchestrated by Temporal, Temporal Cloud vs self-hosted). Temporal Workflow code is never rewritten into Step Functions. Requires at least one agentic component — a purely non-agent system (plain services, batch jobs, HTTP endpoints, non-agent Temporal Activities) is out of scope, redirected to gcp-to-aws / heroku-to-aws / llm-to-bedrock. Not for: compute/data migration with no AI agent; pure LLM SDK rewrite (use llm-to-bedrock); per-model pricing."
---

# AWS Agent Advisor

Helps startups decide how and where to run AI agents on AWS. Deterministic scoring
recommends a runtime; the conversation adapts to the user's technical background.

## Definitions

- **"Load"** = Read the file with the Read tool and follow it. Do not summarize or skip.
- **`$RUN_DIR`** = the run directory under `.agent-advisor/` (e.g. `.agent-advisor/0630-1430/`),
  created in Intake.
- **`$PLUGIN`** = `${CLAUDE_PLUGIN_ROOT}` (the installed plugin root). On Claude Code this token
  substitutes inline. **If `${CLAUDE_PLUGIN_ROOT}` does not resolve** (some Cursor/Codex builds,
  or a literal `${CLAUDE_PLUGIN_ROOT}` string showing up in a path error), fall back to the
  skill's own directory: this SKILL.md lives at `<plugin>/skills/agent-advisor/SKILL.md`, so the
  engine and its data are all inside this skill — scripts at `./scripts/...`, runtime profiles at
  `./references/runtimes/...`, and decision refs at `./references/decision-refs/...` relative to
  it. Prefer `${CLAUDE_PLUGIN_ROOT}/skills/agent-advisor/...`; use the relative fallback only when
  it fails to resolve.

## Prerequisites

- `uv` available (for scoring). Check: `uv --version`. If missing, tell the user to install
  it from the official install guide (https://docs.astral.sh/uv/getting-started/installation/ — e.g. `brew install uv` or `pipx install uv`) and stop.

## Phase Structure (frontmatter)

Phase, fragment, and assembler files carry a YAML frontmatter block that declares how each
phase is composed — its inputs, triggers, fragments, assembler, artifacts, gates, and
ordering. The execution contract is the vendored `references/vendored/dsl/INTERPRETER.md`:
it defines every frontmatter key, the fragment/assembler model, the gate protocol
(`HANDOFF_OK` / `GATE_FAIL`), and the interpreter loop. **Load it first** (once, at the
start of a run), then execute each phase file's prose body. Elsewhere in this skill,
`INTERPRETER.md` (without a path) refers to this loaded contract.

## Execution

This skill is driven by the interpreter loop in `INTERPRETER.md` (§ The interpreter loop):
it reads `.phase-status.json`, determines the current phase, runs each phase's
`_preconditions` / fragments / `_assemble` / `_postconditions`, advances on `HANDOFF_OK`
via `_advances_to`, and validates state. The backbone (intake → discover → clarify →
confirm → design → estimate → generate → migration-plan → poc → complete) and the
one sidebar branch (add-capabilities) are derived
from the phase files' frontmatter — they are not restated here.

**Cold start (entry phase).** With no run under `.agent-advisor/` carrying a
`.phase-status.json`, begin at `references/phases/intake/intake.md` — this skill's entry
phase (the one carrying `_init: true`). On a warm start, `current_phase` in
`.phase-status.json` is authoritative (`INTERPRETER.md` § The interpreter loop).

**Skill bindings (`INTERPRETER.md` § Skill bindings).** This skill declares:

- **Run root**: `.agent-advisor/` — `$RUN_DIR` is this skill's name for the run directory
  (`.agent-advisor/[MMDD-HHMM]/`). Intake's own prose performs the `_init` bootstrap.
- **State shape**: § State file below (advisor-specific keys such as `entry_point`,
  `audience`, `recommendation_reviewed`, `migration_plan_ctx`, `migration_plan_unavailable`);
  the shared state schema is not vendored.
- **Run seed (optional)**: `$RUN_DIR/seed.json`, else `.agent-advisor/seed.json` at the run root
  (schema `scripts/schemas/seed.json`) supplies
  machine-readable answers for a non-interactive run — the Clarify dimensions, the two gate
  answers, the POC mode, the live-probe answer, and a `co_recommend` tie-break. It is the
  HIGHEST-precedence source for every value it carries (clarify.md Step 2.5), which is what makes
  a repeated run's score comparable: the deterministic engine gets byte-identical input. A gate
  the seed omits is declined; a dimension the seed omits falls through to detection, then prose,
  then an `assumed` value that MUST be recorded in `$RUN_DIR/UNANSWERED.md`. With no seed, the
  interactive flow is unchanged.
- **Resolved statuses**: `skipped` (routing resolved the phase without running it), plus
  `not_applicable` for `migration_plan` only.
- **Conditional backbone routing**: the entry-point routing below. When a routing rule
  marks a phase not-applicable, set it `skipped` and advance through its `_advances_to` in
  the same state write.

## Routing & gates (orchestration)

Sidebar placement and conditional backbone routing are orchestration prose owned by
this file (`INTERPRETER.md` § Skill bindings, § Backbone vs sidebar).

**Entry-point routing:**

- `build_scratch` → skip Discover; Clarify → Confirm → Design → Estimate → Generate → **Gate 2 → POC (any winning runtime)**. No migration plan (nothing existing to migrate).
- `build_deploy` → Discover (if code) → Clarify → Confirm → Design → Estimate → Generate → **Gate 1 → Migration Plan (if existing non-AWS AI workload detected and user confirms)** → **Gate 2 → POC (any winning runtime)**.
- `migrate` → Discover (if code) → Clarify → Confirm → Design → Estimate (target-state run cost; migration TCO comparison stays with the Migration Plan engine) → Generate → **Gate 1 → Migration Plan (in-skill, reusing the sibling `gcp-to-aws` skill)** → **Gate 2 → POC (any winning runtime, when the plan was produced)**. Declining Gate 1 keeps the classic handoff: pointer to `/aws-startup-advisor:llm-to-bedrock` with `handoff-summary.md`.
- `add_capabilities` → load `references/phases/add-capabilities/add-capabilities.md` and follow it (no runtime
  scoring; writes `capabilities-recommendation.md`). This is a self-contained branch — it does
  NOT pass through Clarify / Confirm / Design / Estimate / Generate, so the phase gate
  below never applies to it.
- Temporal detection routes into `migrate` with temporal units pre-seeded (see discover).

**Gate semantics (backbone tail):**

- **Gate 1 → `migration_plan`** runs only when `generate` is done AND
  `recommendation_reviewed == true` (generate.md Step 5.5) AND entry point ∈ {migrate,
  build_deploy} AND the run is migration-eligible (generate.md Step 6) AND the user
  confirmed Gate 1. Otherwise resolve it: `not_applicable` (build_scratch / no migratable
  workload) or `skipped` (declined) — and advance.
- **Gate 2 → `poc`** runs only when `phases.poc == "in_progress"` (set when the user
  answers Gate 2 "yes" — asked in generate.md Step 7 or migration-plan.md Step 6) AND
  `recommendation_reviewed == true`. Any winning runtime (agentcore / ecs / eks / lambda /
  lambda_microvms) — the POC shape follows the verdict (poc.md Step 3 dispatch on
  `references/decision-refs/poc-shapes.md`). Gate 2 is only offered when `migration_plan`
  ∈ {completed, skipped, not_applicable} — or `in_progress` on build_deploy only (Stage 2
  failed/aborted; fallback POC from design.json per migration-plan.md failure handling);
  for entry point `migrate`, only when `migration_plan == "completed"` (the POC implements the
  plan) OR when the stage resolved `not_applicable` with `migration_plan_unavailable ==
"engine_absent"` — a standalone deployment that does not bundle the migration engine, where
  Gate 2 is offered by migration-plan.md Step -1 and the POC is design-backed. A migrate-POC
  with no plan for any OTHER reason (the user declined) has nothing to implement.
- Persisting Gate 2 as `phases.poc = "in_progress"` BEFORE poc.md loads makes the
  confirmation resumable: if the session breaks between the "yes" and the load, the
  interpreter re-enters `poc` without re-asking. (A declared deviation from
  `INTERPRETER.md` § The interpreter loop step 5's gate-then-`in_progress` ordering — the
  user's confirmation is the entry event worth persisting.)

**Phase gate:** Do NOT load design.md / estimate.md / generate.md unless
`$RUN_DIR/.phase-status.json` exists and BOTH `phases.clarify == "completed"` AND
`phases.confirm == "completed"`. Confirm confirms the deployment model, the service
set, and (for a co_recommend tie) the user's `chosen_runtime` — Design and the diagram depend on
its `confirm.json` output, so it must not be skipped. If the user asks to skip Clarify or Pass 2,
refuse briefly and run it.

## State file (`.phase-status.json`)

```json
{
  "run_id": "0630-1430",
  "entry_point": "build_scratch",
  "audience": "technical",
  "current_phase": "clarify",
  "phases": {
    "intake": "completed",
    "discover": "skipped",
    "clarify": "in_progress",
    "confirm": "pending",
    "design": "pending",
    "estimate": "pending",
    "generate": "pending",
    "migration_plan": "pending",
    "poc": "pending"
  }
}
```

Status values: `pending` → `in_progress` → `completed`, plus `skipped`. Use read-merge-write:
read before each update, change only the advancing keys, keep prior phases.

`recommendation_reviewed` (top level, boolean) is set to `true` by generate.md Step 5.5 when
the user explicitly confirms they have seen the recommendation. Gate 1, Gate 2, and the
`migration_plan` / `poc` states all require it — no gate may be asked while it is absent.

`migration_plan` additionally uses `not_applicable` (build_scratch, or no migratable workload
detected). When Stage 2 runs, `migration_plan_ctx` is added at the top level:
`{"repo": "<abs path to target repo>", "migration_dir": "<abs path to .migration/<id>/>"}` —
Stage 3 reads gcp-to-aws artifacts ONLY via this recorded path, never by re-globbing.

## Files

| File                                                 | Purpose                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `references/vendored/dsl/INTERPRETER.md`             | Vendored DSL execution contract (interpreter loop + gate protocol)                                             |
| `references/phases/intake/intake.md`                 | Entry point + technical background + open context                                                              |
| `references/phases/discover/discover.md`             | Lightweight code detection                                                                                     |
| `references/phases/clarify/clarify.md`               | Clarify orchestrator + answer mapping to scoring keys                                                          |
| `references/phases/clarify/clarify-technical.md`     | Technical-background question wording                                                                          |
| `references/phases/clarify/clarify-business.md`      | Business-background question wording                                                                           |
| `references/phases/confirm/confirm.md`               | Winner-specific follow-ups                                                                                     |
| `references/phases/design/design.md`                 | Assemble recommendation; Migrate handoff branch                                                                |
| `references/phases/estimate/estimate.md`             | Coarse cost magnitude                                                                                          |
| `references/phases/generate/generate.md`             | Layered recommendation doc + scaffolding                                                                       |
| `references/phases/migration-plan/migration-plan.md` | Stage 2: full migration plan via the sibling gcp-to-aws engine                                                 |
| `references/decision-refs/temporal.md`               | Temporal rules: Tier 1/2 tables, adapter, runbooks, commercials (consumed by discover/clarify/design/generate) |
| `references/decision-refs/poc-shapes.md`             | Per-runtime POC deploy shapes (ECS/EKS/Lambda/MicroVMs/Temporal)                                               |
| `references/decision-refs/*.md`                      | Runtime service cards, model defaults, freshness                                                               |
| `references/decision-refs/workload-classes.md`       | Deterministic verdicts for non-agent workload units (batch/service/io)                                         |
| `references/runtimes/*.json`                         | Runtime registry (read by scoring.py)                                                                          |
| `scripts/scoring.py`                                 | Deterministic scoring engine                                                                                   |
| `scripts/test_temporal_decision_refs.py`             | Content lock for the Temporal decision reference                                                               |
| `scripts/test_poc_shapes.py`                         | Content lock for the POC deploy shapes                                                                         |
| `scripts/test_workload_classes.py`                   | Content lock for workload-classes.md (verdicts table)                                                          |
| `scripts/test_unit_grouping.py`                      | Unit grouping + pattern matching (workload-class assignment)                                                   |
| `scripts/test_collapse_invariant.py`                 | Collapse-invariant ordering enforcement (A→B implies [B] ⊆ [A] outputs)                                        |

## Maturity and readiness contract

Intake persists `target_maturity` (`prototype`, `private_beta`, or `production`) in run state. Clarify carries it and the readable `readiness` record into `answers.json`. Current-run verification evidence remains exclusively in the sibling `$RUN_DIR/current-run-verifications.json` artifact: never copy it into `seed.json` or `answers.json`. Design and Generate may consume that artifact only after validating its schema and matching `run_id`, and may carry forward verified outcomes but not the raw evidence records. Load `references/decision-refs/maturity-readiness.md` whenever target maturity is selected. A cached volatile fact may inform discovery, but only a record verified in this run can make a verification-required constraint final; otherwise the score remains provisional with deferred verification requirements.

## Contextual offers (final step)

> **Before you finish:** your answer is not complete until you have run the **Contextual offers (final step)** below.

This is a mandatory closing step of every final recommendation — complete it before you consider your answer done. Run this offer check inline yourself; do not depend on loading another skill. The recommendation is decided on merit first; this step never changes, re-ranks, or re-opens it, and the offer is looked up only after the advice is final.

1. Read [`../knowledge-base-for-startups/references/offers.md`](../knowledge-base-for-startups/references/offers.md) — the offer index (Offer · Summary · Keywords), one row per offer.
2. Judge relevance against what the founder actually surfaced this session. Surface an offer only if **one** holds: a **named-product match** (you recommended a specific partner product by name and it has a row); a **direct intent/component match** (an offer's Keywords directly serve a concrete workload, a component in the final recommendation, or a need the founder raised). Keep a high bar — if the match is weak, or you would be inferring an unstated need, append nothing.
3. If (and only if) one offer clears the bar, open only its detail file `../knowledge-base-for-startups/references/offers/<slug>.md` and append exactly **one** quiet, dismissible italic line — stating the value and condensing eligibility faithfully from that file (drop no qualifying criterion; never fabricate), with the redeem link built from the canonical `source_url` plus a `source` attribution param — append `?source=ide-startupAdvisor-<host>` (or `&source=...` if the url already has a query string), filling `<host>` from your execution environment (Claude Code → `claude`; AWS Startup Advisor IDE extension / VS Code → `vscode`; Cursor → `cursor`; Kiro → `kiro`; Codex → `codex`), or the generic `ide-startupAdvisor` when you cannot tell. Only append the query param; never change the destination. Show one or none, never a list.

Standard line:

```
***<Offer>** has an exclusive offer via AWS Activate — <value>, <eligibility>. [Redeem →](<source_url>?source=ide-startupAdvisor-<host>)*
```

Caps and control: at most one offer per response and often none; no more than one per five messages and two per session; show a given offer at most once per session and never one already shown, claimed, or dismissed; if the founder has muted offers, skip this step entirely. These per-five-messages, per-session, and already-shown caps are session-state limits; in a fresh session with no prior offers they are non-binding, so do not withhold an otherwise-qualifying offer merely because you cannot verify session history. See [`../contextual-offers-for-startups/SKILL.md`](../contextual-offers-for-startups/SKILL.md) for the full rules — but perform the check inline; it must not depend on that skill being loaded.
