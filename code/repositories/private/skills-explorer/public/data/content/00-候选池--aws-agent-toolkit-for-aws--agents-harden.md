---
name: agents-harden
description: >
  Use when preparing your agent for production — IAM scoping, inbound
  auth (JWT, SigV4), secrets management, cold start optimization, session
  lifecycle, rate limiting, input validation, and quota guidance. Triggers
  on: "production checklist", "harden agent", "production ready", "secure
  agent", "inbound auth", "going live", "cold start optimization", "session
  lifecycle", "StopRuntimeSession", "quota", "throttling", "maxVms",
  "rate limit", "security audit of outbound API calls", "gateway target
  audit for production", "restrict who can call", "lock down endpoint",
  "only our app can call".
  Not for Cedar tool-restriction policies — use agents-connect. Not
  for quality measurement — use agents-optimize. Not for outbound
  credential storage or API key wiring — use agents-connect. Not for
  A2A agent-to-agent auth — use agents-build. Cold start observation
  and diagnosis (not optimization) routes to agents-debug.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# harden

Prepare your AgentCore agent for production — security, reliability, and performance.

## When to use

- You're about to take an agent to production
- You want a checklist of what to review before launch
- You want to restrict who can call your agent
- You want to scope down IAM permissions from the defaults
- You're hitting throttling or quota errors (loads [`references/limits.md`](references/limits.md))
- You need to tune session lifecycle for your workload
- You're running long-running background work in your agent

## Input

No arguments required. The skill reads your project config and produces a checklist with specific findings for your project.

## Process

### Step 0: Verify CLI version

Run `agentcore --version`. This skill requires v0.9.0 or later. If the version is older, tell the developer to run `agentcore update` before proceeding.

### Step 1: Read the project

Read `agentcore/agentcore.json` to understand:

- What resources are configured (memory, gateway, credentials, evaluators)
- What framework is being used
- What network mode is configured (PUBLIC or VPC)

### Step 2: Run through the checklist

Work through each category and report findings specific to the project.

---

## IAM: Scope down permissions

The auto-created execution role has broad Bedrock access (`arn:aws:bedrock:*::foundation-model/*`). For production, scope it to the specific models your agent uses.

**Check the current execution role:**

```bash
agentcore status --json | jq -r '.runtimes[0].executionRoleArn'
```

**Recommended production Bedrock policy:**

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  "Resource": [
    "arn:aws:bedrock:<REGION>::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0"
  ]
}
```

Replace the resource ARN with the specific model(s) your agent uses.

**ECR access:** Scope to your specific repository:

```json
{
  "Effect": "Allow",
  "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
  "Resource": "arn:aws:ecr:<REGION>:<YOUR_ACCOUNT_ID>:repository/bedrock-agentcore-<AGENT_NAME>-*"
}
```

**Trust policy:** Verify the execution role's trust policy is scoped to your account:

```json
{
  "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
  "Action": "sts:AssumeRole",
  "Condition": {
    "StringEquals": { "aws:SourceAccount": "<YOUR_ACCOUNT_ID>" },
    "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:<REGION>:<YOUR_ACCOUNT_ID>:*" }
  }
}
```

**Runtime resource-based policies** (API-only): For fine-grained control over which principals can invoke your runtime — beyond what IAM roles and JWT auth provide — use `PutAgentRuntimeResourcePolicy` via boto3. This is not exposed in the CLI or `agentcore.json`. Use the `awsknowledge` MCP server if available to look up the current API shape.

---

## Shell Access: Scope `InvokeAgentRuntimeCommand` separately

If your project uses `InvokeAgentRuntimeCommand` (see [`agents-build/references/integrate.md`](../agents-build/references/integrate.md)), audit its IAM permissions separately from `InvokeAgentRuntime`. The two actions have different blast radii: `InvokeAgentRuntimeCommand` is arbitrary shell execution inside a live microVM with the runtime's full execution role — callers can read/write the filesystem, reach any network resource the agent can reach, and access the execution role's credentials.

**Check which principals have the permission:**

```bash
# List customer-managed policies in your account, then inspect each for InvokeAgentRuntimeCommand
aws iam list-policies --scope Local \
  --query 'Policies[*].[PolicyName, Arn, DefaultVersionId]' \
  --output table
# Then for each policy of interest:
aws iam get-policy-version \
  --policy-arn <POLICY_ARN> \
  --version-id <VERSION_ID> \
  --query 'PolicyVersion.Document'
```

Alternatively, use the IAM console: **IAM → Policies → Filter by type: Customer managed** → search for `InvokeAgentRuntimeCommand` in the policy JSON editor.

**Separate IAM policy for command callers** — keep this distinct from the policy granting `InvokeAgentRuntime`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntimeCommand",
      "Resource": "arn:aws:bedrock-agentcore:<REGION>:<YOUR_ACCOUNT_ID>:runtime/<RUNTIME_NAME>-*"
    }
  ]
}
```

**Enable CloudTrail alerting.** Create an EventBridge rule to notify your security team when `InvokeAgentRuntimeCommand` is called:

```bash
aws events put-rule \
  --name AgentCoreCommandExecution \
  --event-pattern '{"source":["aws.bedrock-agentcore"],"detail-type":["AWS API Call via CloudTrail"],"detail":{"eventName":["InvokeAgentRuntimeCommand"]}}' \
  --state ENABLED
```

**If commands are constructed from user input anywhere in calling code:** validate before passing — reject strings containing `&&`, `;`, `$(...)`, backticks, `|`, or other shell metacharacters.

---

## Inbound auth: Control who can call your agent

By default, agents use AWS IAM (SigV4) for inbound auth. For production, verify this is configured correctly.

**Check current auth config:**

```bash
agentcore status --runtime <AgentName> --json | jq '.runtimes[0].authorizerConfig'
```

**Options:**

`AWS_IAM` (default) — callers must sign requests with SigV4. Good for internal services and AWS-native clients.

`CUSTOM_JWT` — callers present a JWT from your identity provider. Good for web/mobile apps and external clients.

```bash
agentcore add agent \
  --name MyAgent \
  --authorizer-type CUSTOM_JWT \
  --discovery-url https://your-idp.example.com/.well-known/openid-configuration \
  --allowed-audience my-api \
  --allowed-clients my-client-id
```

> [!WARNING]
> Never use `--authorizer-type NONE` in production. It allows unauthenticated access
> to your agent — anyone with the endpoint URL can invoke it. Always use AWS_IAM or
> CUSTOM_JWT. If you see NONE in production, change it immediately.

### Choosing `allowedClients` vs `allowedAudience`

This is the most common JWT misconfiguration. The right choice depends on what's inside the token your IdP issues.

**Decode a sample token** (at your IdP or with `jwt.io`) and look at the payload:

- Token has a `client_id` claim, no `aud` claim → configure **`allowedClients`** on the runtime
- Token has an `aud` claim → configure **`allowedAudience`** on the runtime
- Token has both → use `allowedAudience`. The `aud` claim is the standard OIDC audience field; use that as the primary check.

If you pick the wrong one, invocations return 403 even with a valid token — the runtime is validating against a claim the token doesn't have.

### Issuer ↔ discovery URL prefix requirement

AgentCore enforces the OIDC discovery spec (RFC 8414 §3): the `issuer` value in the discovery document must be a URL prefix of the discovery endpoint.

That means if your discovery URL is `https://qa.example.com/.well-known/openid-configuration`, the `issuer` field in that document must start with `https://qa.example.com`. If the document advertises an issuer like `https://example.com` (no subdomain), validation fails.

Some enterprise IdPs (PingFederate, Paylocity, some Keycloak setups) host the discovery endpoint on an environment-specific subdomain while advertising a production-level issuer. This pattern is incompatible with the RFC 8414 prefix rule.

Fix options:

1. **Align the IdP's discovery endpoint with its issuer** — serve discovery from the same origin as the issuer.
2. **Point the runtime at the actual discovery URL domain** — configure the runtime's discovery URL with the subdomain that matches the token's issuer.

### Debugging JWT auth failures

When invocations fail with 403, narrow down which check is failing.

**`Authorization method mismatch`** — the runtime's auth type and the request's auth type don't match. Two cases:

- The runtime is configured for `AWS_IAM` (or no authorizer) but the caller is sending a Bearer token → reconfigure the runtime for `CUSTOM_JWT`, or have the caller use SigV4.
- The runtime is configured for `CUSTOM_JWT` but the caller's request is being SigV4-signed → likely the SDK or environment is injecting SigV4 headers alongside the Bearer token. Check for `X-Amz-Date`, `X-Amz-Security-Token`, or `Authorization: AWS4-HMAC-SHA256` in the outbound request. Remove the SigV4 path and send only the Bearer token.

**`Invalid inbound token`** (or similar) — the token was rejected by the JWT validator. Walk through these in order:

1. **Issuer ↔ discovery URL prefix** (above) — verify the token's `iss` claim matches the discovery URL's origin
2. **`allowedClients` vs `allowedAudience`** — is the runtime configured for the right claim for your token format?
3. **JWKS reachability** — can AgentCore reach the `jwks_uri` listed in the discovery document? It must be publicly reachable.
4. **Token expired** — decode the token, check `exp` against now
5. **Signing algorithm support** — some IdPs sign with algorithms (PS256, ES384, etc.) that aren't universally supported. Check your IdP's supported algorithms and switch to RS256 if compatibility is the issue.

Only after ruling all of those out should you treat it as a service-side issue.

---

## Error handling: Fail gracefully

Check that your agent code handles errors without exposing internal details:

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    try:
        # your agent logic
        return {"response": result}
    except Exception as e:
        # Log the full error internally
        app.logger.error(f"Agent error: {e}", exc_info=True)
        # Return a safe message to the caller
        return {"error": "An error occurred. Please try again."}

if __name__ == "__main__":
    app.run()
```

**Check for:** bare `except` blocks that swallow errors silently, error messages that expose stack traces or internal details to callers, missing error handling in tool call code.

---

## Input validation and rate limiting

Agent entrypoints receive arbitrary payloads from callers. Validate inputs before processing:

```python
@app.entrypoint
def invoke(payload, context):
    prompt = payload.get("prompt", "")

    # Validate input
    if not prompt or not isinstance(prompt, str):
        return {"error": "Missing or invalid 'prompt' field"}
    if len(prompt) > 10000:
        return {"error": "Prompt exceeds maximum length (10,000 characters)"}

    # Sanitize — strip control characters, excessive whitespace
    prompt = " ".join(prompt.split())

    # Proceed with validated input
    result = agent(prompt)
    return {"response": str(result)}
```

**What to validate:**

- Required fields are present and have the expected type
- String inputs don't exceed reasonable length limits (prevents token-bombing the model)
- Numeric inputs are within expected ranges
- User-provided IDs (actor_id, session_id) match expected formats

**Rate limiting:** AgentCore Runtime has built-in invocation rate limits (default 25 TPS per agent — see [`references/limits.md`](references/limits.md)). For application-level rate limiting (per-user, per-tenant), implement it in your calling application or API Gateway layer, not in the agent code itself. The agent should assume it's already been rate-limited by the time a request reaches it.

---

## Secrets: No credentials in code, no secrets in runtime env vars

Two failure modes to check for:

### 1. Hardcoded secrets in agent code

```bash
# Search for common secret patterns in agent code
grep -r "sk-\|api_key\s*=\s*['\"]" app/ --include="*.py"
grep -r "password\s*=\s*['\"]" app/ --include="*.py"
```

### 2. Secrets pulled from runtime environment variables

AgentCore Runtime environment variables are **not** vault-backed. Anything a developer stuffs into the runtime's env (via CDK, boto3 `UpdateAgentRuntime`, or similar) is a plaintext config value, not a secret. Audit for the pattern:

```bash
# Flag any os.getenv / os.environ call whose name implies a secret
grep -rE "os\.(getenv|environ).*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)" app/ --include="*.py"
```

Non-secret identifiers injected by the platform are fine and should not match an allowlist (e.g., `MEMORY_*_ID`, `AGENTCORE_GATEWAY_*_URL`, `AWS_REGION`, downstream agent ARNs). Review hits and confirm none are secrets.

**Correct pattern:** Register each outbound credential with `agentcore add credential`, then fetch it in code via the integrated credential providers:

```python
from bedrock_agentcore.identity.auth import requires_api_key, requires_access_token

@requires_api_key(provider_name="MyAPI")
def call_api(payload: dict, *, api_key: str) -> dict:
    ...

@requires_access_token(provider_name="MyOAuthProvider", scopes=["read"], auth_flow="M2M")
async def call_downstream(data: dict, *, access_token: str) -> dict:
    ...
```

The decorator fetches from Secrets Manager at call time and handles caching/refresh. Credentials registered this way are encrypted at rest and rotated without a redeploy.

**Local dev:** `agentcore/.env.local` (gitignored) is read by `agentcore dev` so the decorator resolves locally. This file is **not** uploaded to runtime on deploy — production credentials live in the credential provider.

---

## Tool surface: Prefer Gateway targets over direct HTTP in agent code

A related audit — for every external service the agent calls, ask whether it should be a Gateway target instead of a direct HTTP call buried in agent code. Gateway's credential providers inject auth at the edge (so the agent process never sees the secret), the tool catalog is policy-enforceable, and a leaked traceback/log line from agent code can't exfiltrate credentials that never reached it.

```bash
# Find direct outbound HTTP calls in agent code
grep -rEn 'httpx\.|requests\.|aiohttp\.' app/ --include="*.py"
```

For each hit, decide:

| Hit looks like                                                                                   | Action                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Calls an external REST API the agent treats as a tool                                            | Front as a Gateway target (`agentcore add gateway-target --type open-api-schema` or `api-gateway`). Load [`agents-connect/SKILL.md`](../agents-connect/SKILL.md) Path C. |
| Calls an MCP server directly                                                                     | Front as a Gateway target (`--type mcp-server`). Load [`agents-connect/SKILL.md`](../agents-connect/SKILL.md) Path A.                                                    |
| Calls an AWS service (S3, DynamoDB, etc.) — not appropriate to match this row, should be `boto3` | Migrate from `requests`/`httpx` to the `boto3` client, using the runtime's execution role for IAM. No credential needed.                                                 |
| Calls a streaming service (SSE-with-live-output, WebSocket, WebRTC)                              | OK to keep direct — Gateway doesn't front these yet. Confirm any auth uses `@requires_*`, not `os.getenv`.                                                               |
| Calls another agent via A2A                                                                      | OK to keep direct — A2A is HTTP-by-design. Confirm it uses `@requires_access_token` for the bearer token.                                                                |
| Calls a measured latency hot path and the team chose it                                          | OK, but confirm measurement exists and auth uses `@requires_*`.                                                                                                          |

If the hit fits none of the "OK to keep direct" rows, open a ticket to convert it to a Gateway target. Gateway targets can be added without a code change in the agent for most framework integrations (MCP tool discovery handles binding).

---

## Observability: Verify tracing is enabled

AgentCore enables X-Ray tracing and CloudWatch logging automatically. Verify:

```bash
agentcore status --runtime <AgentName> --json | jq '.runtimes[0].observabilityConfig'
```

**CloudWatch dashboard:** AWS Console → CloudWatch → GenAI Observability → Bedrock AgentCore

**Log retention:** By default, logs are retained indefinitely. Set a retention policy for cost control:

```bash
aws logs put-retention-policy \
  --log-group-name /aws/bedrock-agentcore/runtimes/<AGENT_ID>-DEFAULT \
  --retention-in-days 30
```

---

## Evaluation baseline: Know your quality before launch

Before going to production, establish a quality baseline so you can detect regressions:

```bash
# Run a baseline eval
agentcore run eval \
  --evaluator "Builtin.Helpfulness" \
  --evaluator "Builtin.GoalSuccessRate"

# Set up continuous monitoring
agentcore add online-eval \
  --name production_monitor \
  --runtime <AgentName> \
  --evaluator "Builtin.Helpfulness" \
  --sampling-rate 5
agentcore deploy -y
```

Record the baseline scores. If scores drop significantly after a change, investigate before continuing.

---

## Network: VPC for private resources

If your agent accesses private AWS resources (RDS, internal APIs), configure VPC:

```bash
agentcore add agent \
  --name MyAgent \
  --network-mode VPC \
  --subnets subnet-abc,subnet-def \
  --security-groups sg-123
```

See `agents-build` (loads [`references/vpc.md`](../agents-build/references/vpc.md)) for full VPC configuration guidance.

---

## Initialization time: Optimize cold start performance

Slow agent initialization causes timeouts, 424 errors, and poor user experience — especially on first invocation after a period of inactivity. Everything the agent does before it's ready to handle a request adds to the time users wait.

### Where cold start time actually goes

A typical cold start for a new environment takes around 20–30 seconds. The breakdown, roughly:

- **Container image pull** — dominates for Container builds. A 100 MB image takes a few seconds; a 500 MB image can take 15+ seconds.
- **Application startup** — your code's import time, framework init, module-level setup. Usually 5–10 seconds, can be much more if you're loading models or opening connections at import.
- **Platform overhead** (microVM boot, network attach, container start) — sub-second to a couple of seconds.

The two you control are image size and application startup. Optimizing either one directly reduces time to first response.

### Session reuse is the highest-leverage optimization

Same-session requests route to an existing initialized environment — no cold start. The first request per session pays the cold-start cost; every subsequent request on that session is fast.

Concrete patterns:

- **Multi-turn conversations:** reuse the same `session_id` across turns. Don't generate a new UUID per turn.
- **Batch processing:** reuse the same `session_id` across items in the batch.
- **User-facing apps:** scope a session to a user interaction (e.g., one session per chat conversation), not one session per message.

Cross-SDK note: if you're using MCP, pass **one** session identifier, not both `runtimeSessionId` and `mcpSessionId` at once. Sending both can cause the platform to bind two separate environments to the same logical session, doubling cold-start cost.

### Package size budget

Every MB of deployment package adds to cold-start time.

- **Target:** under 200 MB. Aim for under 100 MB if you can.
- **For Container builds:** multi-stage Dockerfiles, slim or distroless base images, remove build tools and test files, add a `.dockerignore`.
- **For CodeZip builds:** prune dev dependencies from `pyproject.toml` / `requirements.txt`. Don't ship `tests/`, `docs/`, `.git/`, local caches.
- **Audit regularly:** `pip list` (Python) or `npm ls` (Node) will show you what's actually installed. Remove anything you're not using.

### Defer heavy initialization

Don't load large models, connect to databases, or initialize MCP clients at module import time. Every second spent in module import is a second the agent can't respond to requests.

```python
# ❌ Slow — runs at import time, before the agent can handle requests
import heavy_library
client = heavy_library.Client(config)

# ✅ Fast — defers until first request
_client = None
def get_client():
    global _client
    if _client is None:
        import heavy_library
        _client = heavy_library.Client(config)
    return _client
```

### Choose deployment type based on traffic pattern, not by default

The skill previously recommended CodeZip over Container when possible. That's an oversimplification. Here's the real trade-off:

- **CodeZip:** simpler to iterate on, smaller surface area. Cold start includes code download + extract — a ~95 MB package adds around 1.3 seconds of platform download before application startup even begins.
- **Container:** you control the full image, needed for custom system dependencies. Larger images cost more per cold start, but you can optimize aggressively with multi-stage builds.

Neither wins universally. Both benefit the same way from session reuse and from keeping the package small. If your traffic pattern has lots of bursty cold sessions, invest in shrinking whichever deployment artifact you're using. If your traffic pattern reuses sessions, the deployment type matters much less.

### For Lambda targets behind Gateway

Use provisioned concurrency on the Lambda function to eliminate Lambda cold starts. This is separate from Runtime initialization — it's the Lambda itself that adds latency on first invocation of a cold Lambda.

---

## Session lifecycle management

Session management is tightly linked to cost, performance, and the `maxVms` quota. Getting this right is often the difference between a smooth production launch and a quota-blocked one.

### The default lifecycle

When a request arrives with a new session ID, the runtime initializes a fresh environment for it. That environment stays alive until one of:

1. **The session is explicitly stopped** via `StopRuntimeSession`.
2. **The idle timeout expires.** The runtime reclaims environments that haven't received a request for `idleRuntimeSessionTimeout` (default 900 seconds).
3. **The maximum lifetime is reached** (`maxLifetime`, default 8 hours).

Idle environments count against your `maxVms` quota until they're reclaimed, even though they're not serving traffic. This is the #1 cause of unexpected `maxVms` errors.

### Pick timeouts by workload shape

Don't leave defaults for production. Pick values that match how your workload actually uses sessions:

| Workload                                               | `idleRuntimeSessionTimeout` | `maxLifetime`             | Reasoning                                                                                  |
| ------------------------------------------------------ | --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Interactive chat / support agent                       | 600–900s (default)          | 3600–7200s                | Users pause to read/think. Reclaim fast after they leave.                                  |
| Request/reply API with no follow-up                    | 60–120s                     | 1800s                     | Each call is self-contained — release the VM quickly.                                      |
| Batch processing, one session per job                  | 120s                        | match job length + buffer | Idle gap between items in the batch is small; reclaim aggressively between jobs.           |
| Background / long-running tasks (use `add_async_task`) | 120–300s                    | up to 28800s (8h)         | Async task API keeps the VM alive during tracked work; idle timeout applies between tasks. |

**Trade-offs at a glance:**

- **Low idle timeout** = more headroom under `maxVms`, lower cost. **Risk:** reclaim mid-conversation causing next turn to cold-start.
- **High idle timeout** = warm turns, lower latency. **Risk:** idle VMs consume quota; `maxVms` errors on bursts.
- **Low max lifetime** = predictable recycle, bounds memory leaks / stale state. **Risk:** active long sessions get killed mid-flow.
- **High max lifetime** = sticky sessions, big warm-state savings. **Risk:** drift, stale in-memory state, harder rollouts.

### Best practices

**Call `StopRuntimeSession` when the work is done.** If your agent finishes a task and doesn't expect more requests on that session, explicitly stop it. This releases the environment immediately instead of waiting for idle timeout.

```python
# After your invocation logic completes and you know the session is done:
client.stop_runtime_session(
    agentRuntimeArn=runtime_arn,
    runtimeSessionId=session_id,
)
```

**Reuse session IDs for related work.** A new session ID for every HTTP request means a new environment for every HTTP request. For multi-turn conversations, batch jobs, or user-facing interactions, use one session ID per conversation/batch/user-interaction and route all related requests to it.

**Tune `idleRuntimeSessionTimeout` to your workload.** The default 900 seconds is appropriate for interactive workloads where you expect quick follow-up requests. For request-reply workloads where sessions are short-lived, lower it.

Edit the runtime's entry in `agentcore/agentcore.json`:

```json
{
  "runtimes": [
    {
      "name": "MyAgent",
      "lifecycleConfiguration": {
        "idleRuntimeSessionTimeout": 120,
        "maxLifetime": 3600
      }
    }
  ]
}
```

Then `agentcore deploy` to apply. The CLI and CDK handle the underlying `UpdateAgentRuntime` call for you.

If you prefer the CLI, `agentcore add agent ... --idle-timeout 120 --max-lifetime 3600` writes the same fields into `agentcore.json`. The file is the source of truth — every field in it has IDE autocomplete via the `$schema` URL at the top of the file (`https://schema.agentcore.aws.dev/v1/agentcore.json`).

Lower timeout = faster VM reclamation = more headroom under `maxVms`. Too low = environments get reclaimed mid-conversation, causing the next turn to cold-start.

**Don't pass both `runtimeSessionId` and `mcpSessionId` together.** For MCP agents, use one. Passing both can bind two separate VMs to the same logical session.

### Diagnosing `maxVms` problems

If you hit `ServiceQuotaExceededException: maxVms limit exceeded`, don't request a quota increase first. CloudWatch's concurrent-sessions metric is not the same as live VM count — idle environments count against the quota until reclaimed.

Work through this order:

1. Add `StopRuntimeSession` after each logical request completes
2. Audit session-ID generation — are you creating a new ID per request that should reuse one?
3. Lower `idleRuntimeSessionTimeout` if your sessions are short-lived
4. Only then, if you've done all of the above and still hit the limit, request an increase

See [`references/limits.md`](references/limits.md) for the increase-request workflow (via the Service Quotas console) and the justification template.

---

## Long-running background tasks

If your agent fires off work that outlives the `/invocations` response — background processing, async jobs, long tool chains — a fire-and-forget pattern isn't enough. The environment can be reclaimed at `idleRuntimeSessionTimeout` even while your background task is still running, because the runtime considers the session idle once the invocation response is sent.

### Use the SDK's async task API to signal "still busy"

The bedrock-agentcore SDK provides task registration that keeps the environment alive while tracked work runs. In Python:

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    # Register the task BEFORE starting it
    task_id = app.add_async_task("background_work")

    # Kick off the work (in a thread, asyncio, etc.)
    start_background_work(task_id, payload)

    # Return the invocation response — the task is still tracked
    return {"status": "processing", "taskId": task_id}


def start_background_work(task_id, payload):
    try:
        # Long-running work here
        do_the_work(payload)
    finally:
        # Mark the task complete when done — this releases the "busy" signal
        app.complete_async_task(task_id)

if __name__ == "__main__":
    app.run()
```

While at least one registered task is active, the runtime sees the environment as busy and doesn't reclaim it at `idleRuntimeSessionTimeout`. `maxLifetime` (default 8 hours) still applies as a hard ceiling.

Check the bedrock-agentcore SDK docs for your language for the equivalent API — the TypeScript SDK has an analogous pattern.

### Alternatives when async task API isn't an option

- **Increase `idleRuntimeSessionTimeout` to match your expected task duration.** If you know tasks run up to 10 minutes, set the timeout to 12 minutes. Keep it well under `maxLifetime`.
- **Keep the HTTP connection open** with a streaming response and emit periodic heartbeat events. Useful when you want the caller to wait for the result rather than polling. See the SSE keepalive pattern in [`agents-debug/SKILL.md`](../agents-debug/SKILL.md) ("Connection drops mid-stream" section).
- **Split long work across multiple invocations** on the same session. Each invocation resets the idle clock.

---

## Quotas and limits

If you're hitting throttling, `ServiceQuotaExceededException`, or any other quota-related error — or you're about to launch and want to make sure quotas won't block you — load [`references/limits.md`](references/limits.md).

That reference covers:

- Which quota each error maps to
- Mitigations to try before requesting an increase (critical — most "quota" errors are actually session-lifecycle issues)
- How to request an increase through the Service Quotas console (the edge case where a direct Support case is needed is rare)
- A copy-paste justification template with everything a reviewer needs to approve

---

## Production checklist summary

Generate a checklist specific to the project:

```
Production Readiness Checklist for <AgentName>

IAM
[ ] Execution role Bedrock access scoped to specific model ARNs
[ ] ECR access scoped to specific repository
[ ] Trust policy scoped to your account ID

Authentication
[ ] Inbound auth is AWS_IAM or CUSTOM_JWT (not NONE)
[ ] If CUSTOM_JWT: discovery URL, audience, and client IDs configured

Shell Access (if using InvokeAgentRuntimeCommand)
[ ] InvokeAgentRuntimeCommand permission granted only to identities that need it
[ ] Separate IAM policy from InvokeAgentRuntime policy
[ ] CloudTrail / EventBridge alert configured for InvokeAgentRuntimeCommand calls
[ ] If commands constructed from user input: shell injection validation implemented

Code quality
[ ] Error handling wraps all agent logic
[ ] Input validation on payload fields (type, length, format)
[ ] No secrets hardcoded in agent code
[ ] Credentials registered via agentcore add credential

Observability
[ ] X-Ray tracing enabled (auto-configured)
[ ] CloudWatch log retention policy set
[ ] Eval baseline established

Performance
[ ] Agent initialization time measured and optimized
[ ] Deployment package size under 200 MB (target under 100 MB)
[ ] Dependencies audited — no unused packages
[ ] Heavy initialization deferred to request time
[ ] Session reuse strategy chosen for multi-turn / batch workloads
[ ] `StopRuntimeSession` called after work completes where applicable
[ ] `idleRuntimeSessionTimeout` tuned to workload (default 900s)
[ ] For long-running background tasks: `add_async_task` / `complete_async_task` used

Resources
[ ] Memory strategies appropriate for use case (if using memory)
[ ] Gateway auth configured (if using gateway)
[ ] Policy engine attached (if restricting tool access)

Testing
[ ] Agent tested with production-representative inputs
[ ] Error cases tested (tool failures, model errors)
[ ] Memory cross-session tested (if using LTM)
```

## Output

- Checklist with specific findings for the project
- Specific commands to fix any issues found
- Recommended IAM policy for the detected model and resources
