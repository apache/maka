---
name: scanning-with-aws-security-agent
description: Run an AWS Security Agent scan on the workspace — uploads the source to AWS, scans it with the managed Security Agent service, and returns ranked, verified findings with code locations and remediations. Use when the user asks to scan code, find vulnerabilities, run a security scan or review, check security issues, check scan status, show findings, list recent scans, or stop a scan.
---

# AWS Security Agent — Code Scans

This skill handles full repository scans. Setup (agent space, role, bucket) is handled by the **`setup-security-agent`** skill — if `.security-agent/config.json` is missing, the scan workflow auto-runs setup inline first.

---

## Action mapping

| User intent                                                  | Workflow                                 |
| ------------------------------------------------------------ | ---------------------------------------- |
| Direct scan request ("scan my code", "find vulnerabilities") | Full Scan                                |
| Scan status check ("how's the scan", "progress")             | Status workflow                          |
| View findings ("what did it find", "show results")           | Findings workflow                        |
| List scans ("recent scans", "show my scans")                 | Read `.security-agent/scans.json`        |
| Stop a scan                                                  | `aws securityagent stop-code-review-job` |

### Rules for proactive suggestions

- Always ask before running — never auto-trigger scans
- Single-line suggestions, not multi-paragraph pitches
- If the user declines, do not bring it up again in the same session

---

## Local state

Read `.security-agent/config.json` for `agent_space_id` and `region`. If `config.json` is missing, tell the user one line — "First scan in this workspace — running setup first." — and run the **`setup-security-agent`** workflow inline (steps from that skill's SKILL.md) before continuing. First-time scans should "just work."

Track scans in `.security-agent/scans.json` (keep last 50 entries). The per-workspace CodeReview ID is stored in `config.json → code_reviews[<abs_path>]` so subsequent scans reuse the same CodeReview.

### Resolving the values you need

The CLI examples below use placeholders. Resolve them at the start of every scan:

| Placeholder          | How to resolve                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `<id>` (agent space) | `config.agent_space_id`                                                                      |
| `<region>`           | `config.region` (default `us-east-1`)                                                        |
| `<account>`          | `aws sts get-caller-identity --query Account --output text` (cache for the rest of the turn) |
| `<role-arn>`         | `arn:aws:iam::<account>:role/SecurityAgentScanRole`                                          |
| `<bucket>`           | `security-agent-scans-<account>-<region>`                                                    |
| `<cr-id>`            | `code_review_id` from `config.json → code_reviews[<abs_path>]`                               |
| `<job_id>`           | `codeReviewJobId` returned by `start-code-review-job`                                        |
| `<WORKSPACE_ID>`     | `printf '%s' "$(pwd)" \| md5sum \| cut -c1-12`                                               |

These are derived rather than stored in config so they can never drift out of sync with reality.

---

## Pre-scan checks

1. **Read `config.json`.** If missing → run the `setup-security-agent` workflow inline first, then continue.
2. **Verify agent space still exists:**

   ```bash
   aws securityagent batch-get-agent-spaces --agent-space-ids <id>
   ```

   If response shows it doesn't exist, clear `agent_space_id` from `config.json` and run `setup-security-agent` again.

3. **Resolve account, role ARN, and bucket name** from the table above.
4. **Generate workspace ID:**

   ```bash
   WORKSPACE_ID=$(printf '%s' "$(pwd)" | md5sum | cut -c1-12)
   ```

---

## Workflow: Full Scan (~45 min)

For scanning only changed code, use the `diff-scanning-with-aws-security-agent` skill instead. For threat modeling specs, use `threat-modeling-with-aws-security-agent`.

1. Run pre-scan checks above.
2. **Zip the workspace.** Exclude common build/cache directories. Honor `.gitignore`. Bail if zip > 2 GB.

   ```bash
   cd <absolute-workspace-path>
   zip -r /tmp/source.zip . \
     -x ".git/*" \
     -x ".security-agent/*" \
     -x "node_modules/*" \
     -x "__pycache__/*" \
     -x ".venv/*" -x "venv/*" \
     -x "dist/*" -x "build/*" -x "target/*" \
     -x ".mypy_cache/*" -x ".pytest_cache/*" -x ".tox/*" \
     -x ".next/*" -x "cdk.out/*" \
     -x ".DS_Store" -x "Thumbs.db" \
     -x "*.pyc" -x "*.pyo"
   ZIP_BYTES=$(stat -f%z /tmp/source.zip 2>/dev/null || stat -c%s /tmp/source.zip)
   if [ "$ZIP_BYTES" -gt 2147483648 ]; then echo "Zip too large (>2GB)"; exit 1; fi
   ```

3. **Upload** to the per-workspace stable key (overwrites any prior upload):

   ```bash
   aws s3 cp /tmp/source.zip s3://<bucket>/security-scans/source/<WORKSPACE_ID>/source.zip --expected-bucket-owner <account>
   ```

4. **Get or create the per-workspace CodeReview.** Look up `config.json → code_reviews[<abs_path>]`.
   - If present, use that `code_review_id`.
   - If absent, create:

     ```bash
     aws securityagent create-code-review --agent-space-id <id> --title <title> \
       --service-role <role-arn> \
       --assets sourceCode=[{s3Location=s3://<bucket>/security-scans/source/<WORKSPACE_ID>/source.zip}]
     ```

     Capture `codeReviewId` and persist to `config.json → code_reviews[<abs_path>]`.

   - Title default: `pre-cr-<git-branch>` (use `git rev-parse --abbrev-ref HEAD`). Replace any spaces with hyphens.
5. **Start the job:**

   ```bash
   aws securityagent start-code-review-job --agent-space-id <id> --code-review-id <cr-id>
   ```

   - **If the response is `ResourceNotFoundException`**: the CodeReview was deleted externally. Recreate it (step 4) and retry.

6. Capture `codeReviewJobId`. Generate a local `scan_id` like `scan-<8-hex>`. Append to `scans.json`:

   ```json
   {
     "scan_id": "scan-...",
     "code_review_id": "cr-...",
     "job_id": "cj-...",
     "agent_space_id": "as-...",
     "scan_type": "FULL",
     "title": "pre-cr-main",
     "path": "/abs/path",
     "started_at": "2026-06-01T20:00:00Z",
     "status": "IN_PROGRESS"
   }
   ```

7. Tell user: "Full scan started (scan_id: {id}). Takes ~45 minutes. I'll check every 5 minutes — say 'stop polling' to opt out."
8. Run the **Polling Loop** below with `sleep 300` between checks.

---

## Polling Loop

After starting a scan:

1. `sleep 300` (5 minutes). Do **not** poll faster than this.
2. Call status:

   ```bash
   aws securityagent batch-get-code-review-jobs --agent-space-id <id> --code-review-job-ids <job_id>
   ```

3. Compare `status` to last seen status. Only respond to the user when status CHANGES (e.g., `IN_PROGRESS` → `COMPLETED`) or on terminal state (`COMPLETED`, `FAILED`, `STOPPED`).
4. Do not report "still in progress" multiple times — that's noise.
5. If user says "stop polling" or "check later" → stop the loop and tell them: "Say 'scan status' or 'show findings' anytime."
6. On `COMPLETED` → run the **Findings** workflow.
7. On `FAILED` → fetch the job's error info (`statusReason` if present), tell the user, write a brief failure note to `.security-agent/findings-{scan_id}.md`.

---

## Workflow: Status check (ad-hoc)

User says "scan status" / "how's the scan":

1. If user names a `scan_id`, use it. Otherwise use the most recent entry in `scans.json`.
2. Call `batch-get-code-review-jobs` once.
3. Update `scans.json` status field.
4. Report: status + elapsed time + current step (if any).

---

## Workflow: Findings

After a scan completes (or on user request):

### 1. Fetch findings (paginate)

```bash
aws securityagent list-findings --agent-space-id <id> --code-review-job-id <job-id>
```

If `nextToken` is returned, call again with `--next-token <token>` until exhausted.

### 2. Enrich with full details

```bash
aws securityagent batch-get-findings --agent-space-id <id> --finding-ids <id1> <id2> ...
```

### 3. Filter (optional)

If the user asked for a minimum severity (e.g., "high and above"), filter to that level:

- Severity order: CRITICAL > HIGH > MEDIUM > LOW > INFORMATIONAL.

### 4. Concise summary in chat

Group by severity. File path + line for each:

```
🟣 CRITICAL: {name}
   File: {filePath}:{lineStart}
   {description}

🔴 HIGH: {name}
   File: {filePath}:{lineStart}
   {description}

🟡 MEDIUM: {name}
   File: {filePath}:{lineStart}
   {description}

🟢 LOW: {name}
   File: {filePath}:{lineStart}
   {description}
```

### 5. Detailed report file

Write to `.security-agent/findings-{scan_id}.md`. Include EVERY field returned (findingId, name, description, riskLevel, riskType, confidence, status, codeLocations with filePath/lineStart/lineEnd, and remediationCode if present).

```markdown
# Security Scan Report — {scan_id}

**Scan type**: FULL
**Title**: {title}
**Started**: {started_at}
**Total findings**: {count}

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | N     |
| HIGH     | N     |
| MEDIUM   | N     |
| LOW      | N     |

## Findings

### 🟣 CRITICAL: {name}

- **ID**: {findingId}
- **Risk type**: {riskType}
- **Confidence**: {confidence}
- **Status**: {status}
- **Location**: `{filePath}:{lineStart}-{lineEnd}`

**Description**: {description}

**Remediation**:
{remediationCode or remediation guidance from description}

(repeat for every finding)
```

Tell user: "Full details written to `.security-agent/findings-{scan_id}.md`"

### 6. Follow-ups

Ask:

- "Would you like to focus on the critical/high findings first?"
- "Should I explain any of these in more detail?"
- "Want me to fix these issues?"

For fixes: read the finding's description and code location, then synthesize and apply the fix via the Edit tool.

---

## Workflow: Stop a scan

User says "stop the scan":

```bash
aws securityagent stop-code-review-job --agent-space-id <id> --code-review-job-id <job_id>
```

Update `scans.json` status to `STOPPED`.

---

## Workflow: List recent scans

User asks "show my recent scans" / "list scans":

Read `.security-agent/scans.json`. Show in a compact table:

| scan_id  | type | title            | status    | started |
| -------- | ---- | ---------------- | --------- | ------- |
| scan-abc | FULL | pre-cr-main      | COMPLETED | 2h ago  |
| scan-def | FULL | pre-cr-feature-x | FAILED    | 1d ago  |

---

## Rules

- Always run pre-scan checks (config exists + agent space verified) before any scan
- Scan APIs return immediately — poll status every 5 minutes
- Use the most recent scan in `scans.json` if the user doesn't name one
- Title must not contain spaces — use hyphens. Default to git branch name.
- Don't dump raw JSON — format with severity icons + file locations
- On `ResourceNotFoundException` from `start-code-review-job`, recreate the CodeReview and retry once

---

## Troubleshooting

- **"Not configured" / `config.json` missing** → run `setup-security-agent` skill first
- **`AccessDenied` on `s3 cp`** → bucket not registered on agent space, or trust policy wrong. Re-run setup.
- **`403` / `ExpectedBucketOwner` mismatch on `s3 cp`** → the derived bucket is owned by a different account (bucket-squatting). The upload is rejected by design — do not retry without the guard. Re-run `setup-security-agent`, which aborts on foreign-owned buckets.
- **`ResourceNotFoundException` on agent space** → it was deleted. Re-run setup.
- **Scan stuck in PREFLIGHT for >10 min** → backend issue, not client. Show `batch-get-code-review-jobs` output and tell user to escalate.
- **Code too large (zip > 2 GB)** → run on a subdirectory instead.
