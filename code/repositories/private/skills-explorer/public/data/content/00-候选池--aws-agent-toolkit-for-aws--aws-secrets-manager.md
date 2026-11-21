---
name: aws-secrets-manager
description: >
  Secret safety for AWS Secrets Manager, secret management, credentials, API keys,
  tokens, and passwords. Prevents AI agents from directly fetching secret values
  and teaches runtime dynamic references with asm-exec so plaintext never enters
  the LLM context window.
metadata:
  version: "1"
---

# Using Secrets Safely with Agents

## Overview

When AI agents handle secrets, credentials, API keys, tokens, or passwords with
shell or AWS API access, they can call `aws secretsmanager get-secret-value`
and receive plaintext values in their context window. This creates risk:
secrets may leak into logs, conversation history, or downstream tool calls.

This skill teaches a safer pattern: **dynamic references** resolved at runtime
by a wrapper script (`asm-exec`), so the agent never sees the secret value.

> **Best-effort defense, not a security boundary.** This prevents the most common
> leakage path but cannot stop all evasion vectors. Combine with IAM
> least-privilege, CloudTrail monitoring, and VPC endpoint policies.

## Rules

You MUST follow these rules when working with secrets:

1. **MUST NOT call `get-secret-value` or `batch-get-secret-value`** -- not via AWS
   CLI, SDK, MCP tools, curl, or any other mechanism.
2. **MUST NOT attempt to read secret values** from the Secrets Manager Agent (SMA)
   daemon directly (localhost:2773 or any loopback variant).
3. **MUST use `{{resolve:secretsmanager:...}}` references** -- these are
   resolved at runtime by `asm-exec` without exposing values to you.

## The `{{resolve:...}}` Syntax

```
{{resolve:secretsmanager:<secret-id>:<field-type>:<json-key>:<version-stage>}}
```

| Component       | Required | Default        | Example                     |
| --------------- | -------- | -------------- | --------------------------- |
| `secret-id`     | Yes      | --             | `prod/db-creds` or full ARN |
| `field-type`    | No       | `SecretString` | `SecretString`              |
| `json-key`      | No       | (full value)   | `password`                  |
| `version-stage` | No       | `AWSCURRENT`   | `AWSPENDING`                |

## Using `asm-exec`

`asm-exec` is a wrapper that resolves `{{resolve:...}}` references in command
arguments and environment variables, then `exec`s the target command. The secret
value exists only in the child process -- never in the agent's context.

### Usage

```bash
# Pass a database password to psql without exposing it
asm-exec -- psql \
  "host=mydb.example.com \
   user={{resolve:secretsmanager:prod/db-creds:SecretString:username}} \
   password={{resolve:secretsmanager:prod/db-creds:SecretString:password}}" \
  -c "SELECT * FROM users LIMIT 10"

# Use default field-type (SecretString) and full value (no json-key)
asm-exec -- curl -H "Authorization: Bearer {{resolve:secretsmanager:prod/api-token}}" \
  https://api.example.com/data

# Multiple secrets in one command
asm-exec -- mysql \
  -h {{resolve:secretsmanager:prod/mysql:SecretString:host}} \
  -u {{resolve:secretsmanager:prod/mysql:SecretString:username}} \
  -p{{resolve:secretsmanager:prod/mysql:SecretString:password}} \
  -e "SHOW TABLES"
```

### How It Works

1. Scans all command arguments for `{{resolve:...}}` patterns
2. Resolves each reference through the first available backend, in order:
   1. **AWS Secrets Manager Agent (SMA)** on localhost:2773 (zero-latency, cached)
   2. **AWS MCP endpoint** (`https://aws-mcp.us-east-1.api.aws/mcp`), calling the
      `aws___run_script` tool over a SigV4-signed request (the tool runs a short
      server-side Python script that fetches the secret via `call_boto3`)
   3. Determines the secret's region from an ARN's region segment, or from
      `AWS_REGION` / `AWS_DEFAULT_REGION`, and passes it to the resolver
3. Substitutes resolved values using `re.sub` with a callable (single-pass --
   prevents re-scan injection if a secret value contains `{{resolve:...}}`)
4. Runs the target command via `subprocess.run` -- secret values exist only in the
   asm-exec process, never in the agent's context window

> **No local AWS CLI fallback for resolution.** `asm-exec` does not shell out to
> `aws secretsmanager get-secret-value` to resolve references. Resolution happens
> only through SMA or the MCP endpoint, so the plaintext value is never written to
> a local process's stdout where it could be captured.

### SigV4 signing

The MCP endpoint authenticates every tool call with AWS SigV4. `asm-exec` signs
requests itself using only the Python standard library (`hashlib`/`hmac`) -- it
does **not** depend on botocore or spin up the `mcp-proxy-for-aws-cli` proxy, keeping
the wrapper a lightweight ephemeral process. The signing service and region are
inferred from the endpoint hostname (e.g. `aws-mcp.us-east-1.api.aws` ->
service `aws-mcp`, region `us-east-1`); this signing region is independent of the
secret's own region, which is passed as the `region_name` argument to the
server-side `call_boto3` call.

Credentials for signing are resolved in order: environment variables
(`AWS_ACCESS_KEY_ID` etc.), `aws configure export-credentials` (AWS CLI v2), then
`aws configure get` (AWS CLI v1).

### Prerequisites

Either backend must be reachable, with credentials that have
`secretsmanager:GetSecretValue` permission:

- **AWS Secrets Manager Agent (SMA)** running on localhost:2773, OR
- **AWS credentials** resolvable for SigV4 signing of the MCP endpoint (see above).
  For cross-region secrets, set `AWS_REGION` (or use a full ARN) so the correct
  region is targeted.

See [SMA setup guide](https://docs.aws.amazon.com/secretsmanager/latest/userguide/secrets-manager-agent.html).

## Common Patterns

### Database connections

```bash
asm-exec -- psql "postgresql://{{resolve:secretsmanager:prod/db:SecretString:username}}:{{resolve:secretsmanager:prod/db:SecretString:password}}@db.example.com:5432/mydb"
```

### Docker with secrets

```bash
asm-exec -- docker run -e "DB_PASSWORD={{resolve:secretsmanager:prod/db:SecretString:password}}" myapp:latest
```

### Configuration file templating

```bash
# Generate config with resolved secrets, write to file
asm-exec -- sh -c 'echo "password={{resolve:secretsmanager:app/db:SecretString:password}}" > /tmp/app.conf'
```

## Structural Enforcement (Plugin Hook)

When the `aws-core` plugin is enabled, a `PreToolUse` hook automatically blocks
any attempt to call `get-secret-value` or `batch-get-secret-value` -- via AWS CLI,
MCP tools, or direct SMA access. No manual configuration needed.

The hook is defined at `plugins/aws-core/com.anthropic.claude-code/hooks/hooks.json`
and activates automatically when the plugin is installed.

## Troubleshooting

### "Secret not found" errors

Verify the secret exists and your IAM role has `secretsmanager:GetSecretValue`
permission. Check the secret name matches exactly (case-sensitive).

### SMA connection refused

The Secrets Manager Agent may not be running. This is non-fatal: `asm-exec`
falls through to the SigV4-signed MCP endpoint. Ensure AWS credentials are
resolvable (see SigV4 signing above) so that backend can authenticate.

### "Failed to resolve" errors

Both backends were unreachable or returned no value. When MCP resolution fails,
`asm-exec` prints the specific cause to stderr (`asm-exec: MCP resolution failed:
...`) -- a timeout, an unreachable endpoint, an HTTP status, a denied permission,
or a missing value -- so read that line first. Check that either SMA is
running or AWS credentials are valid (`aws sts get-caller-identity`), that the
secret's region is correct (set `AWS_REGION` or use a full ARN), and that your
identity has `secretsmanager:GetSecretValue` on the secret. A `401` from the MCP
endpoint indicates a SigV4 signing or credential problem, not a missing secret. If
the failure is a timeout, the server-side call may need longer than the default
30s -- raise it with `ASM_EXEC_MCP_TIMEOUT` (seconds).

### Resolution produces empty string

The JSON key may not exist in the secret value. Verify the secret structure
in the AWS Console or ask the secret owner to confirm the available keys.
