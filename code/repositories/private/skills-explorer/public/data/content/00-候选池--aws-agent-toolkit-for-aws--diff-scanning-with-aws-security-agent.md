---
name: diff-scanning-with-aws-security-agent
description: Run a fast AWS Security Agent diff scan on only the changed code since a git ref. Use when the user asks to scan changes, run a diff scan, check what changed for security issues, scan before committing, scan before PR, or any pre-commit/pre-push security check.
---

# AWS Security Agent — Diff Scan

Scan only the code that changed since a git ref. Faster than a full scan — focuses findings on the diff. No prior full scan needed.

## Local state

Read `.security-agent/config.json` for `agent_space_id` and `region`. If missing, run the `setup-security-agent` workflow inline first.

Track scans in `.security-agent/scans.json`.

### Resolving the values you need

| Placeholder          | How to resolve                                              |
| -------------------- | ----------------------------------------------------------- |
| `<id>` (agent space) | `config.agent_space_id`                                     |
| `<region>`           | `config.region` (default `us-east-1`)                       |
| `<account>`          | `aws sts get-caller-identity --query Account --output text` |
| `<role-arn>`         | `arn:aws:iam::<account>:role/SecurityAgentScanRole`         |
| `<bucket>`           | `security-agent-scans-<account>-<region>`                   |
| `<WORKSPACE_ID>`     | `printf '%s' "$(pwd)" \| md5sum \| cut -c1-12`              |

---

## Workflow

1. **Pre-scan checks.** Same as full scan — read config, verify agent space, resolve values, generate workspace ID.

2. **Ask what to scan against:**
   - Uncommitted changes → `BASE_REF=HEAD` (default)
   - Branch vs main → `BASE_REF=main`
   - Custom ref → user provides

3. **Generate diff (fail fast if empty):**

   ```bash
   cd <absolute-workspace-path>
   if [ "$BASE_REF" = "HEAD" ]; then
     git diff HEAD > /tmp/diff.patch
   else
     git diff "$BASE_REF..HEAD" > /tmp/diff.patch
   fi
   [ -s /tmp/diff.patch ] || { echo "No changes vs $BASE_REF"; exit 1; }
   ```

4. **Zip the workspace** (same exclusions as full scan, 2 GB limit):

   ```bash
   cd <absolute-workspace-path>
   zip -r /tmp/source.zip . \
     -x ".git/*" -x ".security-agent/*" -x "node_modules/*" \
     -x "__pycache__/*" -x ".venv/*" -x "venv/*" \
     -x "dist/*" -x "build/*" -x "target/*" \
     -x ".mypy_cache/*" -x ".pytest_cache/*" -x ".tox/*" \
     -x ".next/*" -x "cdk.out/*" -x ".DS_Store" -x "*.pyc"
   ```

5. **Upload both source zip and diff patch:**

   ```bash
   SCAN_ID="diff-$(date +%s)-$(openssl rand -hex 3)"
   aws s3 cp /tmp/source.zip s3://<bucket>/security-scans/source/<WORKSPACE_ID>/source.zip --expected-bucket-owner <account>
   aws s3 cp /tmp/diff.patch s3://<bucket>/security-scans/diffs/${SCAN_ID}/diff.patch --expected-bucket-owner <account>
   ```

6. **Get or create per-workspace CodeReview** (same logic as full scan — lookup `config.json → code_reviews[<abs_path>]`, create if absent):

   ```bash
   aws securityagent create-code-review --agent-space-id <id> --title <title> \
     --service-role <role-arn> \
     --assets sourceCode=[{s3Location=s3://<bucket>/security-scans/source/<WORKSPACE_ID>/source.zip}]
   ```

7. **Start the diff job:**

   ```bash
   aws securityagent start-code-review-job --agent-space-id <id> --code-review-id <cr-id> \
     --diff-source s3Uri=s3://<bucket>/security-scans/diffs/${SCAN_ID}/diff.patch
   ```

   If `ResourceNotFoundException`: recreate CodeReview and retry.

8. Capture `codeReviewJobId`. Persist to `scans.json` with `scan_type: "DIFF"` and `base_ref`.

9. Tell user: "Diff scan started. Takes a few minutes. I'll check every 2 minutes — say 'stop polling' to opt out."

10. **Poll** every 2 minutes:

    ```bash
    aws securityagent batch-get-code-review-jobs --agent-space-id <id> --code-review-job-ids <job_id>
    ```

    Only respond when status changes. On COMPLETED → fetch findings.

11. **Findings:** same presentation as full scan — grouped by severity, report written to `.security-agent/findings-{scan_id}.md`.

---

## Rules

- Diff scans are standalone — no prior full scan needed
- Poll every 2 minutes, not faster
- Default to `BASE_REF=HEAD` if user doesn't specify
- Title: `diff-<git-branch>-<timestamp>` (no spaces)
- If diff is empty, tell user and stop — don't start a scan
