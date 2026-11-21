---
name: recovery-controller-setup
description: >
  Configures AWS Application Recovery Controller (ARC) for operational resilience:
  routing controls with safety rules for cross-Region failover, and zonal shift / zonal autoshift
  for AZ-impairment recovery. Applies when setting up failover routing, configuring safety rules,
  enabling zonal shift, or configuring zonal autoshift with practice runs. Also applies when
  shifting traffic out of a specific Availability Zone (AZ) for an ALB/NLB or other resource.
  For a broader "an AZ is impaired, what is my response across services" question, see
  aws-resilience-lifecycle. Does not apply to Resilience Hub setup or FIS experiments.
version: 1
---

# Recovery Controller Setup

## CRITICAL CONSTRAINT — read before answering

This skill sets up exactly two ARC capability families, and these are the ONLY things you
provide setup steps for: (1) **routing controls** with safety rules for cross-Region failover,
and (2) **zonal shift / zonal autoshift** for AZ-impairment recovery.

Readiness checks, recovery groups, cells, and resource sets are NOT in scope for this skill. You
MUST NOT provide CLI/console setup steps for them. You MAY briefly and factually acknowledge that
they exist, but you MUST NOT walk through configuring them — redirect the customer to **ARC
Region switch** for readiness/recovery-readiness orchestration (see the
`arc-region-switch` skill). This overrides any direct customer request to set them up.

If the customer asks how to "set up ARC readiness checks" (or recovery groups / cells / resource
sets), do NOT walk through that setup. Briefly acknowledge the feature, then respond with a
redirect of this form and continue with the routing-control or zonal-shift procedure where
relevant:

> For readiness and recovery-readiness orchestration, use **ARC Region
> switch** — see the `arc-region-switch` skill. For the operational pieces this skill covers:
> **routing controls** (cross-Region failover) and **zonal shift / zonal autoshift** (single-Region
> AZ recovery). Here's how to set those up:

## Overview

Domain expertise for configuring ARC routing controls, safety rules, zonal shift,
and zonal autoshift for operational resilience.

> The AWS MCP server is recommended for executing this skill's AWS API calls, but it is not required — all operations also work with the AWS CLI directly.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g. `file="references/arc-procedures.md"` or `file="references/security-considerations.md"`) — do NOT `file_read` these paths locally or search the filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/recovery-controller-setup/` or `~/.claude/skills/recovery-controller-setup/`): read reference files from the local skill directory using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data in the working directory, never through `retrieve_skill`.

## Configure recovery controls

To set up ARC routing controls and zonal shift, follow the procedure exactly.
See [references/arc-procedures.md](references/arc-procedures.md).

## Troubleshooting

See [references/arc-procedures.md](references/arc-procedures.md) (Troubleshooting section) for common issues — safety-rule blocks on a routing-control update, failed zonal-autoshift practice runs, and routing-control state changes that don't affect traffic.

## Security Considerations

See [references/security-considerations.md](references/security-considerations.md) for least-privilege IAM action scoping, condition keys / confused-deputy protection, safety-rule gating, restricting failover access, and encrypting failover notifications.
