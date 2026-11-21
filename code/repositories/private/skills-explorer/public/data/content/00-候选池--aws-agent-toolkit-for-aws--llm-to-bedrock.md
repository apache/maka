---
name: llm-to-bedrock
description: "Use when the user wants to migrate code that calls OpenAI, Gemini/Google AI, or the Anthropic API to Amazon Bedrock — a pure model/SDK rewrite. End-to-end: assesses the codebase, then rewrites SDK calls, evaluates output quality against Bedrock, and delivers a ready-to-merge git branch. Not for: agent runtime selection, agentic architecture decisions, or agent migration planning — use agent-advisor for those. Not for standalone Bedrock cost estimates or infrastructure-only migration. REQUIRES the gcp-to-aws skill installed alongside this one — Assess is delegated entirely to it via a cross-skill invocation, with no standalone fallback if gcp-to-aws is absent."
---

# Migrate to Bedrock (Assess + Execute)

Single-command AI migration: OpenAI / Gemini / Anthropic → Amazon Bedrock.

**Requires the `gcp-to-aws` skill installed alongside this one.** This skill has no
standalone Assess implementation — Phase A below delegates Assess entirely to `gcp-to-aws`
via a cross-skill invocation, and there is no fallback path that performs Assess itself if
`gcp-to-aws` is missing. If you installed this skill on its own (e.g. a single-skill
`npx skills add`), install `gcp-to-aws` too before using it.

The skill base directory is given in the "Base directory for this skill: X" line the harness
emits at load time. Call it `<SKILL_BASE>`. Derived paths:

- `$SCRIPTS` = `<SKILL_BASE>/scripts`
- `$HELPERS` = `<SKILL_BASE>/references/helpers` (the former helper skills, now references)

---

## Step 0 — Check prerequisites

### 0a. Check that `uv` is available

```bash
uv --version 2>/dev/null || echo "MISSING"
```

If missing: "Install uv first — see the official install guide: https://docs.astral.sh/uv/getting-started/installation/ (e.g. `brew install uv` or `pipx install uv`)". Stop.

### 0b. Check that the gcp-to-aws sibling skill is installed

Phase A below delegates the entire Assess step to the `gcp-to-aws` skill via the Skill tool —
there is no Assess logic in this skill to fall back to. `gcp-to-aws` is a **separate skill**,
not bundled inside this one — a single-skill install (e.g. `npx skills add ... --skill
llm-to-bedrock`) does not bring it along automatically. Check for it now, before promising the
user an Assess phase this deployment cannot run:

```bash
[ -f "<SKILL_BASE>/../gcp-to-aws/SKILL.md" ] && echo GCP_TO_AWS_PRESENT || echo GCP_TO_AWS_MISSING
```

This checks the sibling directory relative to `<SKILL_BASE>` (defined above), which works
under any install path — native plugin install and `npx skills add --skill '*'` both place
`gcp-to-aws` as a sibling of this skill's own directory. It does **not** depend on
`${CLAUDE_PLUGIN_ROOT}`.

- `GCP_TO_AWS_PRESENT` → proceed to Step 1.
- `GCP_TO_AWS_MISSING` → **stop here — do not proceed.** Tell the user:

  > "This migration needs the `gcp-to-aws` skill installed alongside this one — it handles
  > code scanning, AI-workload detection, and Bedrock model design; I can't do that part myself
  > without it. `gcp-to-aws` ships in the same `aws-startup-advisor` plugin as this skill, so if
  > you installed the whole plugin it should already be next to me — it looks like only some of
  > the plugin's skills were installed. Add it with:
  > `npx skills add aws/agent-toolkit-for-aws/plugins/aws-startup-advisor/skills --skill gcp-to-aws`
  > (use the same `--agent` and `--global`/project scope you used for this skill), or reinstall the
  > `aws-startup-advisor` plugin to get every skill at once. Then restart your agent and ask me to
  > migrate again."

  **Do not** perform the Assess phase yourself as a workaround — Phase A below is explicit that
  Assess logic lives only in `gcp-to-aws`; re-implementing it here would drift out of sync with
  that skill's Discover/Clarify/Design logic over time. There is no standalone Assess for this
  skill — this check exists to fail fast and clearly, not to unlock alternate behavior.

**Separately, invoking `gcp-to-aws` at all in Phase A requires your agent to support the
Skill tool** (cross-skill invocation by name). This is confirmed for Claude Code; it has not
been verified across every agent that supports `npx skills` installs (Cursor, Codex, etc.) —
if you're on one of those and this fails, that is the likely cause. If the Skill tool call in
Phase A's A1 step fails or no such mechanism exists on your agent, this skill still has no
fallback: tell the user plainly that this agent cannot chain into `gcp-to-aws` automatically,
and ask them to invoke `gcp-to-aws` themselves directly (e.g. "migrate my AI workload to AWS")
to run Discover through Design (accepting the decision pack is enough — they do not need to
generate infra Terraform), then come back to this skill once its Assess artifacts are ready
(the decision pack is done, or `generate` is `completed`; checked in A2) to continue with the
SDK rewrite. This is a manual two-step workaround for a missing agent capability, not an
automated fallback — do not present it to the user as this skill "handling it."

---

## Step 1 — Collect source code path

If `$ARGUMENTS` contains a path, use it as `$REPO`. Otherwise use **AskUserQuestion**:
"Where is your source code? Enter a local path or GitHub URL."

If a GitHub URL, `git clone` it to a temp dir; use that path as `$REPO`.

**Checks on $REPO:**

1. **Git-root check** (compare resolved paths — on macOS `/tmp` resolves to `/private/tmp`,
   so a raw string comparison false-positives):

   ```bash
   [ "$(git -C <REPO> rev-parse --show-toplevel 2>/dev/null)" = "$(cd <REPO> && pwd -P)" ] && echo GIT_ROOT_OK || echo GIT_ROOT_MISMATCH
   ```

   - `GIT_ROOT_OK` → proceed.
   - `GIT_ROOT_MISMATCH` and the command errored (not a git repo at all) → tell the user the
     path must be a git repository (the deliverable is a git branch); re-ask.
   - `GIT_ROOT_MISMATCH` but inside a repo (user pointed at a subdirectory) → AskUserQuestion:
     "Use the repo root instead" (recommended) / "Continue with this subdirectory" / "Abort".

2. **Dirty-tree check:**

   ```bash
   git -C <REPO> status --porcelain
   ```

   If uncommitted changes exist, show them and AskUserQuestion: "Continue anyway" or "Let me clean up first".

Record `$REPO` for all subsequent steps.

---

## Phase A — Assess (MANDATORY: delegate to the gcp-to-aws skill)

**CRITICAL: You MUST use the Skill tool to invoke `aws-startup-advisor:gcp-to-aws` (a sibling skill
in this same plugin). Do NOT perform the Assess phase yourself. Do NOT read source code, detect
AI SDKs, or ask Clarify questions manually. The entire Assess phase is handled by the gcp-to-aws
skill — you only invoke it and wait for completion.**

### A1 — Invoke the Assess skill

Call the **Skill** tool with skill name `aws-startup-advisor:gcp-to-aws`.

Before invoking, tell the user:

> "I'm now invoking the gcp-to-aws Assess skill to discover your AI workloads and design
> the Bedrock migration. It will ask you some questions — please answer them. (Don't be
> confused by the skill's `gcp-to-aws` name — it also covers pure AI/LLM migrations with no
> GCP or infrastructure component, which is how it's being used here.)"

After invoking the Skill tool, the `gcp-to-aws` skill instructions will load into context.
Follow those instructions exactly — they will drive the Discover, Clarify, Design, and Estimate
phases through to the decision pack. The source code to scan is at `$REPO`. You do **not** need
`gcp-to-aws` to run its **Generate** (infra Terraform) phase — that is opt-in and produces nothing
this SDK rewrite reads; stopping at the decision pack is enough (A2 confirms readiness).

When Discover creates the run's `.phase-status.json`, it must record `"initiated_by": "LLM_TO_BEDROCK"` beside `owning_skill` (which stays `GCP_TO_AWS`): this run was started by llm-to-bedrock, and that is how telemetry attributes it.

**Important context for the gcp-to-aws skill execution:**

- Source code is at `$REPO` — when the skill asks for GCP sources or scans for files, point it there
- This is an AI/LLM workload migration — the AI path is the goal
- Unless Terraform/IaC files are actually present in `$REPO`, skip IaC discovery
- Unless the user offers billing data, skip billing discovery. If the source provider is
  OpenAI, the skill may instead offer its OpenAI Admin API usage discovery
  (`discover-openai-api.md` — read-only, consent-gated, needs an Admin key with
  **Usage** set to **Read**); accepting it gives Estimate real spend and token volumes without
  manual CSV exports

### A2 — Wait for Assess completion

The `gcp-to-aws` skill is a state machine. After each phase completes, it may stop and wait
for the next invocation. This skill only needs the **Assess artifacts** (`aws-design-ai.json`
from Design, `ai-workload-profile.json` from Discover, `preferences.json` from Clarify) — it
never reads anything Generate produces (Terraform, `MIGRATION_GUIDE.md`, `migration-report.html`).
Those artifacts are all on disk once **Design** completes, so for a pure AI/SDK rewrite you do
**not** need `gcp-to-aws` to run its infra Generate phase. The check below emits `assess-ready`
when **any** of these hold (in this order):

1. **Design done + artifact present** — `phases.design == "completed"` AND `aws-design-ai.json`
   exists. This is the ground truth for the AI path: Design's own completion gate has passed, so
   the model mapping is real, not mid-authoring. (Existence alone is **not** enough — `design-ai.md`
   writes the JSON, and Discover/Clarify wrote their two files even earlier, all **before**
   `design.md` stamps `phases.design`; so a bare "all three files exist" would fire mid-Design.
   Requiring `phases.design == "completed"` is what closes that early-fire window.) This also
   covers the `legacy-generate` back-compat state in `gcp-to-aws/SKILL.md`, which is only reachable
   after Design and therefore already has `phases.design == "completed"`.
2. **Decide-complete** — `current_phase == "complete"` AND `run_mode == "decide"` AND
   `phases.generate == "pending"` AND `DECISION.md` on disk (the normal AI-path end state).
3. **Generate-complete** — `phases.generate == "completed"` (the user also chose to generate infra).

**Workshop guard (all three conditions above):** none of them are trustworthy while
`phases.workshop == "in_progress"`. For a mixed IaC/AI run, `design.md`'s inner-workshop path
explicitly preserves `phases.design == "completed"` while `workshop-refresh.md` is actively
patching preferences and rewriting the design artifacts mid-reprice — so condition 1 (and,
transitively, 2 and 3, since they never regress `phases.design`) can read `assess-ready` while
`aws-design-ai.json` is between an old and a new region/model mapping. `phases.workshop` only
holds `"in_progress"` for the duration of that loop (`workshop.md` § Entry step 3; resolved back
to `"completed"` on exit/decline), so this is a narrow, real interruption window, not a permanent
state. Treat `phases.workshop == "in_progress"` as `not-ready` regardless of what the three
conditions above say, and re-poll after the cap below.

Check progress against the LATEST run directory only (older `.migration/` runs may contain a
stale status):

```bash
MIGRATION_DIR=$(ls -td "$REPO/.migration"/*/ 2>/dev/null | head -1)
# Stdlib-only JSON read — no boto3, so bare python3 is fine here (no pinned env needed).
# Emit one token: assess-ready / not-ready / no-status-file. Ground truth is the Assess the AI
# path actually consumes (see the three conditions above); the phase-status tuples are fallbacks.
python3 - "$MIGRATION_DIR" <<'PY' 2>/dev/null || echo "no-status-file"
import json, os, sys
d = sys.argv[1]
if not d:
    print("no-status-file"); sys.exit()
def has(f): return os.path.exists(os.path.join(d, f))
try:
    s = json.load(open(os.path.join(d, ".phase-status.json")))
except Exception:
    # No readable status file, but the design artifact alone is not trusted (may be mid-Design);
    # without the status we cannot confirm Design's gate passed.
    print("no-status-file" if not has("aws-design-ai.json") else "not-ready"); sys.exit()
ph = s.get("phases", {})
# An active workshop reprice is actively rewriting aws-design-ai.json/aws-design.json between an
# old and a new mapping (workshop-refresh.md), while design.md's inner-workshop path leaves
# phases.design == "completed" throughout — so none of the three readiness conditions below are
# trustworthy while this holds. Checked first and short-circuits to not-ready.
if ph.get("workshop") == "in_progress":
    print("not-ready"); sys.exit()
# phases.design == completed means Design's completion gate passed, so aws-design-ai.json is
# final (not mid-authoring). This also covers the legacy-generate state, which is only reachable
# after Design. Do NOT accept a bare "all three files exist" — Discover/Clarify write their two
# files early, and design-ai.md writes aws-design-ai.json BEFORE the gate, so three-files-present
# fires mid-Design (the early-fire case). A3 remains the artifact-completeness backstop.
design_done = ph.get("design") == "completed" and has("aws-design-ai.json")
generate_done = ph.get("generate") == "completed"
decide_done = (
    s.get("current_phase") == "complete"
    and s.get("run_mode") == "decide"
    and ph.get("generate") == "pending"
    and has("DECISION.md")
)
print("assess-ready" if (design_done or generate_done or decide_done) else "not-ready")
PY
```

- `assess-ready` → proceed to A3 (Assess is done whether or not infra Generate ran). A3 still
  verifies the specific files before Execute reads them.
- `not-ready` / `no-status-file` → the skill needs to run again. Re-invoke
  `aws-startup-advisor:gcp-to-aws` via the Skill tool — it picks up where it left off. (You do
  not need to push it all the way to Generate; stopping at the decision pack is enough.)

**Cap: at most 6 re-invocations.** If it is still `not-ready` after 6, stop and show the user
the last status output — the Assess skill is stuck and needs manual attention; looping further
just burns context.

### A3 — Locate Assess output

Find `$MIGRATION_DIR` (the `.migration/<MMDD-HHMM>/` directory that was created):

```bash
ls -td "$REPO/.migration"/*/ 2>/dev/null | head -1
```

Verify **all three** of these files exist in `$MIGRATION_DIR` (Phase B reads every one):

- `aws-design-ai.json` (model mapping + architecture)
- `ai-workload-profile.json` (detected workloads)
- `preferences.json` (user preferences from Clarify)

If **any** of the three is missing, Assess did not complete the AI path correctly — name the
missing file(s), show the error, and stop. (A2 can now report `assess-ready` from the design
file + `phases.design` alone, so this step is the backstop that guarantees the other two
artifacts Phase B needs are actually present before Execute reads them.)

---

## Phase B — Execute Prep

### B1 — Read Assess outputs

Read `$MIGRATION_DIR/aws-design-ai.json` and extract:

- `ai_architecture.bedrock_models[]` → array of `{source_model, aws_model_id, use_case}`
- Collect all `aws_model_id` values into `$TARGET_MODELS` (array). Keep the `use_case` of each:
  the preflight script probes each model by the right API automatically (Converse for chat,
  InvokeModel for embeddings), but the evaluator's quality scoring only applies to chat models —
  embedding targets get format/dimension validation only.

Read `$MIGRATION_DIR/ai-workload-profile.json` and extract:

- `summary.ai_source` → source provider

Read `$MIGRATION_DIR/preferences.json` and extract:

- `design_constraints.target_region` → `$REGION` (default `us-east-1` if absent)

**Validation:** If `aws-design-ai.json` has no `ai_architecture.bedrock_models[]` array, or the
array is empty, STOP: "Assess output incomplete — model mapping missing."

### B2 — AWS identity confirmation

```bash
aws sts get-caller-identity 2>&1
```

**If the command fails** (no credentials, expired SSO token): show the error and tell the user
to run `aws configure` or `aws sso login` (suggest typing `! aws sso login` to run it in this
session), then re-run B2. Do not proceed without a confirmed identity.

On success, show Account, Arn, UserId via **AskUserQuestion**:
"This AWS identity will be used for Bedrock calls. Is this correct?"

Options:

- **Yes, use this identity** → proceed
- **Use a different AWS profile** → ask which profile, record it as `$AWS_PROFILE_CHOICE`,
  re-run B2 as `aws sts get-caller-identity --profile $AWS_PROFILE_CHOICE`, and re-confirm.
  **Do NOT rely on exporting `AWS_PROFILE`** — env vars do not persist across Bash tool calls
  or into workflow subagents (see B3). Instead pass the choice explicitly everywhere:
  `--profile` on every aws CLI call, and prepend `AWS_PROFILE=$AWS_PROFILE_CHOICE` inline on
  the B4 preflight command and inside the workflow args (`awsProfile` field) so subagents can
  do the same.

Also confirm region: "Bedrock region will be `$REGION`. OK or override?"

### B3 — Source API key (optional)

First, create the artifact directory and make it self-ignoring IMMEDIATELY — before any key
exists, so the secret is never sitting in an unignored working tree (even if the user aborts
before the rewriter runs):

```bash
mkdir -p "$REPO/.saws-migrate" && printf '*\n' > "$REPO/.saws-migrate/.gitignore"
```

Determine `$KEY_ENV_VAR` from B1's source provider (this is the env-var name the baseline
skill's parser expects — a bare key without the `NAME=` prefix will NOT be parsed):

- `openai` → `OPENAI_API_KEY`
- `anthropic` → `ANTHROPIC_API_KEY`
- `google` / `gemini` → `GEMINI_API_KEY`

**The key must never enter this conversation (HARD RULE).** Do not ask the user to paste the
key in chat, and never echo, cat, or interpolate its VALUE into any command, question, or
output — the agent only ever handles the file path. If the user pastes a key into the chat
unprompted, do not use it: tell them it is now part of the transcript, recommend rotating it,
and continue with one of the paths below.

First check whether the key is already present in the shell environment (each Bash call
initializes from the user's profile, so a profile-exported key is visible to every call).
POSIX-safe — `printenv` works in bash and zsh alike (`${!VAR}` indirection is bash-only and
zsh errors on it). This prints presence only, never the value:

```bash
[ -n "$(printenv "$KEY_ENV_VAR")" ] && echo ENV_KEY_PRESENT || echo ENV_KEY_ABSENT
```

**AskUserQuestion:** "Do you have an API key for the source model (e.g. OpenAI key for GPT-4o)?
Providing it enables side-by-side quality comparison. Without it, evaluation uses absolute scoring only."

Options (offer the first only on `ENV_KEY_PRESENT`):

- **Use the `$KEY_ENV_VAR` already in my environment** → materialize env var to file in one
  command — the value never appears in the transcript:

  ```bash
  printf '%s=%s\n' "$KEY_ENV_VAR" "$(printenv "$KEY_ENV_VAR")" > "$REPO/.saws-migrate/.source-provider-env" && chmod 600 "$REPO/.saws-migrate/.source-provider-env"
  ```

  Then run the format check below and set `sourceBaselineAvailable = true`,
  `sourceKeyRef = "$REPO/.saws-migrate/.source-provider-env"`.

- **I'll write it to a file myself** → give the user this command to run in THEIR OWN terminal
  (not through the agent; in Claude Code an `!` prefix runs it in-session) — `read -rs` collects
  the key without echoing it:

  ```bash
  read -rs k && printf '%s=%s\n' "<KEY_ENV_VAR>" "$k" > "<REPO>/.saws-migrate/.source-provider-env" && chmod 600 "<REPO>/.saws-migrate/.source-provider-env" && unset k
  ```

  Substitute the literal env-var name and repo path when presenting it (those are not secrets).
  Then run the format check below and set the same flags as above.

- **Skip** → `sourceBaselineAvailable = false`, `sourceKeyRef = ""`.

Whichever path wrote the file, verify the format (never prints the key; catches a value
written without the `NAME=` prefix, which the baseline parser would silently miss):

```bash
grep -qE '^(OPENAI|ANTHROPIC|GEMINI)_API_KEY=.+' "$REPO/.saws-migrate/.source-provider-env" && echo KEY_FORMAT_OK || echo KEY_FORMAT_BAD
```

On `KEY_FORMAT_BAD`, have the same path that wrote the file rewrite it (do not echo its
contents).

(`.saws-migrate/` is already self-ignoring from the first command above; the rewriter
re-asserts this before any commit as a second layer.)

**IMPORTANT:** The file is the handoff mechanism — do NOT rely on `export` to carry the key
into later steps. Shell state set in one Bash call does not persist into other calls or into
workflow subagents; only a profile-exported variable (the `ENV_KEY_PRESENT` path above) is
reliably visible, and even that must be materialized to the file for the baseline runner.

### B4 — Bedrock preflight

```bash
uv run --project $SCRIPTS python $SCRIPTS/preflight_bedrock.py --region $REGION --models <comma-separated $TARGET_MODELS> --dataset-size 200
```

(`--dataset-size 200` matches the golden-dataset cap, so the quota warning reflects the worst case. Prefix with `AWS_PROFILE=$AWS_PROFILE_CHOICE` if B2 chose a non-default profile.)

Parse the JSON output. On failure the TOP LEVEL carries `reason`/`detail` (lifted from the
first failing model) plus `failing_models` (all failing ids); per-model verdicts are in `models[]`:

- `ok == false` + `reason: credentials` → show the detail (configure/refresh credentials), stop; user re-runs after fixing.
- `ok == false` + `reason: model_access` → model access not enabled in the Bedrock console (NOT an IAM problem): point the user at the console Model access page for the failing models, stop; re-run B4 after they enable it.
- `ok == false` + `reason: authz` → IAM denies inference. For a Converse/InvokeModel target the action to grant is `bedrock:InvokeModel`; for a mantle-only `openai.gpt-5*` target it is the `bedrock-mantle:*` set (see B4a). The `detail` names which. Tell the user the action to grant; stop.
- `ok == false` + `reason: mantle_deps_missing` → the pinned scripts environment lacks `openai` / `aws-bedrock-token-generator`, so a mantle-only target could not be probed at all. This is an environment fault, not a Bedrock verdict: tell the user to re-sync (`uv sync --project $SCRIPTS`) and stop. Do NOT proceed — access was never verified.
- `ok == false` + `reason: model_unavailable` → Read the `resolve-bedrock-model-id` reference at `$HELPERS/resolve-bedrock-model-id/resolve-bedrock-model-id.md` and follow its procedure with each ID from `failing_models` + region. AskUserQuestion with the candidates: "Use `<candidate>` (cross-region inference profile)" / "Paste a different model ID" / "Abort". On a choice, replace the ID in `$TARGET_MODELS` and re-run B4.
- `ok == false` + any other `reason` → show `detail` and stop.
- `ok == true` → proceed. Surface any `quota_warning`, and any model whose `reason` is
  `embedding_unprobed` (embedding family the preflight can't probe — remind the user to confirm
  model access in the console).

---

## Phase C — Execute

Phase C dispatches the five plugin agents sequentially via the **Agent tool** (subagent types
`aws-startup-advisor:llm2bedrock-code-analyzer`, `aws-startup-advisor:llm2bedrock-log-ingestor`, `aws-startup-advisor:llm2bedrock-prompt-evaluator`,
`aws-startup-advisor:llm2bedrock-code-rewriter`, `aws-startup-advisor:llm2bedrock-report-generator`). Each agent writes its result to
a file under `$PHASE_DIR = $REPO/.saws-migrate/phase-results/`; you validate every file with
the bundled validator before moving on. There is no workflow runtime — the files ARE the state.

### The validator (used at every step)

```bash
uv run --project $SCRIPTS python $SCRIPTS/validate_result.py --schema <analysis|ingestion|eval|rewrite|delta-decisions> <file>
```

- Exit 0 + `RESULT=valid CONTROL=ok` → phase completed; proceed.
- Exit 0 + `CONTROL=blocked REASON=<r>` → blocked flow (below).
- Exit 0 + `CONTROL=partial COMPLETED=<n> TOTAL=<m>` → partial flow (eval only).
- Exit 1 (`RESULT=invalid` + error lines) or exit 2 (file missing) → **stateless fixer retry**:
  dispatch a FRESH agent of the same type whose prompt is the original context block + the
  file path + the validator's verbatim error output + the instruction "fix ONLY the output
  file at `<path>` so it validates; do not redo the phase's work unless a required field is
  genuinely missing from it". Cap 2 retries per phase; then stop and show the errors.

### The context block (instantiated at every dispatch)

Build this exact line format (agents parse the labels). Omit lines marked optional when empty:

```
Repository: <$REPO>
AWS region: <$REGION>
AWS profile (pass as --profile / AWS_PROFILE= inline on every aws/boto3 invocation): <$AWS_PROFILE_CHOICE — omit line if default>
Target Bedrock model(s): <comma-joined $TARGET_MODELS, with any resolved overrides already applied>
Migration plan dir: <$MIGRATION_DIR>
Resolved target model id: <override for the primary chat model — omit if none>
Scripts directory (pinned uv toolchain): <$SCRIPTS>
Report date suffix: <saved suffix from run-context — C5/C6 dispatches only>
Source baseline available: <true|false>
Source provider env file: <path — omit if none>
User-supplied log files: <comma-joined — omit if none>
Golden dataset cap (max cases the ingestor may emit): 200
Phase results directory: <$PHASE_DIR>
Prior phase results (Read these files): <paths of already-validated phase JSONs>
Confirmed behavior-delta decisions file (Read it): <$PHASE_DIR/delta-decisions.json — C5 only>
<helper-reference lines — inject ONLY the ones this agent needs, per the table below>
```

Prior-phase results are passed as FILE PATHS — never inline their JSON into the prompt.

**Helper references (the former helper skills, now under `$HELPERS`).** Agents no longer
load skills by name; instead the agent Reads a helper reference at an absolute path you
inject. For each dispatch, add ONLY the helper lines that agent uses (per its `# 4` section):

| Agent (dispatch)                                             | Helper-reference lines to add                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 llm2bedrock-code-analyzer                                 | `behavior-delta-detection reference: $HELPERS/behavior-delta-detection/behavior-delta-detection.md`; `resolve-bedrock-model-id reference: $HELPERS/resolve-bedrock-model-id/resolve-bedrock-model-id.md`                                                                                                         |
| C5 llm2bedrock-code-rewriter                                 | `bedrock-known-fixes reference: $HELPERS/bedrock-known-fixes/bedrock-known-fixes.md`; `behavior-delta-detection reference: $HELPERS/behavior-delta-detection/behavior-delta-detection.md`; `dependency-conflict-resolution reference: $HELPERS/dependency-conflict-resolution/dependency-conflict-resolution.md` |
| C3 llm2bedrock-prompt-evaluator                              | `bedrock-known-fixes reference: $HELPERS/bedrock-known-fixes/bedrock-known-fixes.md`; `resolve-bedrock-model-id reference: $HELPERS/resolve-bedrock-model-id/resolve-bedrock-model-id.md`; `run-source-model-baseline reference: $HELPERS/run-source-model-baseline/run-source-model-baseline.md`                |
| C2 llm2bedrock-log-ingestor, C6 llm2bedrock-report-generator | (none — these agents load no helpers)                                                                                                                                                                                                                                                                            |

Expand `$HELPERS` to its absolute path (you have `<SKILL_BASE>`) so the subagent — where
`${CLAUDE_PLUGIN_ROOT}` is empty — receives a resolvable absolute path.

### C0 — Run-context gate (resume safety)

The Eval phase makes one paid Bedrock call per golden case (and, with a source key, one paid
source-provider call per case). Before any dispatch, tell the user evaluation will invoke
Bedrock at their expense, capped at 200 cases.

1. `mkdir -p $PHASE_DIR`. Build `$PHASE_DIR/current-context.json` with exactly these fields
   (hashes via `shasum -a 256`; key hash is a fingerprint — never store the key value):

```json
{
  "repo_root": "<cd $REPO && pwd -P>",
  "migration_dir": "<$MIGRATION_DIR>",
  "region": "<$REGION>",
  "aws_profile": "<$AWS_PROFILE_CHOICE or \"\">",
  "aws_account": "<Account from B2>",
  "repo_head_sha": "<git -C $REPO rev-parse HEAD>",
  "repo_branch": "<git -C $REPO rev-parse --abbrev-ref HEAD>",
  "repo_dirty_sha256": "<sha256 of: git status --porcelain + git diff + git diff --cached, EACH with pathspecs -- . ':(exclude).saws-migrate' ':(exclude).migration' ':(exclude)MIGRATION_REPORT_*.md'; \"\" when all three are empty>",
  "target_models": [{"source_model": "...", "aws_model_id": "...", "use_case": "..."}],
  "resolved_model_overrides": {},
  "source_provider": "<from B1>",
  "source_baseline_available": <true|false from B3>,
  "source_key_sha256": "<sha256 of .source-provider-env contents, \"\" when absent>",
  "log_files": [{"path": "...", "sha256": "..."}],
  "max_golden_cases": 200,
  "assess_design_sha256": "<sha256 of $MIGRATION_DIR/aws-design-ai.json>",
  "report_date_suffix": "<date +%Y-%m-%d>",
  "schema_version": 1,
  "plugin_version": "<version from <plugin>/.claude-plugin/plugin.json>"
}
```

1. **Stage 0 (post-C5 normalization).** If `$PHASE_DIR/rewrite.json` exists and validates as
   a payload (`CONTROL=ok`), do NOT use live `repo_*` values. Run three integrity checks:
   (1) `rewrite.baseline_parent_sha` equals the SAVED `repo_head_sha`; (2) `git rev-parse
<rewrite.branch_name>` equals `rewrite.branch_tip_sha`; (3) `git status --porcelain` (with
   the artifact exclusions) is empty. All pass → copy the saved `repo_*` values into
   current-context verbatim, continue to step 3. Check 2 fails (tip moved) → STOP and
   AskUserQuestion: "Keep your commits (regenerate report only, with a mixed-authorship note)"
   / "Reset the branch to the rewriter's tip and regenerate from C6" / "Abort". Check 3 fails
   (dirty tree) → STOP and ask: commit/stash (then re-check) or discard the edits. Check 1
   fails → treat as a full `repo_*` mismatch in step 3.

2. If `$PHASE_DIR/run-context.json` exists, compare:

```bash
uv run --project $SCRIPTS python $SCRIPTS/validate_result.py --check-run-context $PHASE_DIR/run-context.json --current $PHASE_DIR/current-context.json
```

- `RUN_CONTEXT=match` → resume: walk C1→C2→C3→(C4: delta-decisions.json)→C5→(C6: report
  file) in order; a phase counts completed iff its file validates with `CONTROL=ok` (C6:
  iff `MIGRATION_REPORT_<saved suffix>.md` exists while rewrite.json is payload-valid).
  STOP the walk at the first missing/invalid/control-state file — blocked/partial files
  route to their flows below, NEVER count as completed. Offer the user "skip completed
  phases X..Y, resume at Z". Files after an unexplained gap: archive them with the gap.
- `RUN_CONTEXT=mismatch` → scoped invalidation. Map each MISMATCH line through this table,
  archive the named units to `$REPO/.saws-migrate/phase-results-archive/<saved suffix>-$(date +%H%M%S)/`
  (a SIBLING of phase-results/ — never nest it inside), **then immediately overwrite
  run-context.json with current-context.json** (carrying forward the saved
  `report_date_suffix` unless REPORT itself is being invalidated), then re-run the
  invalidated phases in order. Tell the user which fields differed and what re-runs.

| Mismatched field(s)                                                                                                               | Archive (units)                 | Keep      |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------- |
| repo_root, migration_dir, region, aws_profile, aws_account, source_provider, assess_design_sha256, schema_version, plugin_version | everything                      | —         |
| repo_head_sha / repo_branch / repo_dirty_sha256                                                                                   | everything                      | —         |
| target_models / resolved_model_overrides                                                                                          | ANALYSIS, EVAL, REWRITE, REPORT | INGESTION |
| log_files / max_golden_cases                                                                                                      | everything                      | —         |
| source_key_sha256 / source_baseline_available                                                                                     | ANALYSIS, EVAL, REWRITE, REPORT | INGESTION |

Units: ANALYSIS = analysis.json · INGESTION = ingestion.json + `.saws-migrate/golden-dataset/`
· EVAL = eval.json + `.saws-migrate/eval-results/` (minus cost_compare.py) · REWRITE =
rewrite.json + delta-decisions.json · REPORT = `MIGRATION_REPORT_<saved suffix>.md`.

**Post-C5 reruns of C1–C3 need the pre-migration tree.** If rewrite.json was payload-valid
and the table invalidates ANALYSIS/INGESTION/EVAL: confirm with the user that the old
migration branch will be discarded (keep-or-reset flow first if the tip moved), then
`git checkout <saved repo_branch>`, delete the old branch and the `saws-migrate-baseline`
tag, and re-run from C1. If the user declines, stop — re-analyzing a tree that contains
the rewrite produces garbage.

1. No saved run-context → fresh run: write current-context.json as run-context.json, dispatch C1.

### C1 — Analyzer · C2 — Ingestor · C3 — Evaluator

For each phase in order, dispatch the agent with the context block (listing all
prior-phase file paths), then validate its output file:

| Step | agentType                                          | Output file                 | Schema    |
| ---- | -------------------------------------------------- | --------------------------- | --------- |
| C1   | `aws-startup-advisor:llm2bedrock-code-analyzer`    | `$PHASE_DIR/analysis.json`  | analysis  |
| C2   | `aws-startup-advisor:llm2bedrock-log-ingestor`     | `$PHASE_DIR/ingestion.json` | ingestion |
| C3   | `aws-startup-advisor:llm2bedrock-prompt-evaluator` | `$PHASE_DIR/eval.json`      | eval      |

**Blocked flow** (`CONTROL=blocked`): resolve with the user per REASON —

- `model_access` → user enables the model in the Bedrock console (nothing fingerprinted
  changes; re-dispatch the blocked phase only)
- `model_unresolvable` → user picks/pastes an ID → record it in
  `resolved_model_overrides`, fold it into the Target line
- `source_key_auth` → user supplies a new key (re-run B3) or sets baseline unavailable
- `authz` → IAM denies inference. The `detail` names the action set to grant:
  `bedrock:InvokeModel*` for a Converse target, or the `bedrock-mantle:*` actions
  (`CreateInference`, `CallWithBearerToken`) for a mantle-only `openai.gpt-5*` target.
  User fixes IAM; nothing fingerprinted changes, so re-dispatch the blocked phase only.
  Do NOT route this to `model_access` — the console Model access page is the wrong fix
  for an IAM denial and vice versa.
- `mantle_deps_missing` → the pinned scripts environment lacks `openai` /
  `aws-bedrock-token-generator`, so a mantle target could not be probed at all. User
  re-syncs (`uv sync --project $SCRIPTS`); re-dispatch the blocked phase only. Access was
  never verified, so do not treat a previous pass as still valid.
- `assess_output_missing` → re-run Phase A, then restart Phase C at C0

After ANY resolution, re-run the C0 recipe (rebuild current-context, apply the invalidation
table, overwrite run-context) and re-dispatch **from the earliest invalidated phase** — the
table, not the block location, decides where execution resumes.

**Partial flow** (eval only, `CONTROL=partial`): AskUserQuestion —

- **Continue remaining cases** → re-dispatch the evaluator with the extra context line:
  `Resume: raw_results.jsonl already contains completed cases — evaluate only prompts whose
ids are not present in it, then re-score and overwrite eval.json`
- **Proceed with partial pass rate** → re-dispatch the evaluator with: `Finalize partial: do
NOT call Bedrock again — score the cases already in raw_results.jsonl and emit the FULL
eval payload over only those cases, with total_cases = the number scored and a notes prefix
line 'partial_coverage: <completed>/<total> cases (throttled)'`. Then C4 runs normally.
- **Abort** → stop; the files stay on disk for a later C0 resume.

### C4 — Sidebar (two gates) + persist decisions

**Gate (a) — Quality go/no-go.** Read `$PHASE_DIR/eval.json`. The threshold is
**pass rate >= 0.9 AND `source_baseline_quality != 'poor'`** (with `no_golden_cases: true`
in the notes there is no quality signal — always ask). At or above → proceed silently.
Below, AskUserQuestion:

- **Proceed anyway** → gate (b)
- **Change target model** → record in `resolved_model_overrides`, re-run C0 (the table
  invalidates ANALYSIS/EVAL and execution resumes at C1). Cap: 2 retries.
- **Abort** → stop, no code touched.

**Gate (a.5) — Rewrite strategy (from migration plan).** Read `migration_path` from
`$MIGRATION_DIR/aws-design-ai.json` → `ai_architecture.code_migration.migration_path`.
If the value **starts with** `"mantle"` (`"mantle"`, `"mantle_openai_responses"`), set
`rewrite_strategy = "mantle"`. Otherwise (value is `"converse"`, `"gpt-oss"`, or the field is
absent), set `rewrite_strategy = "converse"`.
No user question needed — the decision was already made during the Assess/Design phase.

Match on the prefix, not on equality: Design writes the more specific
`"mantle_openai_responses"` for a same-model OpenAI migration, and an equality check against
`"mantle"` would silently route those runs down the Converse path — rewriting working
same-model code into a boto3 Converse client against a model that has no Converse surface.

**Gate (b) — Behavior-delta resolution.** For each `analysis.behavior_deltas[]` with
`user_visible == true`, AskUserQuestion with the options from the `behavior-delta-detection`
reference (Read `$HELPERS/behavior-delta-detection/behavior-delta-detection.md`, and the
`source_provider` sub-reference under its `references/` dir).

**Persist:** write the decisions array (entries `{delta_type, location, resolution_chosen,
source}`; `[]` when there were no user-visible deltas) to `$PHASE_DIR/delta-decisions.json`
and validate it (`--schema delta-decisions`). The file must exist before C5 — it is what
makes a C5 retry or a post-crash resume self-sufficient.

### C5 — Rewriter · C6 — Report

| Step | agentType                                          | Output                                            | Schema                                          |
| ---- | -------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| C5   | `aws-startup-advisor:llm2bedrock-code-rewriter`    | `$PHASE_DIR/rewrite.json`                         | rewrite                                         |
| C6   | `aws-startup-advisor:llm2bedrock-report-generator` | `MIGRATION_REPORT_<saved suffix>.md` in repo root | (none — file existence is the completion check) |

C5's context block includes the `Confirmed behavior-delta decisions file` line and the
`Report date suffix` line (from run-context, NOT today's date on a resume). C6's context
block lists all four phase-result file paths.

When `rewrite_strategy == "mantle"`, C5's context block ALSO includes:

- `Rewrite strategy: mantle` (omit this line entirely for Converse — its absence is the
  signal for the default Converse path)
- `Mantle model map: <source-model> -> <bedrock-model-id>` — sourced from the plan's
  `ai_architecture.bedrock_models[]` entries (each `source_model` → `aws_model_id` pair).
- `Mantle surface: responses` and `Mantle base path: /openai/v1` when any mapped
  `aws_model_id` is a proprietary GPT model (`openai.gpt-5*`). These are served only on the
  `/openai/v1` path via the Responses API — distinct from the `v1` path other mantle models
  use — so the rewriter must not emit a `/v1` base URL or a Chat Completions call for them.
  See `gcp-to-aws/references/shared/openai-on-bedrock.md`.
- `Same model: true` when `bedrock_models[].model_change` is `false`. Signals the rewriter to
  keep model parameters untouched and limit changes to the endpoint, credential, model id, and
  (if the source used Chat Completions) the surface reshape.

### C7 — Render summary

```bash
uv run --project $SCRIPTS python $SCRIPTS/render_report.py --phase-results $PHASE_DIR --repo $REPO --date-suffix <saved suffix>
```

Print the summary. Point the user at `rewrite.branch_name` (usually `bedrock-migration`, but
a collision-suffixed variant like `bedrock-migration-2` when they already had that branch)
and the report file. Tell them how to undo — substitute the ACTUAL branch name from
`rewrite.branch_name`, never a hardcoded one (on a collision run, `bedrock-migration` is the
user's own pre-existing branch and deleting it would destroy their work):

> To discard: `git checkout <your original branch>`, `git branch -D <rewrite.branch_name>`,
> `git tag -d saws-migrate-baseline`, and `rm -rf .saws-migrate .migration` removes all
> migration artifacts (including the API key file).

---

## Inline mode (platforms without an Agent/subagent dispatch tool)

If this platform has no subagent dispatch tool, run phases inline ONE AT A TIME, with a
mandatory stop between phases:

1. `Read` exactly ONE agent definition (`<plugin>/agents/<name>.md`) — never load more than
   one phase's definition into context at once.
2. Follow it start-to-finish; write and validate the same phase-result file.
3. STOP. Report the phase outcome (validator CONTROL line + one-line summary) and ask the
   user to confirm before loading the next phase's definition. This sidebar is mandatory:
   it is the context-pressure release valve, and the phase-result file means nothing is lost
   if the user continues in a fresh session instead.

Warn the user up front that inline mode is slower and context-heavier than subagent dispatch,
and that the rewriter phase performs git operations (branch, commits, worktree) directly in
this session.

---

## Failure handling

- An agent dispatch dies (tool error, terminal failure) → the phase file is missing →
  validator exit 2 → the stateless fixer-retry path (which, finding no file to fix, re-runs
  the phase). Do not auto-retry more than the 2-retry cap.
- User aborts at any gate → confirm no SOURCE CODE was modified (C5 never started if aborted
  before then). Note that `.migration/` and `.saws-migrate/` artifacts do exist; show the
  undo commands from C7 if the user wants them gone.
- Assess skill fails → show the error and stop. User can re-run `/aws-startup-advisor:llm-to-bedrock`.

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
