---
name: aws-resilience-lifecycle
description: >
  Guides the end-to-end AWS resilience lifecycle integrating Resilience Hub v2, Fault Injection Service,
  and Application Recovery Controller. Covers the Define → Test → Operate workflow: from
  policy creation through failure mode assessment, to FIS experiment validation, to ARC
  operational controls. Applicable when the user wants a complete resilience strategy, needs to
  connect findings to experiments to controls, or is planning a resilience program.
  Also applicable for the meta question of whether marking NGRH findings as resolved is enough,
  whether they are "done" after resolving findings, or how to validate findings before
  resolving them. Not applicable for resolving or remediating a specific individual finding
  (see resilience-hub-failure-mode-assessment), or when a single service is explicitly
  named (e.g. "what FIS experiment should I run").
version: 1
---

# AWS Resilience Lifecycle

## Overview

Domain expertise for the integrated resilience lifecycle across three AWS services:
Define (Resilience Hub v2 — also called NGRH, New Generation Resilience Hub) → Test (FIS) → Operate (ARC).

**Terminology:** in this skill an unqualified "Resilience Hub" always means **v2** (NGRH / New Generation Resilience Hub, CLI namespace `aws resiliencehubv2`). v1 (`aws resiliencehub`) is referenced _only_ explicitly, and only for migration.

> The AWS MCP server is recommended for executing this skill's AWS API calls, but it is not required — all operations also work with the AWS CLI directly.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g. `file="references/lifecycle-workflow.md"` or `file="references/api-reference.md"`) — do NOT `file_read` these paths locally or search the filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/aws-resilience-lifecycle/` or `~/.claude/skills/aws-resilience-lifecycle/`): read reference files from the local skill directory using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data in the working directory, never through `retrieve_skill`.

## Execute the full lifecycle

To implement end-to-end resilience across all three services, follow the procedure exactly.
See [references/lifecycle-workflow.md](references/lifecycle-workflow.md).

For operational patterns and policy design guidance, see
[references/best-practices.md](references/best-practices.md).

## Validate findings before you resolve them

Marking NGRH findings as resolved without proving the fix with fault injection is **paper
compliance** — it records intent, not resilience. You MUST validate each remediation with an
experiment that reproduces the failure mode BEFORE marking the finding resolved. Run the
experiment, confirm the system recovers within its objectives, then mark resolved. Marking
resolved first and validating "later" is the anti-pattern.

## Monitoring & observability

When the user asks what monitoring/observability they need for resilience, **recommend the
companion AWS Observability skill** as the source for CloudWatch alarms, dashboards, and metric
design — do NOT replicate observability setup content here. Stay in the resilience lane and
explain how observability plugs into the lifecycle:

- **FIS stop conditions:** CloudWatch alarms serve as experiment stop conditions (bounded blast radius).
- **Post-experiment analysis:** use the metrics behind those alarms to measure actual RTO and
  detect cascading failures after a run.

Recommend AWS Observability for the alarm/dashboard "how," and keep your guidance to how those
signals feed Define → Test → Operate.

## API Reference (READ FIRST before producing any AWS CLI command)

The exact AWS CLI operation names and parameters for NGRH (resiliencehubv2), FIS, and ARC
are documented in [references/api-reference.md](references/api-reference.md). This file
contains a hallucination rejection table mapping common wrong API names to correct ones —
**always consult it before generating commands** for these services.

## Troubleshooting

### Don't know where to start

Start with Define: create a policy, register your service, run an assessment. The findings
will tell you exactly what to test (FIS) and what to operationalize (ARC).

### Findings resolved but no confidence in resilience

Resolving findings without FIS validation is paper compliance. Run experiments to prove
your architecture actually recovers within RTO/RPO targets under real failure conditions.

### FIS experiments pass but production still fails

Experiments may not match real failure modes. Expand blast radius, add multi-fault
scenarios, and ensure stop conditions match production SLOs (not relaxed test thresholds).

## Security Considerations

- **Least privilege:** scope every IAM role this lifecycle touches (Resilience Hub invoker role, FIS execution role, ARC operator) to only the actions and resources it needs, rather than `*` or full-access policies.
- **Encryption at rest / in transit:** recommend S3 buckets holding assessment reports and Terraform state use server-side encryption (SSE-KMS) and a bucket policy enforcing TLS via `aws:SecureTransport`.
- **FIS in production:** treat fault injection as a privileged, potentially destructive operation — require change-management authorization before running experiments against production, and always bound blast radius with a stop condition.
- **Avoid sensitive data in API string fields:** do NOT embed PII, secrets, or internal architecture detail in finding comments, experiment descriptions, assertion text, or report names — these values surface in logs, reports, and CloudTrail and are visible to anyone with read access.
- **Further reading:** see [FIS Security Best Practices](https://docs.aws.amazon.com/fis/latest/userguide/security.html), [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html), and the [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) for authoritative guidance on securing this lifecycle.
