---
name: resilience-hub-failure-mode-assessment
description: >
  Runs and interprets AWS Resilience Hub v2 failure mode assessments. Covers starting
  assessments, understanding findings (severity, categories, recommendations), triaging
  by achievability, working with AI-generated service functions, and resolving findings.
  Applies when the user wants to run an assessment, review findings, or understand failure modes,
  or has a specific finding and asks how to resolve, remediate, or fix it.
  Does not apply to initial setup (use resilience-hub-getting-started) or FIS experiments.
version: 1
---

# Failure Mode Assessment

## Overview

Domain expertise for running Resilience Hub v2 failure mode assessments, interpreting
findings, triaging by severity and achievability, and driving remediation.

> The AWS MCP server is recommended for executing this skill's AWS API calls, but it is not required — all operations also work with the AWS CLI directly.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g. `file="references/assessment-workflow.md"`) — do NOT `file_read` these paths locally or search the filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/resilience-hub-failure-mode-assessment/` or `~/.claude/skills/resilience-hub-failure-mode-assessment/`): read reference files from the local skill directory using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data in the working directory, never through `retrieve_skill`.

## Run and interpret assessments

To run assessments and triage findings, follow the procedure exactly.
See [references/assessment-workflow.md](references/assessment-workflow.md).

## Troubleshooting

### Assessment fails with INVALID_PERMISSIONS

The service's permission model (invokerRoleName / crossAccountRoles) doesn't have
access to the resources. Verify the invoker role (and any cross-account roles) can describe resources in all configured regions.

### Too many findings — where to start?

Prioritize by finding severity, highest first (HIGH, then MEDIUM, then LOW). For HIGH-severity
findings, check the service's achievability for the relevant policy component (from `get-service`
/ `list-failure-mode-assessments`): NOT_ACHIEVABLE means the architecture must change before
testing; ACHIEVABLE means validate the fix with an FIS experiment. MEDIUM findings: plan
remediation this sprint; LOW findings: track but don't block (see the priority matrix in
[references/assessment-workflow.md](references/assessment-workflow.md) Step 5).

### AI-generated service functions are wrong

Update them: `aws resiliencehubv2 update-service-function` to rename or change criticality
(there is no service-function "type" parameter). Reassign resources by calling `create-service-function-resources` with the desired resource set (see [references/assessment-workflow.md](references/assessment-workflow.md) for the service-function operations).

## Security Considerations

- **Least privilege:** the invoker role should be scoped to read-only discovery of only the resource types in the service's input sources; avoid granting access beyond what assessment needs.
- **Encryption & access control:** recommend that S3 buckets used for report output have server-side encryption (SSE-S3 or SSE-KMS) and block public access — assessment reports can contain sensitive architectural detail. If a bucket policy grants the Resilience Hub service principal write access, scope it with `aws:SourceArn` / `aws:SourceAccount` condition keys to prevent confused-deputy writes.
- **Further reading:** see [Security in AWS Resilience Hub](https://docs.aws.amazon.com/resilience-hub/latest/userguide/security.html) and the [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) for securing assessment outputs and IAM configurations.
