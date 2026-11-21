---
name: agents-debug
description: >
  Use when your agent or environment is broken — wrong answers, errors,
  timeouts, tool failures, or CLI issues. Reads traces and logs to
  diagnose root causes. Also checks prerequisites when the CLI itself
  isn't working. Triggers on: "agent not working", "wrong answer",
  "agent error", "tool call failing", "debug agent", "check logs",
  "read traces", "broken", "500 error", "424 error", "model access
  denied", "command not found", "stuck in DELETING", "maxVms exceeded",
  "cold start diagnosis", "cold start slow", "agentcore create error",
  "create failed", "exit code 7", "connection refused local dev".
  Not for deploy failures — use agents-deploy. Not for performance
  tuning without errors — use agents-optimize. Not for VPC
  configuration — use agents-build. Not for observability setup or
  missing logs — use agents-optimize.
allowed-tools: Read Grep Glob Bash
metadata:
  type: skill
  version: "1.0.0"
  author: aws-agentcore
  requires-cli: ">=0.9.0"
---

# debug

Diagnose why your AgentCore agent or environment isn't working correctly.

## When to use

- Your agent is returning wrong answers or errors
- Tool calls are failing or timing out
- Agent works locally but fails after deploying
- Logs aren't showing up in CloudWatch
- The AgentCore CLI isn't working or environment seems broken
- `agentcore` command not found or prerequisites are missing

Do NOT use for:

- Deploy failures (CDK errors, IAM during deploy) → use `agents-deploy`
- Scaffolding a new project → use `agents-get-started`
- Measuring quality or setting up monitoring → use `agents-optimize`

## Input

`$ARGUMENTS` is optional:

```
/agents-debug                      # interactive — describe what's wrong
/agents-debug traces               # read and explain recent traces
/agents-debug logs                 # search recent logs for errors
/agents-debug memory               # diagnose memory recall issues specifically
/agents-debug doctor               # check environment prerequisites
```

## Process

### Step 0: Determine problem type

If the developer's issue is about the CLI itself (command not found, prerequisites, environment setup), load [`references/doctor.md`](references/doctor.md) and follow its diagnostic checklist.

If the issue is about agent behavior (wrong answers, errors, timeouts, tool failures), continue with Step 1 below.

### Step 1: Verify CLI version

Run `agentcore --version`. This skill requires v0.9.0 or later. If the version is older, tell the developer to run `agentcore update` before proceeding.

### Step 2: Understand the symptom

Ask (or infer from context):

> "What's happening?
>
> 1. The agent returns an error message
> 2. The agent returns a wrong or unhelpful answer
> 3. A specific tool call is failing
> 4. Memory isn't working (agent doesn't remember things)
> 5. The agent is slow or timing out
> 6. I want to understand what the agent did in a specific session"

### Step 3: Read traces and logs automatically

Don't ask the developer to paste logs — read them directly.

```bash
# List recent traces
agentcore traces list --runtime <AgentName> --since 1h

# Get the most recent trace ID
agentcore traces list --runtime <AgentName> --since 1h --limit 1

# Download and read the trace
agentcore traces get <traceId> --runtime <AgentName>

# Search logs for errors
agentcore logs --runtime <AgentName> --since 1h --level error

# Search logs for a specific pattern
agentcore logs --runtime <AgentName> --since 2h --query "timeout"
agentcore logs --runtime <AgentName> --since 2h --query "model access"
```

**Important:** CloudWatch put-to-get latency is **~10 seconds end-to-end** — that's the delay from when a span is emitted to when it's readable by `agentcore traces get` or `agentcore run eval`. There is **no separate "trace ingested but eval not ready yet" window**; the same ingestion step unlocks both paths. Older skills and docs said 30–60s for traces and 2–5 minutes for evals — both are stale. If you just invoked the agent, wait ~15 seconds and both trace reads and evals will work.

Read `agentcore/agentcore.json` to get the agent name if not provided.

### Step 4: Diagnose by symptom

---

## Symptom: "model access denied" or model error

**Most common cause:** The model isn't enabled in the Bedrock console for your region.

Fix:

1. Go to AWS Console → Amazon Bedrock → Model access
2. Enable the model your agent uses
3. Wait 1–2 minutes for access to propagate

**Second cause:** The execution role is missing `bedrock:InvokeModel`.

Check:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn $(agentcore status --json | jq -r '.runtimes[0].executionRoleArn') \
  --action-names bedrock:InvokeModel \
  --resource-arns "arn:aws:bedrock:*::foundation-model/*"
```

**Third cause:** Cross-region inference profile requires model access in all regions.

Model IDs starting with a geographic prefix are cross-region inference profiles that route requests within that geography:

| Prefix    | Geography                        | Example destination regions                                |
| --------- | -------------------------------- | ---------------------------------------------------------- |
| `us.`     | United States                    | us-east-1, us-east-2, us-west-2                            |
| `eu.`     | Europe                           | eu-central-1, eu-west-1, eu-west-2, eu-west-3              |
| `apac.`   | Asia Pacific                     | ap-northeast-1, ap-southeast-1, ap-southeast-2, ap-south-1 |
| `global.` | All commercial regions worldwide | All supported regions                                      |

The AgentCore CLI scaffolds `global.` by default (e.g., `global.anthropic.claude-sonnet-4-5-20250929-v1:0`). All prefixes require model access enabled in every destination region the profile covers. For `us.` profiles, enable in all US regions; for `eu.`, all EU regions; for `global.`, all supported regions. Not all models support all prefixes — `global.` is currently available for select models only. Use `global.` for maximum throughput when available, or a geographic prefix when data residency requirements constrain where inference can run. Check the Bedrock inference profiles docs for current model × prefix availability.

---

## Symptom: Tool call failing

**Step 1:** Find the failing tool call in the trace:

```bash
agentcore traces get <traceId> --runtime <AgentName>
```

Look for tool call entries with error status.

**Step 2:** Check the gateway status:

```bash
agentcore status --type gateway
agentcore fetch access --name <AgentName> --type agent
```

**Step 3:** Common tool call failures:

**Gateway URL not set (local dev):**
The `AGENTCORE_GATEWAY_*_URL` env var is only set after deploy. In `agentcore dev`, gateway tools aren't available. This is expected — the agent should handle this gracefully.

**Auth failure on tool call:**

```bash
agentcore logs --runtime <AgentName> --since 1h --query "auth"
```

Check that the credential is configured correctly: `agentcore status --type credential`

**Lambda function error:**
The Lambda itself is failing. Check Lambda logs directly:

```bash
aws logs tail /aws/lambda/<function-name> --since 1h
```

**Policy denial:**
If a policy engine is attached, check policy decision logs:

```bash
agentcore logs --runtime <AgentName> --since 1h --query "policy"
agentcore status --type policy-engine
```

---

## Symptom: Wrong or unhelpful answers

**Step 1:** Read the trace to see the agent's reasoning:

```bash
agentcore traces get <traceId> --runtime <AgentName>
```

The trace shows the model's reasoning steps, tool calls made, and the final response. Look for:

- Did the agent use the right tools?
- Did the tool calls return the expected data?
- Is the system prompt providing the right context?

**Step 2:** Check if memory is involved:
If the agent should be using memory context but isn't, see the "Symptom: Memory not persisting" section later in this skill, or load [`references/doctor.md`](references/doctor.md) if this is an environment issue.

**Step 3:** Common causes:

- System prompt is too vague or missing key context
- Agent isn't calling the right tools (tool descriptions need improvement)
- Tool is returning unexpected data format
- Model ID is wrong for the task (e.g., using a smaller model for complex reasoning)

---

## Symptom: Memory not working

**Memory not persisting across sessions (LTM):**

1. Verify LTM strategies are configured (SEMANTIC or USER_PREFERENCE):

```bash
agentcore status --type memory --json | jq '.memories[].strategies'
```

1. Wait 5–30 seconds after a session ends — LTM extraction is async. The agent must finish its session before facts are extracted.

2. Use UUIDs (v4) for session IDs — the platform requires a minimum of 33 characters. Short IDs like "session-1" cause LTM to fail silently. `agentcore invoke` generates compliant IDs by default.

3. Verify the memory resource is ACTIVE:

```bash
agentcore status --type memory
```

**Memory not loading at session start:**

1. Check the `MEMORY_*_ID` env var is set:

```bash
agentcore status --type memory --json | jq '.memories[].id'
```

1. Verify the `actor_id` is consistent across sessions — memory is scoped per actor.

2. Check the namespace paths in your retrieval config match the namespaces used when writing.

---

## Symptom: Agent timeout

**Step 1:** Check the trace for where time is being spent:

```bash
agentcore traces get <traceId> --runtime <AgentName>
```

Look for long-running steps — model calls, tool calls, memory operations.

**Step 2:** Common timeout causes:

**Slow agent initialization:** If the first invocation after an idle period is slow but subsequent requests are fast, the agent is spending too much time initializing. Check for heavy imports at module level, database connections in global scope, or MCP client initialization during startup. Move expensive setup into the request handler or use lazy initialization. See the `agents-harden` skill for optimization guidance.

**Model call timeout:** The model is taking too long. Consider using a faster model for time-sensitive operations (e.g., Haiku instead of Sonnet for simple tasks).

**Tool call timeout:** The Lambda or external API is slow. Check the tool's own logs.

**Memory retrieval timeout:** Semantic search can be slow for large memory stores. Consider reducing `top_k` in your retrieval config.

**VPC connectivity issue:** If the agent is in a VPC, check security group rules and route tables. See `agents-build` (loads [`references/vpc.md`](../agents-build/references/vpc.md)) for VPC-specific debugging.

---

## Symptom: `ServiceQuotaExceededException: maxVms limit exceeded` (despite low observed concurrency)

Your CloudWatch "concurrent sessions" metric shows modest numbers (maybe 30–50) but `InvokeAgentRuntime` calls return `ServiceQuotaExceededException: maxVms limit exceeded`.

**What's actually happening:** CloudWatch's concurrent-sessions metric is not the same as live microVM count. The `maxVms` quota counts all environments your account has active — including ones that finished their invocation but haven't been reclaimed yet. Idle-but-not-yet-reclaimed environments count against the quota until `idleRuntimeSessionTimeout` expires (default 900 seconds / 15 minutes) or you explicitly stop them.

If your code uses a new session ID per request and doesn't call `StopRuntimeSession`, every request leaves an environment sitting idle for 15 minutes counting against the quota.

**Fix order (try in this order before requesting a quota increase):**

1. **Call `StopRuntimeSession` after each logical request completes.** If you're not going to send more requests on this session, stop it explicitly.

   ```python
   client.stop_runtime_session(
       agentRuntimeArn=runtime_arn,
       runtimeSessionId=session_id,
   )
   ```

2. **Reuse session IDs across related requests.** If a user interaction produces multiple backend calls, route them to the same session instead of generating a new session ID per call.

3. **Lower `idleRuntimeSessionTimeout`.** If your sessions are short-lived and you can't add `StopRuntimeSession` everywhere, lower the timeout by editing the runtime's `lifecycleConfiguration` in `agentcore/agentcore.json` and running `agentcore deploy`.

4. **Only after the above, request a quota increase.** See `agents-harden` (loads [`references/limits.md`](../agents-harden/references/limits.md)) — request it through the Service Quotas console (Amazon Bedrock AgentCore), not by filing a support ticket directly.

See `agents-harden` Session lifecycle management section for the full pattern.

---

## Symptom: 424 Failed Dependency on invoke

This usually means the agent container failed to start or crashed during initialization.

**Step 1:** Check the agent logs for startup errors:

```bash
agentcore logs --runtime <AgentName> --since 30m --level error
```

**Step 2:** Common causes:

**Missing Python dependency:** The agent code imports a package not in `pyproject.toml`. The container starts but crashes on first request. Fix: add the dependency and redeploy.

**Entrypoint crash:** The `main.py` throws an exception during import or `app.run()`. Check logs for the traceback.

**Container image pull failure:** If using Container build, the ECR image may not exist or the execution role lacks `ecr:BatchGetImage`. Check:

```bash
agentcore status --runtime <AgentName> --json
```

**Memory resource not ACTIVE:** If the agent code assumes memory is available but the memory resource is still in CREATING state, the entrypoint may fail. Check:

```bash
agentcore status --type memory
```

**Initialization timeout:** The agent takes too long to be ready for its first request — heavy imports at module level, synchronous database connections, or MCP client initialization during startup can exceed the service's health-check window. The symptom looks like a 424 on the first invoke but healthy on subsequent ones. Fix: move expensive setup out of module level, use lazy initialization, or warm the agent before production traffic. See `agents-harden` Initialization time section for patterns.

---

## Symptom: Local invocations fail with connection-refused / exit code 7

Usually not an agent bug — the dev server is on a different port than you expect.

**Default ports `agentcore dev` binds:**

| Protocol | Default |
| -------- | ------- |
| HTTP     | 8080    |
| MCP      | 8000    |
| A2A      | 9000    |

**When the default is occupied** (second dev session, a lingering process from a previous run, another service on 8080), the CLI **auto-increments** silently: 8080 → 8081 → 8082. A test harness or `curl` script hardcoded to 8080 will get `Connection refused` (curl exit code 7) while the agent is running fine on 8082.

Diagnose in this order:

1. Read the CLI banner that `agentcore dev` prints — it shows the actual bound port and URL. This is always the source of truth.
2. If the banner is gone (terminal cleared, running in background), check the log file:

   ```bash
   tail -20 agentcore/.cli/logs/dev/*.log
   ```

3. Or find the process directly:

   ```bash
   # macOS / Linux
   ps aux | grep -E 'agentcore dev|uvicorn' | grep -v grep
   lsof -iTCP -sTCP:LISTEN -n -P | grep -E '8080|8081|8082|8000|9000'
   ```

**Fix options:**

- Pin the port explicitly: `agentcore dev --port 8080`
- Kill the process squatting on the default: `lsof -tiTCP:8080 -sTCP:LISTEN | xargs kill`
- Update the hardcoded port in your test harness to read from the CLI output or from an env var

This is also a common source of "works locally one day, fails the next" reports — the port shifted between runs.

---

## Symptom: Gateway tool calls failing with auth errors

**Step 1:** Verify the auth type matches the target type. This is the most common gateway error — using the wrong outbound auth for the target:

| Target type           | Valid outbound auth                     |
| --------------------- | --------------------------------------- |
| `mcp-server`          | `none`, `oauth`, or IAM (SigV4 via API) |
| `lambda-function-arn` | IAM only (automatic)                    |
| `open-api-schema`     | `oauth` or `api-key` (required)         |
| `api-gateway`         | `none`, `api-key`, or IAM               |
| `smithy-model`        | IAM or `oauth`                          |

**Step 2:** Check for expired OAuth tokens. If the gateway target uses OAuth, the access token may have expired. Look for auth-related errors:

```bash
agentcore logs --runtime <AgentName> --since 1h --query "auth"
agentcore logs --runtime <AgentName> --since 1h --query "401"
agentcore logs --runtime <AgentName> --since 1h --query "403"
```

If tokens are expiring, verify the OAuth credential provider's token endpoint is reachable and the client credentials are still valid. For MCP server targets with OAuth, the gateway handles token refresh automatically — if it's failing, the credential provider config may be wrong.

**Step 3:** Check the credential is configured:

```bash
agentcore status --type credential
agentcore status --type gateway --json
```

---

## Symptom: No traces appearing

**Wait ~15 seconds** — there's a short delay (typically ~10s) between invocation and trace availability.

If still no traces after ~30 seconds:

1. Verify observability was enabled when the agent was deployed
2. Check the agent was actually invoked: `agentcore logs --runtime <AgentName> --since 1h`
3. Check CloudWatch permissions on the execution role

---

## Symptom: CloudWatch logs not appearing

This is the most common observability issue, especially for Container/Docker builds.

AgentCore doesn't capture raw stdout. It uses OpenTelemetry to ship logs to CloudWatch. Three things must be true:

**1. Your entrypoint must be wrapped with `opentelemetry-instrument`.**

CodeZip builds do this automatically. Docker/Container builds need it added manually — this is the #1 thing people miss.

In your Dockerfile CMD:

```dockerfile
# ✅ Correct — wrapped with opentelemetry-instrument
CMD ["opentelemetry-instrument", "python", "main.py"]

# ❌ Wrong — no OTEL wrapper, logs won't appear
CMD ["python", "main.py"]
```

**2. Your runtime IAM role needs CloudWatch and X-Ray permissions:**

```
logs:CreateLogGroup
logs:CreateLogStream
logs:PutLogEvents    → scoped to /aws/bedrock-agentcore/runtimes/*
xray:PutTelemetryRecords
xray:PutTraceSegments → scoped to *
```

If using the AgentCore CLI with CodeZip, the CDK scaffold adds these automatically. If using a custom role or Container build, verify they're present.

**3. Use Python's `logging` module, not `print()`.**

OTEL hooks into `logging` automatically — no custom handlers needed. `print()` statements won't appear in CloudWatch.

```python
import logging
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# ✅ This appears in CloudWatch
logger.info("Processing request")

# ❌ This does NOT appear in CloudWatch
print("Processing request")
```

**Also verify:** CloudWatch Transaction Search is enabled in your account. Without it, traces and spans won't appear in the GenAI Observability dashboard.

### Logs missing for Terraform/CDK/IaC-deployed runtimes

A common pattern: a runtime deployed via Terraform, CDK, or a custom IAM role works correctly (returns responses) but no CloudWatch log streams appear — while the same agent code deployed via the AgentCore Console logs fine.

This is almost always an IAM scoping issue. The execution role for a runtime deployed via the Console gets broad CloudWatch permissions by default. IaC templates often scope those permissions narrowly to `/aws/bedrock-agentcore/runtimes/*`, which breaks log stream creation.

**The fix:** `logs:DescribeLogGroups` must have `Resource: "*"`, not a scoped resource. The other logs actions can be scoped to the runtime's log group.

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:DescribeLogGroups"
  ],
  "Resource": "*"
},
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogGroup",
    "logs:CreateLogStream",
    "logs:PutLogEvents"
  ],
  "Resource": "arn:aws:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/bedrock-agentcore/runtimes/*:*"
}
```

After updating the execution role's IAM policy, redeploy the runtime with `agentcore deploy` to pick up the new permissions.

---

## Symptom: Streaming connection drops mid-response

Your agent uses SSE or long-polling responses and the connection drops mid-stream. Symptoms in client code:

- `RemoteProtocolError: peer closed connection without sending complete message body`
- `IncompleteRead` exception while iterating the stream
- Silent disconnect — no error, no `[DONE]` event, response just stops
- Happens during multi-tool-use conversations (5+ sequential tool calls)
- Fails well before any client-side timeout

**Root cause:** Infrastructure-layer idle timeout on streaming connections. If no data flows on the response stream for several minutes (a silent period while a tool executes, for example), a load balancer in front of the runtime terminates the TCP connection.

The timeout is on **data flowing through the stream**, not on the request total duration. As long as you emit bytes periodically, the connection stays open.

**Fix: emit keepalive events during long-running tool executions.**

Python pattern for a streaming entrypoint:

```python
import asyncio
import json
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

async def emit_keepalive(tool_task):
    """Yield heartbeat events every 30s while tool_task is running."""
    while not tool_task.done():
        yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        try:
            await asyncio.wait_for(asyncio.shield(tool_task), timeout=30)
        except asyncio.TimeoutError:
            continue  # tool still running, emit another heartbeat

@app.entrypoint
async def invoke(payload, context):
    async def stream():
        tool_task = asyncio.create_task(run_long_tool(payload))

        # Emit heartbeats while the tool runs
        async for event in emit_keepalive(tool_task):
            yield event

        # Tool completed — emit the real result
        result = await tool_task
        yield f"data: {json.dumps({'type': 'result', 'content': result})}\n\n"
        yield "data: [DONE]\n\n"

    return stream()
```

Pick a heartbeat interval of ~30 seconds. Too long risks hitting the idle timeout; too short wastes bandwidth.

**On the client side, filter heartbeat events** before surfacing bytes to the user:

```python
for chunk in response.iter_lines():
    if not chunk:
        continue
    data = json.loads(chunk.removeprefix(b"data: "))
    if data.get("type") == "heartbeat":
        continue  # ignore keepalives
    # process real events
```

**Alternative: use the SDK's async task API for fire-and-forget patterns.** If the client doesn't need to wait for the result, register the work via `add_async_task` / `complete_async_task` and return the invocation immediately. See `agents-harden` Long-running background tasks section.

---

## Symptom: Traces appear merged across concurrent agent invocations

You run multiple agent invocations in parallel with unique `runtimeSessionId` values, but the AI Observability dashboard groups them as one session — making it impossible to isolate a single run. Data plane logs show the session IDs are correctly unique 1:1 with request IDs, but the trace view still merges them.

**Most common cause: the caller isn't enabling Active Tracing**, so upstream spans arrive with `Sampled=0`. AgentCore respects upstream trace-sampling decisions by default. If the parent context says "don't sample," spans drop and concurrent invocations can appear merged in the dashboard.

**Fix by caller type:**

**Lambda caller:** Enable Active Tracing on the Lambda function.

```bash
aws lambda update-function-configuration \
  --function-name my-caller-function \
  --tracing-config Mode=Active
```

Or in the Lambda console: Configuration → Monitoring and operations tools → AWS X-Ray → Active tracing.

**ECS / EC2 / container caller:** Initialize the AWS X-Ray SDK and ensure outbound calls to AgentCore are instrumented. For Python, use `aws-xray-sdk` and patch the SDK:

```python
from aws_xray_sdk.core import xray_recorder, patch_all
patch_all()  # patches boto3, requests, etc.
```

**Direct SDK caller without X-Ray:** If you can't enable upstream tracing, force the runtime to sample by setting an environment variable on the agent:

```
OTEL_TRACES_SAMPLER=always_on
```

This makes the runtime sample every trace regardless of the parent context's sampling decision. Trade-off: higher tracing costs, but the traces are correct.

### Also check: invoking with the endpoint ARN instead of the agent ARN

If traces show only a single top-level `AgentCore.Runtime.Invoke` span with no child spans, check the ARN your caller is using. The invoke target should be the agent runtime ARN:

```
arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtime-name>
```

Not the endpoint ARN:

```
arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtime-name>/runtime-endpoint/DEFAULT
```

Invoking with the endpoint ARN can bypass the full trace instrumentation path. This is a subtle trap — both ARNs produce successful responses, but only the agent ARN produces complete traces.

---

## Symptom: Runtime stuck in DELETING for hours

You called `DeleteAgentRuntime`, got a successful response with `status: DELETING`, and the runtime has been stuck in that state for more than 30 minutes. Attempting to delete the default endpoint separately returns `ConflictException: Default endpoints are removed when you delete the agent.`

**What's happening:** The deletion workflow is stuck on the service side. Retrying `DeleteAgentRuntime` won't help — the call succeeds immediately (returning DELETING) but the back-end workflow is the thing that's stuck. Customer-side tooling can't force-complete it.

**What to do:**

1. **Do not keep retrying.** It won't unstick the workflow.
2. **Open an AWS Support case** at https://console.aws.amazon.com/support. Include:
   - AWS Account ID
   - Region
   - Runtime ARN (or `agentRuntimeId`)
   - The `requestId` and timestamp of the original `DeleteAgentRuntime` call (from CloudTrail)
   - How long the runtime has been in DELETING state
3. **Work around it in the meantime.** Deploy a new runtime with a different name if you need to keep shipping. Don't let the stuck resource block your work.

Orphaned resources from a stuck deletion (ENIs, workload identities) may need manual cleanup from the service team as part of the same case.

---

## Framework-specific issues

**LangGraph — model format:**
Older versions of `langchain-aws` required the model ID without the cross-region prefix. Recent versions may support cross-region inference profiles — check your installed version:

```bash
pip show langchain-aws | grep Version
```

If you hit model errors with LangGraph, try the non-prefixed ID:

```python
# If cross-region prefix errors in your langchain-aws version:
llm = init_chat_model("anthropic.claude-sonnet-4-5-20250929-v1:0", model_provider="bedrock_converse")

# If your version supports cross-region profiles (us. = US, eu. = Europe, apac. = Asia Pacific, global. = worldwide):
llm = init_chat_model("global.anthropic.claude-sonnet-4-5-20250929-v1:0", ...)
```

Verify against the current langchain-aws release notes: https://github.com/langchain-ai/langchain-aws/releases — cross-region inference profile support has been evolving.

**Google ADK — Gemini only:**
ADK only works with Gemini models. If you're seeing model errors with ADK, check that `GEMINI_API_KEY` is set and you're using a `gemini-*` model ID.

**A2A agents — wrong port:**
A2A servers must run on port 9000. If your A2A agent isn't responding, check it's not accidentally running on 8080.

---

## Reading a trace

A trace shows the full execution path of one agent invocation. Key sections:

- **Model invocations** — what the model was asked and what it responded
- **Tool calls** — which tools were called, with what inputs, and what they returned
- **Memory operations** — what was read from and written to memory
- **Policy decisions** — what was allowed or denied (if policy engine is attached)
- **Latency breakdown** — time spent in each component

```bash
# Download trace to a file for detailed inspection
agentcore traces get <traceId> --runtime <AgentName> --output trace.json
cat trace.json | jq '.trace.orchestrationTrace.modelInvocationOutput'
```

## Output

- Diagnosis of the specific failure with root cause
- Specific fix commands or code changes
- Explanation of what the trace shows (if reading traces)
- Handoff to the appropriate skill when the fix is outside debug's scope

## After diagnosis — handoff

Once you've identified the root cause, hand off to the skill that owns the fix:

| Root cause                                                                          | Hand off to                                         | Detail                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Memory misconfigured (wrong strategy, namespace, wiring)                            | `agents-build`                                      | Load [`references/memory.md`](../agents-build/references/memory.md)                               |
| Agent invocation from app not working (auth, URL, streaming)                        | `agents-build`                                      | Load [`references/integrate.md`](../agents-build/references/integrate.md)                         |
| VPC connectivity (can't reach RDS, no internet, AZ error)                           | `agents-build`                                      | Load [`references/vpc.md`](../agents-build/references/vpc.md)                                     |
| Multi-agent delegation not working                                                  | `agents-build`                                      | Load [`references/multi-agent.md`](../agents-build/references/multi-agent.md)                     |
| Custom request headers not reaching agent code                                      | `agents-build`                                      | Load [`references/request-headers.md`](../agents-build/references/request-headers.md)             |
| Cross-account invocation from an app in another account                             | `agents-build`                                      | Load [`references/integrate.md`](../agents-build/references/integrate.md) (cross-account section) |
| Gateway auth misconfigured (401, wrong auth type)                                   | `agents-connect`                                    | Gateway auth matrix                                                                               |
| Gateway target type question (Lambda vs OpenAPI vs MCP vs API Gateway)              | `agents-connect`                                    | "What Gateway is and isn't" section                                                               |
| Policy denying unexpectedly (Cedar, access denied on tool)                          | `agents-connect`                                    | Load [`references/policy.md`](../agents-connect/references/policy.md)                             |
| Observability not set up (no logs, no traces appearing)                             | `agents-optimize`                                   | Load [`references/observability.md`](../agents-optimize/references/observability.md)              |
| Cold start / initialization too slow                                                | `agents-harden`                                     | Initialization time section                                                                       |
| Session lifecycle / `maxVms` / `StopRuntimeSession`                                 | `agents-harden`                                     | Session lifecycle management section                                                              |
| Long-running background tasks being reclaimed                                       | `agents-harden`                                     | Long-running background tasks section                                                             |
| JWT inbound auth failing (403, `allowedClients`/`allowedAudience`, issuer mismatch) | `agents-harden`                                     | Inbound auth section                                                                              |
| Throttling / quota error / limit increase request                                   | `agents-harden`                                     | Load [`references/limits.md`](../agents-harden/references/limits.md)                              |
| Deploy artifact stale or wrong version                                              | `agents-deploy`                                     | Redeploy workflow                                                                                 |
| Environment broken (CLI, credentials, Node, uv)                                     | Load [`references/doctor.md`](references/doctor.md) | Self-contained in this skill                                                                      |

State the diagnosis clearly, then tell the developer which skill to use next. If the agent can load the referenced skill in the same session, do so.
