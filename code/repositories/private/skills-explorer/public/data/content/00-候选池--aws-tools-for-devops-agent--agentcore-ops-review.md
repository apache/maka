---
name: agentcore-ops-review
description: Comprehensive operational review procedures for Amazon Bedrock
  AgentCore resources aligned with the AWS Well-Architected Framework. Covers four
  check areas — Runtime Resilience, Gateway Health, Memory & Knowledge
  Effectiveness, and Resource Utilization & Operational Hygiene — plus runtime
  observability signals from CloudWatch. Use this skill when a user asks to review,
  audit, or assess Amazon Bedrock AgentCore workloads, perform an AgentCore
  operational readiness review, investigate agent runtime failures, audit
  memory/knowledge pipeline health, or review gateway resilience and resource
  hygiene. Triggers on requests like "AgentCore review", "AgentCore best practices
  audit", "review my AgentCore runtimes", "AgentCore health check", "audit my agent
  memory pipelines", or "ORR for AgentCore".
metadata:
  author: pamvas
  version: "1.0.1"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon Bedrock AgentCore"
  aws-devops-agent-skills.technical-domains: "Machine Learning, GenAI"
---

# Bedrock AgentCore Operational Review

Use this skill when performing an operational review of Amazon Bedrock AgentCore resources, investigating agent runtime failures, auditing memory/knowledge pipeline health, or reviewing gateway resilience and resource hygiene.

## Overview

This skill provides procedures for a review of AgentCore resources across four check areas mapped to the AWS Well-Architected Framework:

- **Runtime Resilience** (Reliability) — Failed/stuck runtimes and endpoints, single-AZ VPC placement, endpoint version drift, DEFAULT-endpoint-only deployments
- **Gateway Health** (Reliability) — Gateway status, target redundancy and health, policy engine attachment, target synchronization freshness
- **Memory & Knowledge Effectiveness** (Performance Efficiency) — Extraction pipeline errors, empty long-term memory, high ingestion error rate, provisioned-but-never-populated memories
- **Resource Utilization & Operational Hygiene** (Operational Excellence) — Idle resources, consolidation opportunities, low overall utilization
- **Runtime Observability** (cross-pillar) — Session counts, invocations, throttles, vCPU-hours, GB-hours per runtime

This is a **READ-ONLY** review. No modifications are made to any resource, and it never invokes an agent (`InvokeAgentRuntime`), reads no prompts or responses, and makes no other data-plane calls. **One exception:** for long-term memories the skill calls `bedrock-agentcore:ListMemoryRecords` (a data-plane API) solely to obtain a **record count**. That response can include a `content` field carrying extracted, potentially PII-bearing memory content; the skill uses **only the count** and never parses, logs, stores, or reproduces `content`. See "Memory record data handling" below.

## Data Source Boundaries (IMPORTANT — IAM footprint)

The standard `AIDevOpsAgentAccessPolicy` covers `bedrock:*` read actions but does **NOT** include the `bedrock-agentcore:*` namespace. (Note: `bedrock-agentcore-control` is the SDK client name, not an IAM prefix — all control-plane actions such as `ListAgentRuntimes`, `GetMemory`, and `ListGateways` authorize under the single service prefix `bedrock-agentcore:`.) Two modes:

1. **Runtime-observability-only mode** — relies exclusively on CloudWatch metrics (`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics`) against namespace `AWS/Bedrock-AgentCore`. Requires no `bedrock-agentcore:` additions. When an account isn't using AgentCore, the namespace is simply empty ("no activity detected") — this is not a failure.
2. **Full control-plane mode** — adds read-only `bedrock-agentcore:` control-plane List/Get actions and `ec2:DescribeSubnets` to enable the runtime/gateway/memory/utilization checks. It also uses one **data-plane** action, `bedrock-agentcore:ListMemoryRecords`, for the long-term-memory record count only (see "Memory record data handling" below). See `references/iam-policy-linked-account.json`.

If a required permission is missing, the affected check degrades to a **visibility limit** (reported as "signal unavailable / check skipped") rather than failing the review or producing a false finding.

**Memory record data handling:** `bedrock-agentcore:ListMemoryRecords` is a data-plane API whose `MemoryRecordSummary` entries include a required `content` field — the extracted facts/preferences/summaries a long-term memory has stored, which can contain end-user PII. This skill calls it **only** to count records for AC-MEM-2 and never reads, parses, logs, stores, transforms, or reproduces the `content` field. If you prefer zero data-plane access, omit this action from the IAM policy: AC-MEM-2 then degrades to a visibility limit while all other memory checks (which use CloudWatch ingestion metrics) continue to work.

**Seam with `agentcore-observability-setup`:** This skill assesses operational posture from _existing_ telemetry; it does not configure or validate observability wiring. Where telemetry is absent, this skill reports a visibility limit and defers the configuration gap to `agentcore-observability-setup` — that skill owns the observability-wiring finding (Transaction Search, OTEL/ADOT, log delivery, X-Ray resource policy), while this skill reports only the posture consequence. A customer running both should not see two overlapping findings on the same resource.

## Step 1: Discover Account and Regions

1. Call `sts:GetCallerIdentity` to determine the account.
2. Discover AgentCore-active regions:
   - Query Cost Explorer: `ce:GetDimensionValues` (dimension SERVICE, last 30 days), match "Amazon Bedrock AgentCore".
   - Then `ce:GetCostAndUsage` for that service grouped by REGION; select top regions by UnblendedCost.
   - If no AgentCore spend is found, fall back to probing `cloudwatch:ListMetrics` (namespace `AWS/Bedrock-AgentCore`) in the customer's primary regions to detect activity.
3. If no AgentCore activity is detected in any region, stop: "No AgentCore usage detected in the last 30 days."

## Step 2: Runtime Resilience Pillar (Reliability)

Discover runtimes and enrich each with endpoints and versions:

- `bedrock-agentcore:ListAgentRuntimes` → `GetAgentRuntime` (status, `failureReason`, `networkConfiguration`)
- `bedrock-agentcore:ListAgentRuntimeEndpoints` (status, `liveVersion`, `targetVersion`, name)
- `bedrock-agentcore:ListAgentRuntimeVersions` (to compute latest version + drift)
- `ec2:DescribeSubnets` (resolve VPC subnet IDs to AZs — endpoints carry NO AZ data)

| Check    | Rule                                                                                            | Severity     |
| -------- | ----------------------------------------------------------------------------------------------- | ------------ |
| AC-RUN-1 | Runtime/endpoint in `CREATE_FAILED`/`UPDATE_FAILED`, or stuck in `CREATING`/`UPDATING` > 1 hour | **Critical** |
| AC-RUN-2 | VPC-mode runtime whose subnets all resolve to a single AZ (PUBLIC mode exempt)                  | **High**     |
| AC-RUN-3 | Live endpoint ≥ 3 versions behind latest runtime version                                        | **Medium**   |
| AC-RUN-4 | Actively-updated runtime (2+ versions) served only by the auto-updating DEFAULT endpoint        | **Low**      |

**Key fact:** Endpoints are a versioning/traffic-routing construct, not a redundancy mechanism. AZ fault tolerance is derived exclusively from the runtime's VPC subnet configuration. If `ec2:DescribeSubnets` is unavailable, AC-RUN-2 degrades to "AZ distribution unknown".

## Step 3: Gateway Health (Reliability)

Discover gateways and their targets:

- `bedrock-agentcore:ListGateways` → `GetGateway` (status, protocolType, authorizerType, `policyEngineConfiguration`)
- `bedrock-agentcore:ListGatewayTargets` → `GetGatewayTarget` (status, `targetConfiguration`, `lastSynchronizedAt`, credential providers)

Target type derived from `targetConfiguration.mcp`: Lambda, MCP Server, API Gateway, OpenAPI Schema, Smithy Model.

| Risk Level   | Condition                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Critical** | Gateway not `READY`, zero targets, OR all targets unhealthy                                                |
| **Warning**  | Single target (no redundancy), no policy engine attached, some unhealthy targets, OR stale sync (> 7 days) |
| **Healthy**  | Multiple READY targets, policy engine attached, recent synchronization                                     |

Unhealthy target statuses: `FAILED`, `UPDATE_UNSUCCESSFUL`, `SYNCHRONIZE_UNSUCCESSFUL`. Stale sync threshold: `lastSynchronizedAt` older than 7 days.

## Step 4: Memory & Knowledge Effectiveness (Performance Efficiency)

Discover memories and their strategies, then query CloudWatch ingestion metrics:

- `bedrock-agentcore:ListMemories` → `GetMemory` (status, createdAt, **configured strategies**)
- `bedrock-agentcore:ListMemoryRecords` — **data-plane call, count only** (long-term-strategy memories). Read the returned record _count_; do not read the `content` field (see "Memory record data handling")
- `cloudwatch:GetMetricData` (namespace `AWS/Bedrock-AgentCore`): per-memory `Invocations`/`Errors` for the `Ingestion` operation, and `Invocations` for the `CreateEvent` operation (30-day window)

**All rules are strategy-aware** — read `GetMemory` strategies first. Record-count rules apply ONLY to memories with a long-term strategy; short-term-only memories are never flagged as empty.

| Check    | Rule                                                                                 | Severity        |
| -------- | ------------------------------------------------------------------------------------ | --------------- |
| AC-MEM-1 | Long-term memory with CloudWatch ingestion `Errors > 0`                              | **High**        |
| AC-MEM-2 | Long-term memory with < 10 records (escalates to High if 0 records AND > 7 days old) | **Medium→High** |
| AC-MEM-3 | Ingestion error rate > 20% (`Errors / Invocations`)                                  | **High**        |
| AC-MEM-4 | Provisioned but never populated: zero `CreateEvent` activity AND > 7 days old        | **Medium**      |

**Safety rule:** `CreateEvent` activity is queried for EVERY memory (short-term memories receive events too). When the CloudWatch signal is unreadable, event count is `None` (not 0), so AC-MEM-4 is skipped rather than firing a false "never populated" finding.

## Step 5: Resource Utilization & Operational Hygiene (Operational Excellence)

Enumerate all provisionable resource types and collect a 30-day activity signal:

- Inventory: `ListAgentRuntimes`, `ListMemories`, `ListGateways`, `ListBrowsers`, `ListCodeInterpreters`, `ListWorkloadIdentities`
- Activity: `cloudwatch:GetMetricData` (`Invocations`, `AWS/Bedrock-AgentCore`) keyed by per-type dimension (`AgentRuntimeId`, `MemoryId`, `GatewayId`)

| Check     | Rule                                                                                                                | Severity                 |
| --------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| AC-UTIL-1 | Idle resource: zero activity over 30-day window, > 7 days old                                                       | **Medium**               |
| AC-UTIL-2 | Consolidation: duplicate configs in a region, OR regions holding resources with < 5% of total activity (3+ regions) | **Informational→Medium** |
| AC-UTIL-3 | Overall utilization < 60% (active / assessable, excluding recently-created)                                         | **Informational**        |

For the AC-UTIL-1 idle signal, prefer the real-time `ActiveSessionCount` gauge (a currently-running-sessions gauge, filterable by the `Service` dimension) where available; fall back to the cumulative `SessionCount` / `Invocations` counters over the 30-day window when `ActiveSessionCount` is not present.

**Framing:** AgentCore runtime billing is consumption-based — idle time is free. Frame findings as operational hygiene and security surface (unmanaged IAM roles, stale config), NOT wasted spend. Exception: memories holding stored long-term records DO accrue storage cost — call this out in the finding.

**Classification safety:** A resource is only classified **Idle** when its activity signal is complete for the full window. Types with no queryable per-resource metric (Browser, CodeInterpreter, WorkloadIdentity), and every resource when the CloudWatch call fails, are classified **Active (partial)** — never Idle. Resources younger than 7 days are **RecentlyCreated** and excluded from both idle flagging and the utilization ratio.

## Step 6: Runtime Observability (cross-pillar signals)

For each runtime, collect CloudWatch metrics from namespace `AWS/Bedrock-AgentCore`:

| Metric             | Dimensions                                           | Period | Statistic |
| ------------------ | ---------------------------------------------------- | ------ | --------- |
| CPUUsed-vCPUHours  | Resource (ARN), Service=`AgentCore.Runtime`, Name    | 3600s  | Sum       |
| MemoryUsed-GBHours | Resource (ARN), Service=`AgentCore.Runtime`, Name    | 3600s  | Sum       |
| SessionCount       | Resource (ARN), Operation=`InvokeAgentRuntime`, Name | 300s   | Sum       |
| Invocations        | Resource (ARN), Operation=`InvokeAgentRuntime`, Name | 300s   | Sum       |
| Throttles          | Resource (ARN), Operation=`InvokeAgentRuntime`, Name | 300s   | Sum       |

`SessionCount` is a cumulative counter of new sessions per period. Where a real-time view is needed, `ActiveSessionCount` is a gauge of currently-running sessions (filterable by the `Service` dimension).

Discover resources first via `cloudwatch:ListMetrics` (namespace `AWS/Bedrock-AgentCore`), extract unique `Resource` ARN + `Name` dimensions, then batch `GetMetricData` per resource.

Derived signals:

- **Throttle rate** = `Throttles / Invocations × 100`
- **Health status** = "Throttling Detected" when `Throttles > 0`, else "Healthy"
- Only report runtimes with any activity (CPU-hours, GB-hours, invocations, or session count > 0).

## Step 7: Additional Context

1. **Health Events**: `health:DescribeEvents` filtered for Bedrock/AgentCore service, last 14 days.
2. **Documentation**: Cross-reference findings against AgentCore best-practices docs for remediation links.

## Step 8: Produce Report and Recommendations

Produce an artifact with the structure defined in `references/report-template.md`.

For each finding with severity Warning/Medium or higher, create a recommendation with:

- Title: `[Check ID] [Check name] — [Resource identifier]`
- Summary: Current state, expected state, business/operational impact, remediation steps, and a TAM conversation starter.

## Related Skills / Boundaries

Boundaries are deliberate and non-overlapping:

- **`agentcore-observability-setup`** — sets up/validates observability _wiring_. This skill consumes that telemetry for posture assessment and defers observability-_configuration_ gaps to it (see the seam described in Data Source Boundaries).
- **`agentcore-runtime-diag`** (queued submission — referenced for scope, not yet published) — reactive triage of a _single failing invocation_. This skill is proactive, estate-wide posture; it does not diagnose individual call failures or evaluate authorizer/credential correctness. Gateway checks here are redundancy/staleness/health only, not auth evaluation.
- **`aiml-access-diagnostics`** (published) — generic AI/ML AccessDenied chain via `iam:SimulatePrincipalPolicy`. Not overlapping — this skill makes no IAM-simulation calls.
- **`bedrock-adoption-readiness`** (published) — foundation-model workload readiness (IAM governance, ZDR, quotas, observability). Different resource surface — this skill reviews the AgentCore agent runtime / memory / gateway layer, not foundation-model inference.

## Error Handling

| Error                                 | Action                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AccessDenied on `bedrock-agentcore:*` | Log as visibility limit "signal unavailable — check skipped", continue in observability-only mode     |
| AccessDenied on `ec2:DescribeSubnets` | AC-RUN-2 degrades to "AZ distribution unknown"                                                        |
| CloudWatch returns no data            | Report "no activity detected" for that resource; classify utilization as Active (partial), never Idle |
| No AgentCore usage anywhere           | Stop early: "No AgentCore usage detected"                                                             |
| Throttled by AWS API                  | Retry with exponential backoff (3 attempts)                                                           |
| Check raises an exception             | Isolate the failure — degrade that check to a visibility limit and continue the others                |

## Important Notes

- ALL API calls with pagination (NextToken) MUST be paginated to completion.
- Cost Explorer queries run against us-east-1 (global endpoint).
- Findings are only produced when the underlying signal is complete — incomplete signals become visibility limits, never false positives.
- Batch CloudWatch `GetMetricData` requests where possible.
- This is a READ-ONLY review — no modifications, and no data-plane calls other than `ListMemoryRecords` for record count (count only; `content` is never read).
