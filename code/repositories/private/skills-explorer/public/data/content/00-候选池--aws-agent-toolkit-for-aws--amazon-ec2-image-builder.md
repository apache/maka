---
name: amazon-ec2-image-builder
description: Creates and automates custom image builds with EC2 Image Builder - Linux, Windows, and macOS AMIs, and container images to ECR. Covers the build IAM role, Amazon-managed and custom components, image recipes, infrastructure and distribution configuration (launch templates, SSM parameters, other Regions), one-off builds, recurring scheduled pipelines for golden AMI automation and OS patching, custom image workflows, and diagnosing failed builds. Applies when creating, automating, or scheduling AMI or container image builds with Image Builder, or when debugging a failed build. Not for launching instances from existing AMIs, AMI lifecycle/retirement, or general EC2 fleet management.
version: 1
---

# Amazon EC2 Image Builder

## Overview

Domain expertise for building custom AMIs and container images with EC2 Image Builder — from the build IAM role through recipes, pipelines, distribution, and troubleshooting.

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) — recommended for sandboxed execution and audit logging. All guidance also works with standard AWS CLI access.

## Guardrail — where this skill's own files live (MCP vs local install)

This skill can be loaded two ways, and they resolve the skill's own bundled
files from different places. Determine how the skill was loaded before reading
a reference or running a script:

- **Loaded through the AWS MCP `retrieve_skill` tool:** The skill is not
  installed on the local filesystem. You MUST fetch each reference or script
  via `retrieve_skill` with the `file` parameter (e.g.
  `file="references/creating-images.md"`), and use the returned content.
  Do NOT `file_read` these paths locally — they do not exist on disk.
- **Installed locally** (e.g. `.kiro/skills/amazon-ec2-image-builder/` or
  `~/.claude/skills/amazon-ec2-image-builder/`): Read files from the local
  skill directory using relative paths.

This distinction applies only to the skill's own packaged files. User data and
session artifacts are always read from and written to the user's working
directory. Never fetch or write user data through `retrieve_skill`.

## First decision: one-off image or recurring pipeline

Ask this before creating anything — it changes what you build.

| The user wants                                                                                   | Do this                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One custom AMI, once                                                                             | Follow [creating-images.md](references/creating-images.md) through step 7a: `create-image` with a recipe and infrastructure configuration — no pipeline needed. |
| A golden AMI that stays current (scheduled rebuilds that pick up base-image updates and patches) | An image pipeline: follow [creating-images.md](references/creating-images.md) — the schedule is part of the create-image-pipeline call (step 7b).               |

## Related skills — route there instead

| Use this skill                                 | When the request is about                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| **launching-ec2-instance-with-best-practices** | Launching instances from an AMI the user already has                         |
| **setting-up-ec2-instance-profiles**           | Instance profiles in general (not the build IAM role this skill creates)     |
| **aws-compute**                                | AMI sharing, retiring, and lifecycle management; general EC2 fleet questions |

**Not covered here:** AMI lifecycle/retirement (route via the table above) and VM/ISO image import and export (follow the AWS documentation directly).

## Routing (references in this skill)

Read the matching reference before answering. The exact commands, failure fixes, and platform requirements live in the references — answering Image Builder questions from general knowledge is how agents get the details subtly wrong.

| User need                                                                                                                                          | Read                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Create an image or pipeline end to end: role, components, recipe, infrastructure, schedules, patching, scanning, chaining                          | [creating-images.md](references/creating-images.md)           |
| Get the output AMI where it's needed: launch templates, SSM parameters (the service-linked role writes only under `/imagebuilder/`), other Regions | [distribution-options.md](references/distribution-options.md) |
| A build failed, hangs, or an Image Builder API call errors                                                                                         | [troubleshooting.md](references/troubleshooting.md)           |
| Windows (exit-3010 reboots), macOS (Mac Dedicated Hosts required), container images to ECR (extra build-role policy)                               | [other-image-types.md](references/other-image-types.md)       |
| Custom image workflows (advanced — always require an execution role)                                                                               | [custom-workflows.md](references/custom-workflows.md)         |

Reference files carry specific ARNs, Amazon-managed resource names, and service defaults — when precision matters, confirm against the AWS documentation.

## Guardrails (every workflow)

- Quote CLI filter values that contain spaces: `--filters "name=name,values=Amazon Linux 2023 x86"`. Unquoted spaces are a CLI parse error.
- Use the exact ARN each create call returns — never construct ARNs by hand.
- For a "latest" base image use an Amazon-managed image ARN with the `x.x.x` wildcard, or an `ssm:` parameter reference where no managed image exists. Never list versions and sort them as strings — the list is not semver-ordered.
- Keep architecture consistent across the base image, every component's binaries, and the infrastructure instance types. Image Builder performs no create-time validation of this; a mismatch only fails mid-build when the component runs.
- For component failures, the root cause lives in CloudWatch log group `/aws/imagebuilder/<image-name>` (on by default; also in the S3 logs if configured) — never in the API state. See [troubleshooting.md](references/troubleshooting.md).
- To reboot mid-build, exit the step with code `194` (Linux) or `3010` (Windows). The build re-runs that same step after the reboot — not the next step — so guard it with a marker file. A plain reboot command fails the step.
- If a resource the user describes isn't visible to `get-image`/`get-image-pipeline`, say you can't find it and check the Region and credentials in use — then keep troubleshooting from the user's description; a failed lookup is not proof the resource doesn't exist.
- Distribution handles launch templates and SSM publishing natively (`launchTemplateConfigurations`, `ssmParameterConfigurations`) — never add Lambda glue or manual launch-template versions for AMI propagation.
- Default to: Amazon Linux 2023 base, IMDSv2 required (`instanceMetadataOptions httpTokens=required`), and at least two instance types in the infrastructure configuration. S3 build logging is opt-in — CloudWatch logging is on regardless.
- Check Amazon-managed components (`aws imagebuilder list-components --owner Amazon`) before writing component YAML. Common needs (AWS CLI, OS updates, CloudWatch agent, STIG hardening) are already covered.

## Security considerations

The defaults above are the security posture: IMDSv2 required on build instances, no inbound security-group rules, least-privilege build IAM role (two managed policies for AMI builds plus only the scoped grants a workflow needs), no secrets in components or logs, and log buckets with Block Public Access. Build logs capture full command output that can carry sensitive material; CloudWatch Logs encrypts them at rest by default, and associating a customer-managed KMS key with each `/aws/imagebuilder/...` log group (`aws logs associate-kms-key`) is recommended. For auditing and operational visibility, enable CloudTrail in the account so Image Builder API calls are recorded, and configure EventBridge rules or CloudWatch alarms on build failures (source `aws.imagebuilder`, detail-type `EC2 Image Builder Image State Change`) so misconfigurations and unauthorized changes surface promptly. Per-build notifications are covered by the SNS topic option (creating-images.md step 6) — prefer a customer-managed key on that topic too. Deviations from these should be explicit user decisions. Reference: [EC2 Image Builder security best practices](https://docs.aws.amazon.com/imagebuilder/latest/userguide/security-best-practices.html).
