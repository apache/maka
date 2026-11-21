---
name: resilience-hub-multi-account
description: >
  Configures AWS Resilience Hub v2 for multi-account resilience management across an AWS
  Organization. Covers the per-service cross-account permission model, cross-account IAM
  roles, and centralized assessment from a single account. Applies when the user wants to set
  up org-wide resilience or assess workloads that span multiple AWS accounts.
version: 1
---

# Multi-Account Resilience Hub v2 Setup

## Overview

Domain expertise for configuring Resilience Hub v2 to assess services across multiple
AWS accounts from a central account. All CLI commands in this skill use the **`aws resiliencehubv2`**
namespace — the Resilience Hub **v2** API surface — which is distinct from the legacy `aws resiliencehub`
(v1) commands (the `service: [resiliencehub, ...]` metadata tags the service family, not the CLI namespace).
Resilience Hub v2 supports two complementary multi-account mechanisms: (1) an **AWS Organizations
integration** — the management account enables trusted access, creates the service-linked role, and
designates a **delegated administrator** account for organization-wide policy management and visibility;
and (2) the **per-service cross-account permission model** — an invoker role in the central account that
assumes cross-account roles in member accounts for per-service resource discovery. This skill configures
(2); the Organizations integration (1) is set up separately (management account + console — see below).

> The AWS MCP server is recommended for executing this skill's AWS API calls, but it is not required — all operations also work with the AWS CLI directly.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g. `file="references/multi-account-procedure.md"`) — do NOT `file_read` these paths locally or search the filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/resilience-hub-multi-account/` or `~/.claude/skills/resilience-hub-multi-account/`): read reference files from the local skill directory using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data in the working directory, never through `retrieve_skill`.

## How centralized multi-account assessment works

Two paths, used depending on your goal:

> **Decision rule (read first):** To **run cross-account resilience assessments** — i.e. assess workloads/resources that live in member accounts from a central account (the common request, including phrasings like _"centralized resilience management across my Organization"_ or _"central assessment account"_) — use the **per-service cross-account permission model** (path 2 below): an invoker role + cross-account roles + `create-service --permission-model`. **Do NOT use or recommend `aws organizations register-delegated-administrator` (or any delegated-administrator registration) as the setup step for cross-account assessments.** The Organizations delegated-administrator integration (path 1) is a _separate, optional_ feature scoped to organization-wide **policy management and visibility only** — it is not how you set up or run cross-account assessments. Only follow path 1 when the request is explicitly about org-wide policy governance, not assessment.

- **Organization-wide governance** (centralized policies, cross-account visibility): use the **AWS
  Organizations integration**. From the **management account**, enable trusted access for Resilience Hub,
  create the service-linked role, and **register a delegated administrator** account. This is done via
  Organizations trusted access + the Resilience Hub console — there is **no `resiliencehubv2`
  `register-delegated-administrator` CLI operation**. The delegated administrator then selects a home
  Region where organization-level data is aggregated. See the AWS docs page _Setting up Organizations
  integration_.
- **Per-service cross-account resource discovery** (assessing a service whose resources span accounts):
  register each service with a **per-service cross-account permission model** — an invoker role in the
  central account plus cross-account role ARNs for each member account. **This skill's steps configure
  this path.** Use this command form:

```
aws resiliencehubv2 create-service --name {service} --regions {regions} \
  --permission-model '{"invokerRoleName":"ResilienceHubAssessmentRole","crossAccountRoles":[{"crossAccountRoleArn":"arn:aws:iam::{member_account_id}:role/ResilienceHubAccess","externalId":"{external_id}"}]}'
```

> The `externalId` is a shared secret that defends against confused-deputy attacks — generate a cryptographically random value and store it in AWS Secrets Manager or SSM Parameter Store (SecureString); never commit it to source control or embed it in templates without a dynamic `{{resolve:secretsmanager:...}}` reference, and ensure it is not emitted in plaintext by CI/CD logs or infrastructure-as-code output (use CloudFormation `NoEcho` parameters and mask it in pipeline logs).

The cross-account role (in the member account) trusts the central account's invoker role. You can
configure multiple cross-account role ARNs per service — the `resiliencehubv2` API enforces a maximum (illustratively 5), so **verify the accepted limit from the API/model rather than assuming a fixed number**. Note: this per-service model is independent of
the Organizations integration above — there is no `register-delegated-administrator` operation in the
`resiliencehubv2` CLI; organization-wide delegated-administrator registration is performed via AWS
Organizations trusted access and the Resilience Hub console, not a `resiliencehubv2` API call.

## Configure multi-account setup

To set up cross-account assessment, follow the procedure exactly.
See [references/multi-account-procedure.md](references/multi-account-procedure.md).

## Troubleshooting

### Cross-account assessment fails with AccessDenied

Verify: (1) the cross-account role ARN in the permission model matches exactly, (2) the
cross-account role trust policy allows the central account's invoker role to assume it,
(3) the externalId matches if configured.

### No resources discovered in a member account

Confirm the cross-account role has read permissions for the in-scope resource types
(CloudFormation, EC2, RDS, etc.) and that input sources point to valid resources in the
correct region.

### Looking for a delegated-administrator setup

Resilience Hub v2 **does** support an AWS Organizations integration with a delegated administrator for
organization-wide policy management and visibility — but it's configured from the **management account**
via Organizations trusted access + the Resilience Hub console (create the service-linked role, then
register the delegated administrator), **not** through a `resiliencehubv2` CLI operation (there is no
`register-delegated-administrator` API). To assess a _single service_ whose resources span accounts, use
the per-service cross-account permission model in this skill. The two are complementary.

## Security Considerations

- **Least privilege & read-only:** scope member-account cross-account roles to read-only discovery permissions (`cloudformation:Describe*`, `ec2:Describe*`, `rds:Describe*`, etc.) rather than write/mutate actions.
- **Scope cross-account trust narrowly:** trust only the specific central invoker role ARN rather than the whole account where possible.
- **Enable logging & monitoring:** ensure AWS CloudTrail is enabled in both the central and member accounts to log cross-account `sts:AssumeRole` calls, and alarm on failed or unexpected AssumeRole attempts against the cross-account roles.
- **Further reading:** see [IAM best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html), [The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html), and [Security in AWS Resilience Hub](https://docs.aws.amazon.com/resilience-hub/latest/userguide/security.html) for cross-account hardening guidance.
