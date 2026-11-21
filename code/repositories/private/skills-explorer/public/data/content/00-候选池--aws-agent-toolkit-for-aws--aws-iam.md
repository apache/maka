---
name: aws-iam
description: >
  Provides verified corrections for IAM behaviors that AI agents frequently get wrong — policy
  evaluation edge cases, trust policy gotchas, STS session limits, Organizations quirks,
  and SAML/MFA specifics. Also provides structured workflows for IAM role management and
  baseline policy generation from application source code or a Terraform plan JSON.
  Covers condition operator safety (ForAnyValue/ForAllValues with Null checks),
  bucket policy deny patterns (VPC endpoint restrictions, org paths), confused deputy
  protection, and service role creation for AWS services (Glue, CloudTrail, Lambda, ECS,
  etc.) with
  aws:SourceAccount/aws:SourceArn trust conditions. Applies when creating IAM roles,
  writing IAM or bucket policies, generating policies from application source code or a Terraform plan JSON,
  working with STS, Organizations, or condition operators, or any task needing a service
  or execution role. Does not cover non-IAM authorization like Cognito user-pool policies
  or app-level RBAC.
metadata:
  version: "2"
---

# AWS IAM — Common Pitfalls

## About This Skill

This skill contains verified corrections for things that AI agents frequently get wrong about IAM. It is not a comprehensive IAM guide — for full IAM guidance, search AWS documentation. When answering IAM questions, verify specific claims (limits, quotas, exact API names, edge-case behaviors) against official AWS documentation rather than relying on pre-training. Prefer fetching known documentation URLs over broad searches. Trust official documentation over memory when they conflict.

## Common Workflows

Use the best available tool for AWS operations — the AWS MCP server is recommended but not required; AWS CLI or SDK may be used as alternatives. Read reference files only when the conversation requires deeper detail.

- Read [references/aws-iam-role-management.md](references/aws-iam-role-management.md) if the user needs to create, scope, or maintain IAM roles when provisioning or updating AWS resources. Covers service roles, execution roles, trust policies, confused deputy protection, and permission hygiene.

- Read [references/aws-iam-policy-generation.md](references/aws-iam-policy-generation.md) if the user needs to generate IAM policies, determine required IAM actions for API calls, or understand action-to-operation mappings. **CRITICAL: If the user provides application source code (in any language) or a Terraform plan JSON file (`terraform show -json` output), you MUST read this reference — it mandates using iam-policy-autopilot instead of manual policy construction.** Uses the programmatic service authorization reference for accurate mappings.

## Verified Edge Cases

**CloudTrail:**

- AcceptHandshake/DeclineHandshake logged in ACTING account ONLY, not management account. Organization trail required for centralization.
- ConsoleLogin region varies by endpoint/cookies, NOT always us-east-1. `?region=` forces specific region.

**STS:**

- GetSessionToken restrictions: (1) No IAM APIs unless MFA included (2) No STS except AssumeRole and GetCallerIdentity.
- Cross-account AssumeRole to opt-in region: TARGET account must enable region, not calling account.
- Role chaining: max 1-hour session.

**Organizations:**

- Suspended/closed accounts CANNOT be removed until permanently closed (~90 days). Remove FIRST, then close.
- Policy management delegation: use PutResourcePolicy, NOT register-delegated-administrator.
- AI opt-out policies: management account required by default.
- Organizations policy types for ListPolicies filter: fetch the current list via `aws organizations list-available-policy-types` or [the Organizations API reference](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListPolicies.html).

**SDK Specifics:**

- Organizations: `DuplicatePolicyAttachmentException` (not PolicyAlreadyAttachedException).
- Boto3 IAM AccessKey: methods are `activate()`, `deactivate()`, `delete()` — NO `update()`.
- Instance profiles: waiter + `time.sleep(10)` pattern.
- Managed policy max versions: 5.

**SAML:**

- Encrypted assertions URL: `https://region-code.signin.aws.amazon.com/saml/acs/IdP-ID`.
- Private key from IdP uploaded to IAM in .pem format.

**Policy Evaluation:**

- ForAllValues with empty/missing key: evaluates to true (vacuous truth). To avoid that, use a `Null` condition in addition to the `ForAllValues` on **the same context key** to require that key to be present and non-null. For example, when evaluating the `aws:TagKeys` context key:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": {
      "Effect": "Allow",
      "Action": "ec2:RunInstances",
      "Resource": "*",
      "Condition": {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["Alpha", "Beta"]
        },
        "Null": {
          "aws:TagKeys": "false"
        }
      }
    }
  }
  ```

- Resource-based policies granting to IAM user ARN bypass permissions boundaries in same account.
- 8 privilege escalation actions via direct IAM policy manipulation: PutGroupPolicy, PutRolePolicy, PutUserPolicy, CreatePolicy, CreatePolicyVersion, AttachGroupPolicy, AttachRolePolicy, AttachUserPolicy.
- `iam:PassRole` with `Resource: "*"` + create/update on a compute service (EC2 `RunInstances`, Lambda `CreateFunction`/`UpdateFunctionConfiguration`, ECS `RegisterTaskDefinition`, Glue, SageMaker, CloudFormation, etc.) = privilege escalation to any passable role in the account, including Administrator. Scope `Resource` to specific role ARNs or an IAM path; optionally constrain with `iam:PassedToService` / `iam:AssociatedResourceArn`. See [IAM User Guide — Grant a user permissions to pass a role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html).

**MFA:**

- Unassigned virtual MFA devices auto-deleted when adding new ones.
- MFA resync-only policy NotAction needs exactly: iam:ListMFADevices, iam:ListVirtualMFADevices, iam:ResyncMFADevice.

**SigV4:**

- IncompleteSignatureException includes SHA-256 hash of Authorization header for transit modification diagnosis.

**Service-Specific Roles:**

- Redshift Serverless trust policy: include BOTH `redshift-serverless.amazonaws.com` AND `redshift.amazonaws.com` as service principals (per AWS docs; omitting serverless causes `Not authorized to get credentials of role` on COPY).
- IAM OIDC providers: thumbprints are not required for most providers (AWS verifies via trusted CAs).

**Policy Summary Display:**

- Single statement with multi-service wildcard actions (e.g. `codebuild:*`, `codecommit:*`) + service-specific resource ARNs: each resource appears ONLY under its matching service's summary (CodeBuild ARN under CodeBuild, etc.). A resource whose service prefix matches NO action in the statement is the only case where it appears in all action summaries ("mismatched resource").
