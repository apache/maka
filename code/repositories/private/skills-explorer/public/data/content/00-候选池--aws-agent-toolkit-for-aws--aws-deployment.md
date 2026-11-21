---
name: aws-deployment
description: "Configures CI/CD pipelines using AWS CodePipeline, CodeBuild, CodeDeploy, CodeConnections, and CodeArtifact. Covers CodePipeline V2 (triggers, variables, execution modes, cross-account), buildspec.yml (caching, VPC, Docker), CodeDeploy strategies (blue/green, canary, linear), CodeArtifact (private package registries, auth tokens, cross-account), and source connections (GitHub, GitLab, Bitbucket). Applies when CodePipeline, CodeBuild, CodeDeploy, CodeConnections, CodeArtifact, buildspec.yml, appspec.yml, or CI/CD pipeline orchestration is referenced. Does NOT cover: ECS Fargate services or task definitions (use aws-containers), CDK Pipelines or cdk deploy (use aws-cdk), sam deploy (use aws-serverless), Amplify deployments (use aws-amplify), or GitHub Actions/GitLab CI."
metadata:
  version: "1"
---

# AWS Deploy (CI/CD)

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) for running CLI commands and validating configurations directly. All guidance also works with standard AWS CLI.

## Critical Warnings

**CodeConnections PENDING trap**: Connections created via CLI/CloudFormation remain `PENDING` indefinitely — MUST complete OAuth in the AWS Console. No API-only path exists.

**Cross-account triple requirement**: Cross-account deploys need ALL THREE: (1) KMS key policy granting target account (use key ID, not alias), (2) S3 bucket policy for target account, (3) cross-account IAM role with trust policy. Missing any one = cryptic `Access Denied`.

**CodeDeploy ApplicationStop uses PREVIOUS revision**: Broken stop scripts in a prior deployment block ALL future deploys. Make stop scripts idempotent (exit 0 if service absent). Unblock with `--ignore-application-stop-failures`.

**CodeBuild VPC without NAT**: Builds in VPC subnets without NAT gateway hang at `DOWNLOAD_SOURCE` silently. Private subnets MUST have NAT gateway or VPC endpoints.

**CodeConnections IAM**: Use `codeconnections:` prefix for API calls and IAM policy Actions. Resource ARNs must match exactly — new resources use `codeconnections` prefix, existing resources may use `codestar-connections` prefix. Specify both in Resource if you have mixed-age resources.

**UseConnection is over-permissive**: `codeconnections:UseConnection` grants access to ALL repositories the connection can reach. MUST specify condition keys (`codeconnections:FullRepositoryId`, `codeconnections:ProviderAction`, `codeconnections:BranchName`) to limit CodeBuild to only the required repository.

## How These Services Compose

CodeConnections → CodeBuild → CodeDeploy, orchestrated by CodePipeline.

| Layer        | Service         | Role                                                                |
| ------------ | --------------- | ------------------------------------------------------------------- |
| Source       | CodeConnections | Authenticates to GitHub/GitLab/Bitbucket, delivers code             |
| Packages     | CodeArtifact    | Private package registry, dependency caching from public registries |
| Build/Test   | CodeBuild       | Compiles, tests, packages artifacts                                 |
| Deploy       | CodeDeploy      | Deploys to EC2/ECS/Lambda with traffic shifting strategies          |
| Orchestrator | CodePipeline    | Chains stages, manages transitions, approval gates                  |

Default: V2 pipeline type with QUEUED execution mode. Use PARALLEL only when executions are fully independent.

## Quick Navigation

| You want to...                                     | Go to                                               |
| -------------------------------------------------- | --------------------------------------------------- |
| Create a pipeline (V2, triggers, variables, modes) | [codepipeline.md](references/codepipeline.md)       |
| Connect GitHub/GitLab/Bitbucket source             | [codeconnections.md](references/codeconnections.md) |
| Write buildspec.yml / configure builds             | [codebuild.md](references/codebuild.md)             |
| Set up private package registry for builds         | [codeartifact.md](references/codeartifact.md)       |
| Configure deployment strategy (blue/green, canary) | [codedeploy.md](references/codedeploy.md)           |
| Cross-account or cross-region deployment           | [codepipeline.md](references/codepipeline.md)       |
| Fix failing pipeline, build, or deployment         | [troubleshooting.md](references/troubleshooting.md) |

## Common Workflows

| Task                        | Action                                                                            | Reference                                                                          |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Pipeline from GitHub to ECS | Create connection → CodeBuild Docker stage → CodeDeploy ECS blue/green            | [codepipeline](references/codepipeline.md), [codedeploy](references/codedeploy.md) |
| Pipeline stuck at source    | Check connection status; if PENDING, complete OAuth in AWS Console                | [troubleshooting](references/troubleshooting.md)                                   |
| Build timing out            | Check VPC/NAT, increase `timeoutInMinutes`, verify Docker privileged mode         | [codebuild](references/codebuild.md)                                               |
| Deploy to another account   | Configure KMS + S3 bucket policy + cross-account role, add `RoleArn` to action    | [codepipeline](references/codepipeline.md)                                         |
| Roll back failed deployment | Auto-rollback on alarm/failure; manual: `stop-deployment --auto-rollback-enabled` | [codedeploy](references/codedeploy.md)                                             |
| Lambda canary deployment    | CodeBuild packages → CodeDeploy Lambda with canary traffic shifting               | [codedeploy](references/codedeploy.md)                                             |

## Troubleshooting

| Error/Symptom                          | Cause                                                                                  | Fix                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `YAML_FILE_ERROR` in CodeBuild         | Missing or malformed `runtime-versions` in buildspec (recommended for standard images) | Add `runtime-versions` block in install phase                 |
| `file already exists` on CodeDeploy    | Redeployment without overwrite config                                                  | Set `file_exists_behavior: OVERWRITE`                         |
| Pipeline trigger not firing            | File path filter checks only first 100 files in diff                                   | Reduce path filter scope or merge smaller                     |
| PARALLEL mode wrong revision           | Race between event and source action                                                   | Use QUEUED mode for sequential consistency                    |
| Docker: `Cannot connect to daemon`     | Missing privileged mode                                                                | Set `privilegedMode: true` AND start dockerd in buildspec     |
| `CODEBUILD_CLONE_REF` permission error | CodeBuild role missing UseConnection                                                   | Add `codeconnections:UseConnection` to CodeBuild service role |
| Deployment never completes             | MinimumHealthyHosts too high for instance count                                        | Ensure healthy threshold < total instances                    |
| ECS deployment stuck                   | Health check failing on new task set                                                   | Verify target group health check path/port                    |

## Security

- MUST store secrets in Secrets Manager or Parameter Store; reference via CodeBuild `type: SECRETS_MANAGER` — MUST NOT embed in buildspec as PLAINTEXT
- MUST use customer-managed KMS keys for cross-account artifact encryption (default encryption does not support cross-account)
- SHOULD scope CodeBuild/CodeDeploy service roles to specific resource ARNs; MUST NOT use `*` for `s3:GetObject` or `kms:Decrypt`
- MUST use CodeConnections (not personal access tokens) for source connections; OAuth tokens cannot be rotated automatically
- See [CodePipeline security best practices](https://docs.aws.amazon.com/codepipeline/latest/userguide/security-best-practices.html) for comprehensive guidance

## Not Covered

| Topic                                                           | Use instead                    |
| --------------------------------------------------------------- | ------------------------------ |
| CDK Pipelines (`aws-cdk-lib/pipelines`)                         | `aws-cdk`                      |
| `sam deploy` / SAM CLI                                          | `aws-serverless`               |
| ECS service deployment config (circuit breaker, rolling params) | `aws-containers`               |
| GitHub Actions / GitLab CI                                      | Third-party tools, not covered |
