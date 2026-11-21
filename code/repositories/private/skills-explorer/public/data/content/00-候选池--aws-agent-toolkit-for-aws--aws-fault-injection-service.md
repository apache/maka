---
name: aws-fault-injection-service
description: >
  Plans, builds, runs, and analyzes fault injection experiments with AWS Fault Injection Service
  (AWS FIS) to validate application resilience through chaos engineering. Covers experiment
  templates (actions, targets, stop conditions), the FIS actions catalog and action selection,
  the scenario library (AZ power interruption, cross-Region connectivity, EC2/EKS/EBS stress),
  experiment lifecycle and monitoring, logging and reports, multi-account experiments, the
  experiment IAM role, and blast-radius safety. Applies when a user mentions AWS FIS or fault
  injection, asks what experiment to run for a failure mode (AZ, Region, API errors/throttling,
  instance/pod/DB/cache failure, latency, packet loss), wants to author an experiment template or
  CLI/CloudFormation, or needs to safely run chaos experiments in pre-production or production.
  For the broader resilience program across Resilience Hub and ARC, see aws-resilience-lifecycle;
  for ARC routing controls and zonal shift, see recovery-controller-setup.
version: 1
---

# AWS Fault Injection Service (FIS) Experiments

## Overview

Domain expertise for AWS Fault Injection Service (AWS FIS) — a managed chaos-engineering
service that runs controlled fault injection experiments on real AWS resources so you can
observe how an application responds to disruption and improve its resilience.

This skill lets an agent do three things:

1. **Suggest the right experiment** — map a user's failure scenario or resilience question to
   the correct FIS action(s), scenario, or experiment design, and explain the trade-offs.
2. **Build and run experiments** — author experiment templates (actions, targets, stop
   conditions, logging, reports), wire up the experiment IAM role, and drive the run/monitor/stop
   lifecycle via CLI, SDK, or CloudFormation.
3. **Inform the user** — answer conceptual questions about FIS terminology, safety, pricing,
   supported services, and how FIS fits into a resilience program.

> **AWS FIS carries out real actions on real AWS resources.** Before running any experiment in
> production, plan it, run it first in pre-production, and always bound the blast radius with a
> stop condition. Treat fault injection as a privileged, potentially disruptive operation.
>
> The AWS MCP server is recommended for executing this skill's AWS API calls — it provides
> sandboxed execution and audit logging — but it is not required; all operations also work with
> the AWS CLI (`aws fis ...`) directly.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the
  local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g.
  `file="references/fis-concepts.md"`) — do NOT `file_read` these paths locally or search the
  filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/aws-fault-injection-service/` or
  `~/.claude/skills/aws-fault-injection-service/`): read reference files from the local skill directory
  using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data
in the working directory, never through `retrieve_skill`.

## Start here — route the request

- **"What is FIS / when should I use it / what does X term mean / does it support Y?"** →
  read [references/fis-concepts.md](references/fis-concepts.md).
- **"What experiment/action should I run to test a failure mode?"** →
  read [references/fis-actions-reference.md](references/fis-actions-reference.md) (action
  selection map + full catalog) and suggest an action or scenario.
- **"Build / create / run an experiment"** (template, targets, stop conditions, logging,
  reports, scenarios, multi-account, monitoring) → follow
  [references/fis-workflow.md](references/fis-workflow.md) exactly.
- **Any AWS CLI or API command for FIS** → consult
  [references/fis-api-reference.md](references/fis-api-reference.md) FIRST — it is the canonical
  operation/parameter reference and includes a hallucination-rejection table.
- **IAM role, permissions, trust policy, confused-deputy, blast-radius safety** →
  read [references/fis-security.md](references/fis-security.md).

## API Reference (READ FIRST before producing any AWS CLI command)

The exact `aws fis` operation names and template parameters are documented in
[references/fis-api-reference.md](references/fis-api-reference.md), including a table mapping
common wrong API/action names to correct ones. **Always consult it before generating commands.**
Action IDs and resource types evolve — verify with `aws fis list-actions` and
`aws fis get-action --id <action-id>` rather than trusting memory.

## Suggesting experiments (behavioral contract)

When the user describes a failure they want to test rather than a command they want run:

1. Identify the **failure mode** (AZ impairment, Region isolation, API errors/throttling,
   compute/DB/cache loss, latency, packet loss, resource exhaustion).
2. Map it to a **scenario** (preferred when one fits — pre-built and AWS-owned) or a specific
   **action** using the selection map in
   [references/fis-actions-reference.md](references/fis-actions-reference.md).
3. State the **target** (resource type + how to scope it) and a **stop condition** (CloudWatch
   alarm on your steady-state metric) so the blast radius is bounded.
4. Recommend running in **pre-production first**, then production under change management.
5. Offer to generate the experiment template — then follow
   [references/fis-workflow.md](references/fis-workflow.md).

Do not invent action IDs, resource types, or parameters. If unsure, say so and verify with
`aws fis list-actions` / `aws fis get-action` or the FIS documentation.

## Troubleshooting

### "Experiment failed immediately / no targets found"

FIS resolves all targets at experiment start; if a target resolves to zero resources, the
experiment fails (unless `emptyTargetResolutionMode` is `skip`). Check tags, filters, region,
and account. Use a **target preview** before running (see workflow reference).

### "Action failed with a permissions error"

The FIS experiment IAM role is missing permissions for the underlying service API (or SSM, or
the confused-deputy trust conditions block the assume). See
[references/fis-security.md](references/fis-security.md).

### "Experiment stopped unexpectedly"

A stop condition (CloudWatch alarm) likely fired — this is the guardrail working. Check the
experiment's `state.reason` and the alarm history. A stopped experiment cannot be resumed; start
a new one from the template.

### "Nitro / instance-type errors on EBS or network faults"

Some actions require Nitro-based instances or the SSM Agent. Verify prerequisites per action in
[references/fis-actions-reference.md](references/fis-actions-reference.md).

## Observability companion

For the CloudWatch alarms, dashboards, and metrics that back FIS stop conditions and
experiment reports, recommend the **AWS Observability** skill for alarm/dashboard setup — keep
this skill's guidance to how those signals feed experiment safety and post-experiment analysis.

## Security Considerations

FIS runs real, potentially destructive actions. Key points (full guidance in
[references/fis-security.md](references/fis-security.md)):

- **Least privilege:** scope the experiment role to only the actions and target ARNs each
  experiment needs — never `*`. Scope the human/CI principals allowed to call
  `fis:StartExperiment`.
- **Confused-deputy protection:** the experiment role's trust policy MUST condition on
  `aws:SourceAccount` and `aws:SourceArn` (scoped to the experiment ARN pattern).
- **Bounded blast radius:** always attach a CloudWatch-alarm stop condition; start with narrow
  targets (`COUNT(1)` / low `PERCENT`) and pre-production before production.
- **No sensitive data in string fields:** experiment/template descriptions, tags, and logs
  surface in CloudTrail, CloudWatch Logs, S3 reports, and (multi-account) target-account Health
  dashboards — never embed PII, secrets, or sensitive architecture detail.
- **Encrypt logs/reports:** experiment logs and PDF reports reveal resilience posture —
  use SSE-KMS on the S3 buckets, enforce TLS, and consider S3 Object Lock on report buckets.
- **Further reading:** [FIS Security](https://docs.aws.amazon.com/fis/latest/userguide/security.html)
  and the [AWS Well-Architected Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/).
