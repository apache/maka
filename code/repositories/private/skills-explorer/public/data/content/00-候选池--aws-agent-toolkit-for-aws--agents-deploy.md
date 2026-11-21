---
name: agents-deploy
description: >
  Use when deploying your agent to AWS, or when a deploy has failed.
  Handles pre-flight validation, CDK/IAM/quota error diagnosis, version
  management, rollback, and canary deployments. Triggers on: "deploy my
  agent", "agentcore deploy", "deploy failed", "CDK error", "rollback",
  "canary deploy", "pin version", "redeploy", "deploy stuck".
  Not for production hardening — use agents-harden. Not for adding
  capabilities before deploy — use agents-build or agents-connect.
  Not for VPC configuration errors — use agents-build.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# deploy

Deploy your AgentCore agent to AWS, or diagnose why a deploy failed.

## When to use

- You're ready to deploy and want to validate config first
- `agentcore deploy` failed with an error
- You want to preview what deploy will create without actually deploying
- You want to deploy to a specific target (staging, production)
- You need to roll back to a previous version, pin to a specific version, or set up canary deployments

## Input

`$ARGUMENTS` is optional:

```
/agents-deploy                     # interactive — pre-flight check or diagnose failure
/agents-deploy preflight           # validate config and IAM before deploying
/agents-deploy diagnose            # diagnose a failed deploy (paste error or read logs)
/agents-deploy preview             # show what deploy will create without deploying
/agents-deploy rollback            # roll back to a previous version
```

## Process

### Step 0: Verify CLI version

Run `agentcore --version`. This skill requires v0.9.0 or later. If the version is older, tell the developer to run `agentcore update` before proceeding.

### Step 1: Determine the situation

Read `agentcore/agentcore.json` and `agentcore/aws-targets.json` if they exist.

Ask (or infer from context):

> "Are you:
>
> 1. About to deploy and want to check everything first
> 2. Dealing with a failed deploy — what error did you see?
> 3. Needing to roll back or pin a specific version?"

If the developer needs versioning, rollback, or canary deployment, load [`references/versioning.md`](references/versioning.md) and follow its instructions.

---

## Path A: Pre-flight validation

Run these checks before `agentcore deploy`:

### Check 1: Validate config files

Show the developer this command to run:

```bash
agentcore validate
```

This catches malformed `agentcore.json` before CDK even starts.

### Check 2: Verify region alignment

The most common deploy failure is a region mismatch. Show the developer these commands to verify:

```bash
# Your configured AWS region
aws configure get region

# The region in your deployment target
cat agentcore/aws-targets.json

# The account you're actually authenticated as
aws sts get-caller-identity
```

The `region` in `aws-targets.json` must match your `aws configure` default region. The `account` must match the account ID from `sts get-caller-identity`.

### Check 3: Verify Bedrock model access

Show the developer this command to check enabled models in their region:

```bash
aws bedrock list-foundation-models --region $(aws configure get region) \
  --query 'modelSummaries[?modelLifecycle.status==`ACTIVE`].modelId' \
  --output table
```

Cross-region inference profile IDs use a geographic prefix (`us.`, `eu.`, `apac.`) or `global.` to control where inference runs. The CLI scaffolds `global.` by default (e.g., `global.anthropic.claude-sonnet-4-5-20250929-v1:0`), which routes to any commercial region. Geographic prefixes keep inference within that geography (e.g., `eu.` stays in EU regions). All prefixes require model access enabled in every destination region the profile covers. Check the Bedrock docs for which regions are included in each profile prefix.

### Check 4: Preview what will be deployed

```bash
agentcore deploy --dry-run
agentcore deploy --diff
```

`--dry-run` shows what resources will be created. `--diff` shows the CDK diff against what's currently deployed.

### Check 5: Verify IAM permissions

Show the developer the permissions needed and this verification command:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn $(aws sts get-caller-identity --query Arn --output text) \
  --action-names iam:CreateRole \
  --resource-arns "arn:aws:iam::*:role/*BedrockAgentCore*"
```

### Run the deploy

```bash
agentcore deploy -y          # auto-confirm (alias: agentcore dp -y)
agentcore deploy -y -v       # verbose — shows resource-level events
agentcore deploy --target staging -y   # deploy to a specific target
```

**Memory provisioning note:** If your project includes memory, deploy takes 2–5 minutes longer while the memory resource becomes ACTIVE. This is normal — not an error. Check status:

```bash
agentcore status --type memory
```

---

## Path B: Diagnose a failed deploy

### Step B1: Read the error

If the developer pasted an error, diagnose it directly. If not, read the deploy logs:

```bash
# View recent deploy logs
ls -lt agentcore/.cli/logs/
cat agentcore/.cli/logs/deploy-*.log 2>/dev/null | tail -100
```

### Step B2: Match to known failure patterns

**IAM permission error:**

```
User: arn:aws:iam::123456789012:user/dev is not authorized to perform: iam:CreateRole
```

Fix: Attach the required IAM permissions (see Check 5 above). The deploying identity needs IAM write access scoped to `*BedrockAgentCore*` roles.

**CDK bootstrap not run:**

```
This stack uses assets, so the toolkit stack must be deployed to the environment
```

Fix:

```bash
npx cdk bootstrap aws://<YOUR_ACCOUNT_ID>/<REGION>
```

**ECR authorization error:**

```
no basic auth credentials
Error response from daemon: Head "https://<YOUR_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/..."
```

Fix:

```bash
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin <YOUR_ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
```

**Model access denied during deploy:**

```
ValidationException: The provided model identifier is invalid
```

Fix: Enable the model in the Bedrock console → Model access. Ensure the model ID in `agentcore.json` matches an enabled model in your target region.

**Region mismatch:**

```
Stack ... is in region us-east-1 but the target is us-west-2
```

Fix: Update `agentcore/aws-targets.json` to match your `aws configure` default region, or run `aws configure set region <REGION>`.

**Memory stuck in CREATING:**

```
Memory resource is in CREATING state after 10 minutes
```

This is unusual — normal provisioning takes 2–5 minutes. Check:

```bash
agentcore status --type memory --json
```

If stuck, try removing and re-adding the memory resource.

**Service quota exceeded:**

```
LimitExceededException: Account limit for AgentCore runtimes exceeded
```

Fix: Request a quota increase in the AWS console → Service Quotas → Amazon Bedrock AgentCore.

### Step B3: After fixing, re-run

```bash
agentcore deploy -y
```

If the same error recurs, check `agentcore status` to see the current state of all resources:

```bash
agentcore status
agentcore status --state pending-removal  # resources marked for deletion
```

---

## Deploying to multiple targets

Define targets in `agentcore/aws-targets.json`:

```json
[
  {
    "name": "staging",
    "description": "Staging environment",
    "account": "123456789012",
    "region": "us-east-1"
  },
  {
    "name": "production",
    "description": "Production environment",
    "account": "987654321098",
    "region": "us-west-2"
  }
]
```

Deploy to a specific target:

```bash
agentcore deploy --target staging -y
agentcore deploy --target production -y
```

## Output

- Pre-flight check results with specific fixes for any issues found
- Diagnosis of deploy failure with the specific fix
- Deploy command to run after fixes are applied
