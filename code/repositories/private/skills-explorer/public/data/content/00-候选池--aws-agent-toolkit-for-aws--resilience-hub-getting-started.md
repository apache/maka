---
name: resilience-hub-getting-started
description: >
  Sets up AWS Resilience Hub v2 from scratch: creates resilience policies with SLO targets,
  registers systems and user journeys, onboards services with input sources, and runs a
  first failure mode assessment. Applies when the user wants to get started with Resilience Hub v2,
  create a policy, onboard a service, or run an assessment — including creating one concrete
  policy with specific availability/RTO/RPO targets and a DR approach for a single service
  (even a tier-1 one). Does not apply to FIS experiments or ARC routing controls.
version: 1
---

# Getting Started with AWS Resilience Hub v2

## Overview

Domain expertise for first-time Resilience Hub v2 setup: policies, systems, user journeys,
services, input sources, and failure mode assessments.

> The AWS MCP server is recommended for executing this skill's AWS API calls, but it is not required — all operations also work with the AWS CLI directly.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g. `file="references/setup-procedure.md"`) — do NOT `file_read` these paths locally or search the filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/resilience-hub-getting-started/` or `~/.claude/skills/resilience-hub-getting-started/`): read reference files from the local skill directory using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data in the working directory, never through `retrieve_skill`.

## Set up Resilience Hub v2

To configure Resilience Hub v2 from scratch, follow the procedure exactly.
See [references/setup-procedure.md](references/setup-procedure.md).

## Troubleshooting

### Assessment stuck in IN_PROGRESS

Poll with `aws resiliencehubv2 list-failure-mode-assessments`. If stuck >30 min, check
the `errorCode` field — common causes are INVALID_PERMISSIONS or CMK_ACCESS_DENIED on
cross-account roles.

### Achievability shows NOT_ACHIEVABLE

Your architecture cannot meet the policy targets. Fix infrastructure before running
FIS experiments — testing won't help if the architecture is fundamentally insufficient.

### No resources discovered

Verify input sources are correct: CFN stack ARN exists, Terraform state file is accessible,
EKS cluster is in the specified regions, or resource tags match actual resources.

## Security Considerations

- **Least privilege:** scope the invoker role to read-only discovery of only the resource types in your input sources; attach the AWS managed `AWSResilienceHubAsssessmentExecutionPolicy` (AWS spells it with three s's) or a tighter custom policy.
- **Encryption at rest / in transit:** recommend S3 buckets for Terraform state and assessment reports use server-side encryption (SSE-KMS) and a bucket policy enforcing TLS via `aws:SecureTransport`.
- **Condition keys (confused-deputy):** add an `aws:SourceAccount` (and ideally `aws:SourceArn` scoped to the specific Resilience Hub service ARN) condition to the invoker role's trust policy so only your account's Resilience Hub can assume it.
- **Limit assessment exposure:** restrict who can call `start-failure-mode-assessment` (it reads infrastructure state) and who can read assessment findings and reports — these can contain sensitive architecture detail.
- **Further reading:** see [Security in AWS Resilience Hub](https://docs.aws.amazon.com/resilience-hub/latest/userguide/security.html) and [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) (including cross-service confused-deputy prevention).
