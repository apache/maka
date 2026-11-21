---
name: remediating-with-aws-security-agent
description: >-
  Pull AWS Security Agent findings (penetration tests and code reviews) and drive
  remediation. Use this whenever the user mentions Security Agent, security findings,
  pentest or penetration test results, code review findings, vulnerabilities found in
  their AWS account, "what did the security scan find", remediating or triaging security
  risks, or wants to start fixing reported vulnerabilities — even if they don't name the
  service explicitly. Trigger it for phrases like "get my security findings", "what
  vulnerabilities do we have", "let's fix the pentest results", or "triage the security
  report". The skill discovers scans, exports findings to a gitignored local directory
  (so sensitive exploit detail is never committed), produces a prioritized triage
  summary, and offers to start fixing the highest-risk issues.
---

# Security Agent Remediation

AWS Security Agent is a frontier agent that runs on-demand penetration tests and code
reviews against a customer's applications and reports verified security risks. This skill
takes you from "I have findings somewhere in AWS" to "I'm actively fixing the most
important ones," while keeping the sensitive exploit detail out of source control.

The flow has four stages, and they matter in order:

1. **Discover** which scans exist and how the account is configured (live, read-only).
2. **Export** the findings to a local gitignored directory.
3. **Triage** the findings into a prioritized, human-readable plan.
4. **Remediate** by offering to fix the highest-risk issues.

## Why the ordering and the guardrails matter

Findings contain working attack scripts, reproduction steps, file paths, and sometimes
leaked secrets or environment details. If that lands in a Git repo, a customer can
accidentally commit and publish a step-by-step exploit for their own production system.
So the non-negotiable rule is: **findings are written only to `.security-agent/`, and that
path is gitignored before anything is written.**

## Stage 1: Discover scans (live, read-only)

Find out what the account has. All commands are read-only `list-*` operations.

AWS Security Agent organizes data as a hierarchy — work down it:

```
Application (account + Region)
└── Agent Space        (workspace for design review, code review, and pentests)
    ├── Penetration test → Pentest job → Findings
    └── Code review      → Code review job → Findings
```

Run these to orient yourself and show the user what exists:

```bash
aws securityagent list-agent-spaces
aws securityagent list-pentests          --agent-space-id <as-...>
aws securityagent list-code-reviews      --agent-space-id <as-...>
aws securityagent list-pentest-jobs-for-pentest         --agent-space-id <as-...> --pentest-id <pt-...>
aws securityagent list-code-review-jobs-for-code-review --agent-space-id <as-...> --code-review-id <cr-...>
```

Job `status` is one of `IN_PROGRESS`, `STOPPING`, `STOPPED`, `FAILED`, `COMPLETED`. Only
`COMPLETED` jobs have a stable, full set of findings.

### Match the codebase to a scan, then confirm

Agent spaces, pentests, and code reviews are named after the application they target.
Before asking the user to pick from a raw list, make an informed guess about which scan
corresponds to _this_ repository — the user is working in a codebase for a reason, and
the relevant findings are almost always for the app in front of them.

Infer the app identity from the workspace using cheap, high-signal sources:

- The repository / root directory name and the Git remote URL (`git remote -v`).
- Project manifests and their `name`/`description` (`package.json`, `pyproject.toml`,
  `*.csproj`, `go.mod`, `Cargo.toml`).
- README titles, product/steering docs, and any obvious product or company name.
- Distinctive frameworks or domains that match a scan title.

Compare those signals against the agent space / scan names (case-insensitive, allow
partial and fuzzy matches).
Then **always confirm before exporting** — present your best guess and your reasoning, and
let the user correct it:

> "This repo looks like **`<product>`** (from `<signal>`), which matches the **<name>** agent
> space. Use that, or pick another? [Other Agent Space names, ...]"

If nothing matches with reasonable confidence, say so plainly and show the full list rather
than forcing a wrong guess. Never export from a guessed scan without the user's confirmation.

## Stage 2: Export findings to `.security-agent/` (gitignored)

Pull findings using AWS CLI commands. Write everything into `.security-agent/` in the repo —
never to chat or stdout — because findings include working attack scripts, reproduction
steps, and sometimes leaked secrets.

### 1. Lock down the output directory before pulling anything

```bash
mkdir -p .security-agent
echo '*' > .security-agent/.gitignore
```

### 2. Resolve the latest COMPLETED job

You should already have the `agentSpaceId` and the pentest/code-review id from Stage 1.
List jobs for the chosen scan:

```bash
# Pentest jobs:
aws securityagent list-pentest-jobs-for-pentest \
  --agent-space-id <as-...> --pentest-id <pt-...>

# Code review jobs:
aws securityagent list-code-review-jobs-for-code-review \
  --agent-space-id <as-...> --code-review-id <cr-...>
```

Paginate by passing `--next-token` from the previous response until absent. Filter the
job summaries to `status == "COMPLETED"`. If none are COMPLETED, stop and tell the user
"No completed jobs found. Please wait for a job to complete or check job statuses."
Otherwise, pick the COMPLETED job with the greatest `createdAt` timestamp.

### 3. List finding summaries and filter by confidence

```bash
# Pentest findings:
aws securityagent list-findings \
  --agent-space-id <as-...> --pentest-job-id <pj-...>

# Code review findings:
aws securityagent list-findings \
  --agent-space-id <as-...> --code-review-job-id <cj-...>
```

Paginate on `--next-token` until exhausted. Confidence values from weakest to strongest:
`FALSE_POSITIVE`, `UNCONFIRMED`, `LOW`, `MEDIUM`, `HIGH`.
**Keep only `HIGH` and `MEDIUM` by default.** Widen only when the user explicitly asks.

### 4. Fetch full detail in batches of 25

`batch-get-findings` accepts at most 25 ids per call. Chunk the filtered finding ids into
groups of 25:

```bash
aws securityagent batch-get-findings \
  --agent-space-id <as-...> \
  --finding-ids <fid-1> <fid-2> ... <fid-25>
```

Tag each returned finding with its source (`pentest` or `code-review`) before writing,
so triage in Stage 3 can tell them apart.

### 5. Write findings into `.security-agent/`

Group findings by job id. For each job, write a full markdown report to
`.security-agent/findings_<jobId>.md` with ALL fields returned by the API (findingId,
name, description, riskLevel, riskType, confidence, status, codeLocations, remediationCode,
and any other fields). Do not leave off any fields.

### Edge cases

- **No agent space, scan, or COMPLETED job** — stop and surface that to the user rather
  than retrying.
- **Credentials or service unavailable** — confirm with `aws sts get-caller-identity` and
  check the Region (default `us-east-1`; Security Agent is regional).
- **Don't paste finding contents into chat** beyond short titles and counts. The detail
  belongs in the gitignored files.

## Stage 3: Triage into a prioritized plan

Rank by risk, because remediation time is finite and a CRITICAL unauthenticated RCE
outranks a LOW informational finding every time. Read the exported `findings_*.md`
files from `.security-agent/` and sort them deterministically.

### Ranking rules

Sort ascending by this composite key (lower wins, i.e. more urgent first):

1. **Risk level**, in this order:
   `CRITICAL` (0) → `HIGH` (1) → `MEDIUM` (2) → `LOW` (3) → `INFORMATIONAL` (4) →
   `UNKNOWN` / missing (5).
2. **Risk score**, highest first. `riskScore` is a numeric string on pentest findings
   (e.g. `"10.0"`), often absent on code-review findings — treat missing as the lowest
   possible score so it sorts after scored findings of the same level.
3. **Confidence**, in this order:
   `HIGH` (0) → `MEDIUM` (1) → `LOW` (2) → `UNCONFIRMED` (3) → `FALSE_POSITIVE` (4).

Also compute a severity-count summary across all findings (e.g. `2 CRITICAL · 5 HIGH ·
3 MEDIUM`) for the header of the report.

### Pulling the code location

For each finding, derive a single short `location` string:

- If `filePath` is set, use it as-is.
- Otherwise, take `codeLocations[0]`. Strip the scanner's sandbox prefix from `filePath`
  (everything up to and including that marker) so the path is repo-relative; if that
  marker isn't present, fall back to the basename. Append `:<lineStart>` when present.
- If neither is available (typical for some pentest findings), leave it blank and
  describe the affected endpoint or attack chain in the impact line instead.

### Summary format

Write a compact summary for the user:

```
## Security Agent triage — <agent space name>

<N> findings exported (<P pentest, C code review>) · confidence: <levels> · severity: <counts>

### Priority order
1. [CRITICAL · score 10.0 · HIGH confidence] <finding name>
   - Type: <riskType> · Source: <pentest|code-review>
   - Where: <file:line or endpoint, if present>
   - Impact: <one-line plain-language summary>
2. [HIGH · ...] ...

### Recommended remediation order
<short rationale: which to fix first and why — e.g. "1 and 3 are both
unauthenticated RCE on internet-facing endpoints; fix those before the
stored-XSS issues.">
```

If more than ~10 findings, show the top N in detail and summarize the rest as a count
by severity at the bottom.

### What to keep out of chat

The full `description`, `reasoning`, and `attackScript` stay in the gitignored files —
they contain working exploit detail. In the chat summary keep impact lines to one line
each, in plain language. Code-review findings usually carry a `filePath`/location and a
`suggestedFix`; call those out since they map directly to repo changes. Pentest findings
describe endpoints and attack chains; map them to the responsible code where you can.
Look for findings that corroborate each other (a pentest and a code review flagging the
same root cause) — those are strong signals for what to fix first.

## Stage 4: Offer to remediate

After presenting the triage, offer to start fixing — don't silently begin editing code.

Ask the user something like: "Want me to start fixing the top finding(s)? I'd recommend
starting with #1 (<name>)." If they agree, work top-down by priority:

1. Read the finding detail from the gitignored export file (location, description, suggested fix).
2. Open the affected file and apply the fix via the editor.
3. Report one line per fix: "Fixed {name} in `{filePath}:{lineStart}`."

If the user wants to handle several findings, fix one at a time (or one cluster of related
findings) so each change stays reviewable, and proceed in the priority order from Stage 3.

## Notes and edge cases

- **No completed jobs**: a scan may still be `IN_PROGRESS`. Tell the user; offer to re-check
  later rather than exporting a partial job.
- **Re-running**: each run overwrites the files for that job id. The directory is safe to
  delete; it only holds exported copies, not source-of-truth data.
- **Multiple accounts/Regions**: findings are Region-scoped. If the user expected results
  and got none, confirm the region matches where Security Agent is configured.
- **Data handling**: treat exported findings as sensitive. They are copies of verified
  exploits against the user's own systems.
