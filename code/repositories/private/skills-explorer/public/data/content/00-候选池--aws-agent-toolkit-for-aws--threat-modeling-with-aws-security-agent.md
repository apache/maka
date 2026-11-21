---
name: threat-modeling-with-aws-security-agent
description: Run an AWS Security Agent threat model review on spec/design documents. Use when the user asks to review a spec for security, run a threat model, check if a design introduces security risks, review requirements.md or design.md for security posture changes, or STRIDE analysis.
---

# AWS Security Agent — Threat Model Review

Analyze spec documents (`requirements.md`, `design.md`) against the source code to identify security-posture changes using STRIDE methodology. No prior scan needed.

## Local state

Read `.security-agent/config.json` for `agent_space_id` and `region`. If missing, run the `setup-security-agent` workflow inline first.

### Resolving the values you need

| Placeholder          | How to resolve                                              |
| -------------------- | ----------------------------------------------------------- |
| `<id>` (agent space) | `config.agent_space_id`                                     |
| `<region>`           | `config.region` (default `us-east-1`)                       |
| `<account>`          | `aws sts get-caller-identity --query Account --output text` |
| `<role-arn>`         | `arn:aws:iam::<account>:role/SecurityAgentScanRole`         |
| `<bucket>`           | `security-agent-scans-<account>-<region>`                   |

---

## Workflow

1. **Pre-checks.** Read config, verify agent space, resolve values.

2. **Collect spec files.** Identify the `requirements.md` and/or `design.md` the user is working on. Use absolute paths. Ask if unclear which files to review.

3. **Zip the workspace** (same exclusions as code scan):

   ```bash
   cd <absolute-workspace-path>
   zip -r /tmp/source.zip . \
     -x ".git/*" -x ".security-agent/*" -x "node_modules/*" \
     -x "__pycache__/*" -x ".venv/*" -x "venv/*" \
     -x "dist/*" -x "build/*" -x "target/*" \
     -x ".mypy_cache/*" -x ".pytest_cache/*" -x ".tox/*" \
     -x ".next/*" -x "cdk.out/*" -x ".DS_Store" -x "*.pyc"
   ```

4. **Upload source zip:**

   ```bash
   SCAN_ID="tm-$(date +%s)-$(openssl rand -hex 3)"
   WORKSPACE_ID=$(printf '%s' "$(pwd)" | md5sum | cut -c1-12)
   aws s3 cp /tmp/source.zip s3://<bucket>/security-scans/source/${WORKSPACE_ID}/source.zip --expected-bucket-owner <account>
   ```

5. **Upload spec files:**

   ```bash
   aws s3 cp /path/to/requirements.md s3://<bucket>/security-scans/threat-models/${SCAN_ID}/specs/requirements.md --expected-bucket-owner <account>
   aws s3 cp /path/to/design.md s3://<bucket>/security-scans/threat-models/${SCAN_ID}/specs/design.md --expected-bucket-owner <account>
   ```

6. **Create threat model:**

   ```bash
   aws securityagent create-threat-model --agent-space-id <id> --title <title> \
     --service-role <role-arn> \
     --assets sourceCode=[{s3Location=s3://<bucket>/security-scans/source/${WORKSPACE_ID}/source.zip}] \
     --scope-docs '[{"s3Location":"s3://<bucket>/security-scans/threat-models/'${SCAN_ID}'/specs/requirements.md"},{"s3Location":"s3://<bucket>/security-scans/threat-models/'${SCAN_ID}'/specs/design.md"}]'
   ```

   Capture `threatModelId`.

7. **Start threat model job:**

   ```bash
   aws securityagent start-threat-model-job --agent-space-id <id> --threat-model-id <tm-id>
   ```

   Capture `threatJobId`.

8. Persist to `scans.json` with `scan_type: "THREAT_MODEL"`.

9. Tell user: "Threat model review started. Runtime varies with workspace size. I'll check every 2 minutes — say 'stop polling' to opt out."

10. **Poll** every 2 minutes:

    ```bash
    aws securityagent batch-get-threat-model-jobs --agent-space-id <id> --threat-model-job-ids <tj-id>
    ```

    Only respond when status changes.

11. **On COMPLETED** → fetch threats:

    ```bash
    aws securityagent list-threats --agent-space-id <id> --threat-job-id <tj-id>
    ```

    If `nextToken`, paginate with `--next-token`.

## Findings presentation

Each threat includes: `statement`, `severity`, `stride` category, `threatImpact`, `recommendation`, `impactedAssets`.

```
🟣 CRITICAL: {statement}
   STRIDE: {stride}
   Impact: {threatImpact}
   Assets: {impactedAssets}
   Recommendation: {recommendation}

🔴 HIGH: {statement}
   ...
```

Write full report to `.security-agent/findings-{scan_id}.md`. Call out any threat that represents a regression from the prior design.

---

## Rules

- Threat model reviews are standalone — no prior scan needed
- Poll every 2 minutes, not faster
- At least one spec file is required
- Use absolute paths for workspace and spec files
- Title: `threat-model-<feature-name>` (no spaces)
