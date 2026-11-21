---
name: aws-cdk
description: Authors, deploys, and troubleshoots AWS infrastructure using CDK with TypeScript or Python. Covers best practices, stack architecture, and construct patterns. Applies when writing CDK constructs, bootstrapping environments, running cdk deploy/synth/diff, fixing CDK or CloudFormation errors, planning stack structure, importing existing resources, resolving drift, or refactoring stacks without resource replacement.
metadata:
  version: "2"
---

# AWS CDK

## Overview

Domain expertise for CDK construct authoring, deployment workflows, compliance, drift, importing resources, safe refactoring, and troubleshooting CDK CLI / CloudFormation errors.

**When NOT to use:** Raw CloudFormation YAML/JSON. SAM. Terraform/Pulumi. CI/CD beyond CDK Pipelines. Use builtin knowledge or specialized skills for these.

## Critical Warnings

**Deadly embrace**: Removing a cross-stack reference deadlocks deployment (`Export ... cannot be deleted as it is in use by ...`). Preferred fix: weaken the reference first — `CrossStackReferences.of($RESOURCE).produce(ReferenceStrength.BOTH)` then `WEAK`, then remove (three deploys). Legacy fallback: two-deploy `this.exportValue()` recipe. See [troubleshooting-deployment](references/troubleshooting-deployment.md).

**Construct ID changes cause replacement**: Renaming/moving a construct changes its logical ID → CloudFormation replaces the resource (data loss for stateful resources). Always `cdk diff` before deploy. See [refactor-and-prevent-replacement](references/refactor-and-prevent-replacement.md).

**UPDATE_ROLLBACK_FAILED**: Stack is stuck. Fix with `cdk rollback $STACK` or `cdk rollback $STACK --orphan <LogicalId>`. Express mode stacks are the exception — they cannot be rolled back at all. See [troubleshooting-deployment](references/troubleshooting-deployment.md).

**Hotswap and express mode are development-only**: `--hotswap` / `--hotswap-fallback` bypass CloudFormation and create drift on purpose; `--express` reports success before resources stabilize and disables automatic rollback. You MUST NOT use either in production. A failed `--express` deployment cannot be rolled back — recover by rolling forward with another `--express` deploy. See [fast-deployments](references/fast-deployments.md).

**Non-empty S3 buckets persist after destroy**: You MUST set both `removalPolicy: DESTROY` and `autoDeleteObjects: true`. Versioned buckets are worse — delete markers persist even after apparent deletion.

## Common Workflows

| Task               | Quick Command                                                                                        | Details                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bootstrap          | `cdk bootstrap aws://$ACCOUNT/$REGION`                                                               | [bootstrap-and-project-setup](references/bootstrap-and-project-setup.md)           |
| New TS project     | `cdk init app --language typescript` — use `tsx`, `eslint-plugin-awscdk`                             | [bootstrap-and-project-setup](references/bootstrap-and-project-setup.md)           |
| New Python project | `cdk init app --language python` — pin deps, use virtualenv                                          | [bootstrap-and-project-setup](references/bootstrap-and-project-setup.md)           |
| Deploy             | `cdk synth --strict` → `cdk diff` → `cdk deploy`                                                     | Always diff before deploy to production                                            |
| Fast dev iteration | `cdk deploy --hotswap-fallback`, `cdk watch`, or `cdk deploy --express` — dev only, never production | [fast-deployments](references/fast-deployments.md)                                 |
| cdk-nag            | `Aspects.of(app).add(new AwsSolutionsChecks())`                                                      | [compliance-and-drift](references/compliance-and-drift.md)                         |
| Drift              | `cdk drift $STACK` (use `--fail` in CI)                                                              | [compliance-and-drift](references/compliance-and-drift.md)                         |
| Import resource    | `cdk import` (interactive or `--resource-mapping` for CI), `cdk deploy --import-existing-resources`  | [import-and-migrate](references/import-and-migrate.md)                             |
| Refactor safely    | `cdk refactor --unstable=refactor` — no property changes in same deploy                              | [refactor-and-prevent-replacement](references/refactor-and-prevent-replacement.md) |

## Fast Deployments — Hotswap vs Express (dev only)

Both trade safety for speed and you MUST NOT use either in production.

**Choosing between them:** Use `--hotswap` / `--hotswap-fallback` for the fastest loop when you work mostly with hotswappable resources and drift does not matter. Use `--express` when drift is unacceptable, or your resources are not hotswappable.

Recovery workflows (hotswap drift via `--revert-drift`, rolling a failed `--express` deploy forward), the hotswappable-resource rules, and IAM/monitoring enforcement of the prod prohibition are all in the full guide: [fast-deployments](references/fast-deployments.md).

## Troubleshooting

| Error                                                                                         | Cause → Fix                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeployFailed / DeploymentError**                                                            | CDK error isn't the root cause. `cdk deploy $STACK --verbose`, then `cdk --unstable=diagnose diagnose $STACK` (CLI ≥ 2.1120.0); else `aws cloudformation describe-events --stack-name $STACK --filters FailedEvents=true` — the first `_FAILED` event is the cause. [Details](references/troubleshooting-deployment.md)                                                                                                   |
| **NoCredentials / ExpiredToken / AssumeRoleFailed**                                           | `aws sts get-caller-identity` + `cdk doctor`. Expired SSO, missing `env`, missing `sts:AssumeRole`. [Details](references/troubleshooting-credentials.md)                                                                                                                                                                                                                                                                  |
| **Asset errors** (CannotFindAsset, FailedToBundleAsset, AssetBuildFailed, AssetPublishFailed) | Path wrong, Docker not running, or bootstrap bucket perms. Use `path.join(__dirname, ...)`. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                                                                |
| **AppRequired**                                                                               | Add `"app": "npx tsx bin/my-app.ts"` to `cdk.json`. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                                                                                                        |
| **AnnotationErrors**                                                                          | Fix the underlying issue; suppress with `NagSuppressions` only as last resort. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                                                                             |
| **ConcurrentReadLock / ConcurrentWriteLock**                                                  | `rm -rf cdk.out` then re-run. Parallel CI: `--output ./cdk.out.$BUILD_ID`. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                                                                                 |
| **BootstrapVersionValidation**                                                                | Re-bootstrap. Match `--qualifier` everywhere. [Details](references/troubleshooting-credentials.md)                                                                                                                                                                                                                                                                                                                        |
| **DependencyCycle**                                                                           | Extract shared resource into third stack or use SSM for late-binding. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                                                                                      |
| **UnresolvedAccount**                                                                         | Set explicit `env: { account, region }` on stack. Commit `cdk.context.json`. [Details](references/troubleshooting-credentials.md)                                                                                                                                                                                                                                                                                         |
| **NoStacksMatched**                                                                           | CDK uses logical ID (2nd constructor arg), not CFN name. `cdk list` to find IDs. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                                                                           |
| **Cannot find module** (synth time)                                                           | Run `npx tsc --noEmit`, check `cdk.json` app path matches `tsconfig.json` `outDir`, delete stale `.js` files. Python: activate venv. [Details](references/troubleshooting-synth.md)                                                                                                                                                                                                                                       |
| **V1 import paths / duplicate aws-cdk-lib**                                                   | V1 `@aws-cdk/*` imports, wrong `Construct` import, duplicate lib copies in monorepos. [Details](references/v1-to-v2-migration.md)                                                                                                                                                                                                                                                                                         |
| **Lambda Cannot find module** (runtime)                                                       | Wrong handler value, missing AWS SDK v3 migration, Python deps not bundled. [Details](references/troubleshooting-deployment.md)                                                                                                                                                                                                                                                                                           |
| **API Gateway multi-stage conflicts**                                                         | Set `deploy: false` on `RestApi`, create `Deployment` and `Stage` explicitly. [Details](references/troubleshooting-deployment.md)                                                                                                                                                                                                                                                                                         |
| **Change didn't deploy under `--hotswap`**                                                    | Changes to non-hotswappable resources are silently ignored and only logged — the command still reports success. Read the output; use `--hotswap-fallback` to force a CloudFormation deployment instead. [Details](references/fast-deployments.md)                                                                                                                                                                         |
| **Failed `--express` deploy / can't roll back**                                               | Express mode cannot use the Rollback Stack API, and a standard deploy MUST NOT be used to recover it. Roll forward: fix the cause, then `cdk deploy $STACK --express`. [Details](references/fast-deployments.md)                                                                                                                                                                                                          |
| **Unexpected drift on a dev stack**                                                           | Hotswap and `cdk watch` create drift by design. Until reverted, the live resources — not CloudFormation's records — are authoritative. Reconcile with `cdk deploy $STACK --revert-drift`, which uses Drift Aware Changesets to bring live resources in line with the template (updates reality to match desired state; does NOT rewrite CF records to match drifted resources). [Details](references/fast-deployments.md) |

## Construct Patterns

Prefer L2. Use L1 with Mixins/Facades when L2 lacks a property. Escape hatches: `node.defaultChild` → `addPropertyOverride`. See [construct-patterns](references/construct-patterns.md).

## Additional Resources

- Search AWS documentation for "CDK Developer Guide", "CDK API Reference" and "CDK Pipelines" respectively

## Security Considerations

- OIDC for CI/CD credentials (no static keys)
- `--custom-permissions-boundary` on bootstrap
- `grant*()` for inter-resource IAM
- `cdk-nag` + `--strict` in CI
- Stateful resources in own stack with `terminationProtection: true`
- Commit `cdk.context.json`
