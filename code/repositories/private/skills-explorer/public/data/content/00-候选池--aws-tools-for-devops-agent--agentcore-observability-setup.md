---
name: agentcore-observability-setup
description: Validates and bootstraps Amazon Bedrock AgentCore observability so customers can trace
  agent reasoning, detect silent failures, and measure performance before an outage. Use this skill
  when a user asks to check, validate, audit, verify, fix, or set up AgentCore observability,
  tracing, metrics, or logging - for example "is AgentCore observability configured correctly",
  "why can't I see traces for my agent", "my Bedrock agent has no spans in CloudWatch", "validate
  agent monitoring", "AgentCore observability readiness", or "set up OTEL for my agent". Covers
  AgentCore Runtime agents, Memory and Gateway resources, built-in tools, and agents hosted outside
  the runtime (Lambda, ECS, EKS, on-prem, multi-cloud). Verifies what is reachable via read-only
  CloudWatch, X-Ray, and AgentCore control-plane APIs, and prescribes exact remediation for gaps it
  cannot directly read such as code-level OTEL instrumentation.
metadata:
  author: vggargav
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon Bedrock AgentCore, Amazon CloudWatch, AWS X-Ray"
  aws-devops-agent-skills.technical-domains: "AI/ML, Observability"
---

# AgentCore Observability Setup & Validation

Validate and bootstrap observability for Amazon Bedrock AgentCore workloads, aligned with the
[AgentCore observability documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html).
Produce a readiness report that states, per check, what is **configured vs. what should be**, and
generate the exact remediation for every gap.

## Operating Principle

**Verify where reachable; prescribe everywhere else.** Every check is exactly one of:

- **VERIFY** — confirmable through a read-only API (log group exists, data arriving, spans flowing,
  Transaction Search enabled, tracing toggle, delivery configured).
- **PRESCRIBE** — cannot be read directly (code-level OTEL instrumentation in the agent's source).
  Validate the _effect_ (are spans arriving?) and emit the exact steps. Do **not** claim to read
  source code.

This skill is **read-only**. It validates and generates configuration/commands. The customer decides
whether to apply them. Never mutate IAM, resources, or configuration.

## When to Use

Activate when the user asks to:

- Check / validate / audit whether AgentCore observability is configured correctly
- Diagnose missing traces, spans, metrics, or logs for a Bedrock agent
- Set up or bootstrap observability (tracing, metrics, logging) for an agent
- Run an AgentCore observability readiness review
- Understand why agent telemetry isn't appearing in CloudWatch GenAI Observability

## Step 1: Detect Permission Tier

This skill degrades gracefully based on which read-only permissions the DevOps Agent role holds.
Detect the tier by attempting calls and noting failures; run the checks the tier allows and report
what to add to unlock the rest. **Never** attempt to modify IAM.

| Tier                              | Permissions                                                                                                                                                                                                                                    | Unlocks                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **1 — Standard** (default DA IAM) | `logs:DescribeLogGroups`, `logs:FilterLogEvents`, `logs:GetLogEvents`, `logs:StartQuery`, `logs:GetQueryResults`, `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`, `cloudwatch:DescribeAlarms`                                            | Telemetry-arrival verification for any host                                                   |
| **2 — Runtime config**            | `bedrock-agentcore:GetAgentRuntime`, `bedrock-agentcore:ListAgentRuntimes`, `xray:GetTraceSegmentDestination`, `logs:DescribeDeliveries`, `logs:DescribeDeliverySources`, `logs:DescribeDeliveryDestinations`, `logs:DescribeResourcePolicies` | Runtime tracing/env, Transaction Search state, Memory/Gateway delivery, X-Ray resource policy |
| **3 — Non-runtime host**          | `lambda:GetFunctionConfiguration`; `ecs:DescribeTaskDefinition`, `ecs:DescribeServices`, `ecs:ListTasks`; `eks:DescribeCluster`                                                                                                                | Host-side config verification for Lambda / ECS / EKS                                          |

If Tier 2/3 permissions are absent, tell the user the check is **prescriptive-only** here and give the
exact scoped inline policy to attach to the DevOps Agent role (see `references/iam-tiers.md`) so a
re-run can verify it. The shared managed policy is cross-tenant and must not be modified per-skill.

## Step 2: Determine Scope (Host & Surface)

**Host detection:**

- **Runtime** — auto-detect with `bedrock-agentcore:GetAgentRuntime` / `bedrock-agentcore:ListAgentRuntimes` (Tier 2). If absent, ask the user.
- **Non-runtime** — the agent cannot reliably auto-detect the host. Ask: _"Is the agent on Lambda, ECS, EKS, or on-prem/another cloud?"_

**Surfaces to assess** (ask which apply, or discover via Tier 2 `List*`):
Runtime agents · Memory resources · Gateway resources · Built-in tools (code interpreter, browser) · non-runtime host.

**Outcome matrix:**

| Host / Surface        | Expected outcome                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Runtime agent         | Verify (Tier 1+2) + Prescribe                                                                        |
| Memory resource       | Verify delivery + tracing (Tier 2) + Prescribe                                                       |
| Gateway resource      | Verify delivery + tracing (Tier 2) + Prescribe                                                       |
| Built-in tools        | Prescribe; verify telemetry-arrival where present                                                    |
| Lambda                | Verify host config (Tier 3) + Prescribe                                                              |
| ECS                   | Verify host config (Tier 3) + Prescribe                                                              |
| EKS                   | Verify telemetry arrival (Tier 1) + Prescribe config (pod env is K8s-RBAC-gated, not IAM-verifiable) |
| On-prem / multi-cloud | Prescribe only                                                                                       |

## Step 3: Run Checks

Assign each finding a severity (CRITICAL / HIGH / MEDIUM / LOW / INFO) and a type (VERIFY / PRESCRIBE).
The complete check catalog with APIs, log-group patterns, and pass/fail logic is in
`references/checks-catalog.md`. Summary below.

### 3.1 Account prerequisite — CloudWatch Transaction Search (all hosts)

- **VERIFY (Tier 2):** `xray:GetTraceSegmentDestination` → destination must be `CloudWatchLogs` and status `ACTIVE`. If `XRay`/inactive, Transaction Search is **not** enabled → **CRITICAL** (spans will not be delivered to CloudWatch Logs; this is the single most common silent root cause).
- **VERIFY (Tier 1 fallback):** if the destination API is unavailable, infer from whether span log streams are receiving data (below). Report as inferred, not confirmed.
- **PRESCRIBE:** enable Transaction Search and ingest spans as structured logs (see `references/remediation-runtime.md`).

### 3.2 Runtime agent path (start here — primary surface)

1. **Agent log group exists (VERIFY, Tier 1):** `logs:DescribeLogGroups` prefix `/aws/bedrock-agentcore/runtimes/`. Missing → HIGH.
2. **Logs arriving (VERIFY, Tier 1):** `logs:FilterLogEvents` on the runtime log stream in the last 24h. No recent events after invocations → HIGH.
3. **Spans flowing (VERIFY, Tier 1):** check the `spans` log stream in the agent's log group (unified destination) or the shared `aws/spans` log group. No spans despite invocations → CRITICAL (points to Transaction Search disabled or missing instrumentation).
4. **Session metrics emitting (VERIFY, Tier 1):** `cloudwatch:ListMetrics` namespace `bedrock-agentcore`. Absent → MEDIUM.
5. **Runtime tracing / span destination (VERIFY, Tier 2):** `bedrock-agentcore:GetAgentRuntime` → inspect env for `UNIFIED_TRACES_DESTINATION_ENABLED` and `DISABLE_ADOT_OBSERVABILITY`. Starting **2026-07-20**, newly created agents in supported AWS Regions default to the unified span destination (the agent's own log group) — `UNIFIED_TRACES_DESTINATION_ENABLED=false` is now the opt-out. Agents created before that date remain on shared `aws/spans` unless opted in. If ADOT observability disabled unintentionally → HIGH.
6. **X-Ray resource policy on log group (VERIFY, Tier 2):** `logs:DescribeResourcePolicies` — must allow `xray.amazonaws.com` to `logs:PutLogEvents` on the agent's log group. **Applies by default for agents created after 2026-07-20 in supported Regions**, since unified span destination is the new default (per the [AgentCore release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html)). Mark N/A only when the agent was created before 2026-07-20 and still delivers to shared `aws/spans`, or the customer has explicitly opted out via `UNIFIED_TRACES_DESTINATION_ENABLED=false`. Missing → HIGH.
7. **Code-level instrumentation (PRESCRIBE):** cannot read source. If spans are absent, prescribe: `aws-opentelemetry-distro>=0.10.0` (**≥0.18.0** for unified span destination) + `boto3` in `requirements.txt`; launch with `opentelemetry-instrument python main.py` (container `CMD ["opentelemetry-instrument","python","main.py"]`); framework tracing enabled (e.g. Strands tracer, `opentelemetry-instrumentation-langchain`); session id via `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`.

### 3.3 Memory & Gateway resources

- **VERIFY (Tier 2):** `logs:DescribeDeliveries` / `DescribeDeliverySources` / `DescribeDeliveryDestinations` for an `APPLICATION_LOGS` source on the resource ARN and a `TRACES`→XRAY delivery. Default log group `/aws/vendedlogs/bedrock-agentcore/{memory|gateway}/APPLICATION_LOGS/{resource-id}`. No delivery → HIGH (no logs), MEDIUM (no traces).
- **PRESCRIBE:** console log-delivery + tracing toggle, or the `put_delivery_source`/`put_delivery_destination`/`create_delivery` SDK sequence (see `references/remediation-memory-gateway.md`).

### 3.4 Built-in tools (code interpreter, browser)

- **PRESCRIBE-first:** no service logs by default. Prescribe custom log output + a log destination, and custom headers (`X-Amzn-Trace-Id`, `traceparent`) on the tool APIs.
- **VERIFY (Tier 1):** if the customer emits logs, confirm the target log group is receiving data.

### 3.5 Non-runtime hosts

- **Lambda (VERIFY, Tier 3):** `lambda:GetFunctionConfiguration` → OTEL Layer present and `AWS_LAMBDA_EXEC_WRAPPER=/opt/otel-instrument`; agent log group env vars set. Gaps → HIGH. Note: Lambda uses the **Layer**, not the `aws-opentelemetry-distro` package.
- **ECS (VERIFY, Tier 3):** `ecs:DescribeTaskDefinition` → container env carries the OTEL variable set (see 3.6). Gaps → HIGH.
- **EKS (VERIFY telemetry only, Tier 1):** confirm the agent log group is receiving data. Pod/ConfigMap env is governed by Kubernetes RBAC and is **not** verifiable via IAM — prescribe config and report the pod-env checks as prescriptive.
- **On-prem / multi-cloud (PRESCRIBE only):** outside DA reach. Emit the full setup.

### 3.6 Non-runtime OTEL environment (PRESCRIBE / verify where host config is readable)

Required variables (per docs): `AGENT_OBSERVABILITY_ENABLED=true`, `OTEL_PYTHON_DISTRO=aws_distro`,
`OTEL_PYTHON_CONFIGURATOR=aws_configurator`, `OTEL_RESOURCE_ATTRIBUTES` (service.name, aws.log.group.names,
cloud.resource_id), `OTEL_EXPORTER_OTLP_LOGS_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (optional
unified spans; needs ADOT ≥0.18.0 + X-Ray log-group resource policy), `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
`OTEL_TRACES_EXPORTER=otlp`. Full block with Lambda-specific vars in `references/remediation-non-runtime.md`.
ADOT **Collector is not supported** — use the ADOT SDK or the Lambda Layer only.

## Step 4: Generate the Readiness Report

Produce a shareable artifact named `agentcore-observability-review-<target>-<YYYY-MM-DD>.md`
(`<target>` = agent/runtime id or a user-supplied label).

Sections:

- **Header** — account, region, host, surfaces assessed, permission tier reached, date.
- **Executive summary** — ✅ READY / ⚠️ GAPS / ❌ NOT CONFIGURED; finding counts by severity; top 3 items.
- **Findings** — table: `# | Check | Type (VERIFY/PRESCRIBE) | Severity | Current state | Expected | Remediation`.
- **Remediation** — concrete, copy-pasteable config/commands per gap (link the relevant `references/` file).
- **Permissions to unlock more checks** — the exact scoped inline policy JSON for any tier not reached.
- **Limitations** — code-level instrumentation is prescriptive; EKS pod env not IAM-verifiable; on-prem/multi-cloud prescribe-only; read-only (customer applies changes).
- **Appendix** — reference links.

## Severity Definitions

| Severity | Definition                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Observability is broken — telemetry cannot flow (e.g. Transaction Search disabled, no spans despite invocations). |
| HIGH     | Significant gap — a required piece is missing (log group, delivery, resource policy, host env).                   |
| MEDIUM   | Notable gap — metrics/traces partially configured or best-practice not met.                                       |
| LOW      | Minor hardening or optimization.                                                                                  |
| INFO     | Observation, no action required.                                                                                  |

## Reference Files

- `references/checks-catalog.md` — full per-check catalog (API, logic, severity, VERIFY/PRESCRIBE).
- `references/iam-tiers.md` — the three read-only tiers + ready-to-attach scoped inline policy JSON.
- `references/remediation-runtime.md` — Transaction Search, runtime tracing, ADOT, X-Ray resource policy.
- `references/remediation-memory-gateway.md` — log delivery + tracing (console + SDK).
- `references/remediation-non-runtime.md` — Lambda / ECS / EKS / on-prem OTEL env and setup.

## Appendix — Reference Links

- AgentCore observability configuration: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html
- AgentCore generated observability data: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-service-provided.html
- CloudWatch GenAI Observability console: https://console.aws.amazon.com/cloudwatch/home#gen-ai-observability
- ADOT SDK: https://aws-otel.github.io/
- AWS Lambda Layer for OpenTelemetry: https://aws-otel.github.io/docs/getting-started/lambda
