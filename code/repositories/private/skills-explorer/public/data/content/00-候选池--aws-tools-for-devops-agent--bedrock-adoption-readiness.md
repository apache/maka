---
name: bedrock-adoption-readiness
description: >
  Amazon Bedrock production readiness assessment covering IAM governance, data retention
  (ZDR), quota and capacity headroom, and operational observability across Standard Bedrock
  and Mantle surfaces. Use this skill when a user asks to review Bedrock readiness, assess
  Bedrock security posture, evaluate quota headroom, check ZDR configuration, validate
  Bedrock operational setup, or prepare for Bedrock production deployment. Triggers on
  "Bedrock readiness review", "am I ready for Bedrock production", "Bedrock security
  assessment", "check my Bedrock quotas", "Bedrock adoption audit", "Bedrock operational
  review", or "assess my Bedrock environment".
metadata:
  version: "1.0.0"
  author: sruved
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon Bedrock"
  aws-devops-agent-skills.technical-domains: "AI/ML"
---

# Bedrock Adoption Readiness Assessment

Assess an AWS account's readiness to run Amazon Bedrock at production scale. Covers four dimensions: IAM governance, data retention (ZDR), quota and capacity headroom, and operational observability. Operates across both Standard Bedrock and Mantle (OpenAI models) surfaces.

## Important: Two Surfaces

Bedrock operates across two control planes. Both must be assessed.

|                        | Standard Bedrock                                                                | Mantle (OpenAI models)                                |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| CloudWatch namespace   | `AWS/Bedrock`                                                                   | `AWS/BedrockMantle`                                   |
| Metric names           | `Invocations`, `InputTokenCount`, `OutputTokenCount`                            | `Inferences`, `TotalInputTokens`, `TotalOutputTokens` |
| CW dimensions          | `ModelId`                                                                       | `Model`, `Project`                                    |
| IAM prefix             | `bedrock:`, `bedrock-runtime:`                                                  | `bedrock-mantle:`                                     |
| Cost discriminator     | No marker in USAGE_TYPE                                                         | `-mantle-` substring in USAGE_TYPE                    |
| Cross-region inference | Yes - Geographic (`us.`, `eu.`, `apac.` prefixes) and Global (`global.` prefix) | No (in-region only)                                   |

## When to Use

Activate this skill when the user asks to:

- Review or assess Bedrock production readiness
- Audit Bedrock IAM permissions or access governance
- Check Bedrock quota utilization or capacity planning
- Evaluate Zero Data Retention (ZDR) configuration
- Validate Bedrock operational monitoring setup
- Prepare for scaling Bedrock usage in production

## Dimension States

Every dimension reports one of three states:

- **ASSESSED**: Data collected, rules applied, findings produced
- **NOT_ASSESSED**: Collection failed or data unreachable (state the reason)
- **INSUFFICIENT_DATA**: Data returned but volume too low for meaningful analysis

A dimension producing zero findings after successful collection = GOOD. A dimension producing zero findings because collection failed = NOT_ASSESSED. These must render differently.

## Step 1: Identify Scope

Ask the user:

- Which AWS account to assess
- Which regions to review (if unknown, discover by listing metrics in us-east-1, us-east-2, us-west-2)
- Whether they have specific concerns or want a full assessment

## Step 2: Discover Active Regions and Models

For each candidate region, check both namespaces:

- List metrics in `AWS/Bedrock` namespace
- List metrics in `AWS/BedrockMantle` namespace

Any region returning metrics on either namespace is in scope. Record which ModelId/Model values appear - these identify active models for D2, D3, and later dimensions.

## Step 3: Collect Data

### 3.1 Standard Bedrock Metrics (7 days, per active region)

Query without dimensions for aggregates:

- `Invocations` (Sum)
- `InvocationThrottles` (Sum)
- `InvocationLatency` (Average)
- `InputTokenCount` (Sum)
- `OutputTokenCount` (Sum)
- `CacheReadInputTokenCount` (Sum) - NOTE: correct metric name, NOT `CacheReadInputTokens`
- `CacheWriteInputTokenCount` (Sum)
- `InvocationServerErrors` (Sum)
- `InvocationClientErrors` (Sum)

Then query WITH `ModelId` dimension for per-model quota utilization:

- `EstimatedTPMQuotaUsage` (Maximum) per ModelId discovered in Step 2

### 3.2 Mantle Metrics (7 days, per active region)

Query at zero-dimension for aggregates:

- `Inferences` (Sum)
- `TotalInputTokens` (Sum)
- `TotalOutputTokens` (Sum)
- `InferenceClientErrors` (Sum)

Then per-Model for attribution (TotalInputTokens supports Model dimension):

- `TotalInputTokens` with `Model` dimension per model discovered in Step 2
- `TotalOutputTokens` with `Model` dimension

For non-GPT-5.x models that emit `BurnDownConsumed`, query with `(Model, Project)` pair.

### 3.3 Service Quotas

List all quotas under `serviceCode: bedrock`. Paginate fully (can be 1,001+).

Separate:

- Standard Bedrock quotas: names NOT prefixed with `[bedrock-mantle endpoint]`
- Mantle quotas: names prefixed with `[bedrock-mantle endpoint]`

### 3.4 IAM (full depth)

**Step A**: List all roles in the account.

**Step B**: For each role, get attached managed policies AND inline policies.

**Step C**: For inline policies, get the policy document directly.

**Step D**: For managed policies, get the policy version document using the DefaultVersionId.

Search all policy documents for: `bedrock:`, `bedrock-runtime:`, `bedrock-mantle:`, `bedrock-agentcore:`, and bare `*` in Action fields.

Note: CDK/CloudFormation execution roles with `*` are expected. Flag as INFO, not CRITICAL.

If policy documents cannot be retrieved (only metadata returned), mark D1 as NOT_ASSESSED: "IAM policy documents not retrieved."

### 3.5 Alarms and Observability

List all CloudWatch alarms in each active region. Identify which reference Bedrock metrics.

Check model invocation logging configuration. If the API returns empty response, logging is DISABLED.

Check CloudTrail event selectors for `bedrock-runtime.amazonaws.com` data events (management events alone do not capture model invocations).

### 3.6 Guardrails

List Bedrock guardrails. Zero guardrails on a production deployment using Standard Bedrock (`bedrock-runtime`) is a finding. Note: Guardrails are NOT available on the Mantle endpoint (`bedrock-mantle`). Do not flag missing guardrails for Mantle-only workloads.

### 3.7 VPC Endpoints

Check for VPC endpoints for all Bedrock services:

- `com.amazonaws.<region>.bedrock` (Control Plane)
- `com.amazonaws.<region>.bedrock-runtime` (Runtime)
- `com.amazonaws.<region>.bedrock-mantle` (Mantle/OpenAI)
- `com.amazonaws.<region>.bedrock-agent` (Agents Build-time)
- `com.amazonaws.<region>.bedrock-agent-runtime` (Agents Runtime)

Ref: https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html

### 3.8 SCPs (if accessible)

List service control policies at the organization level. If access denied (member account), mark SCP check as NOT_ASSESSED: "organization-level access required."

### 3.9 Data Retention (classic plane)

Attempt to read account-level data retention configuration via `GetAccountDataRetention`.

If the call succeeds, record the mode per region. If it fails (permission not in DA policy), use fallback: check if any Covered Model (Fable 5, Mythos 5) appears in the invoked ModelId list from Step 3.1. Covered Models cannot be invoked without provider data sharing being active - their presence in metrics IS retention evidence.

## Step 4: Analyze - Four Dimensions

### Dimension 1: IAM & Access Governance

Analyze policy documents from Step 3.4:

| Finding                                                     | Severity                                         |
| ----------------------------------------------------------- | ------------------------------------------------ |
| Bare `*` Action on non-deployment role                      | CRITICAL                                         |
| Any bedrock prefix with `*` resource on non-deployment role | HIGH                                             |
| No SCP referencing Bedrock (regulated customer)             | HIGH (or NOT_ASSESSED if org access unavailable) |
| Zero guardrails configured (Standard Bedrock workloads)     | HIGH                                             |
| No VPC endpoints for bedrock-runtime                        | MEDIUM                                           |
| Broad permissions on CDK/deployment roles                   | INFO                                             |

### Dimension 2: Retention & Zero Data Retention (ZDR)

Three retention regimes exist:

|                 | Claude (standard) | Claude Covered Models (Fable 5, Mythos 5) | OpenAI GPT-5.x                     |
| --------------- | ----------------- | ----------------------------------------- | ---------------------------------- |
| ZDR obtainable? | Yes, self-service | NO - mandatory 30-day retention           | Yes, must be granted               |
| Scope           | Set the mode      | Cannot be changed                         | Per account, per model, per region |

Assessment:

1. If `GetAccountDataRetention` succeeded, report the mode per region
2. If Covered Model detected in invocation metrics, flag: provider data sharing is active
3. If GPT-5.x models present in Mantle metrics, note: ZDR must be explicitly granted per account/model/region
4. Check SCP results for retention enforcement policies

| Finding                                                | Severity                                    |
| ------------------------------------------------------ | ------------------------------------------- |
| Covered Model invoked without documented awareness     | CRITICAL (regulated) / HIGH (general)       |
| GPT-5.x in use, ZDR status unknown                     | HIGH (regulated) / MEDIUM (general)         |
| No SCP enforcing retention policy (regulated customer) | HIGH                                        |
| Model invocation logging disabled                      | HIGH                                        |
| Retention state unreadable                             | UNRESOLVED - flag for customer confirmation |

### Dimension 3: Quota & Capacity Headroom

Compare PER-MODEL utilization against PER-MODEL quotas. Never compare an account aggregate against a per-model limit.

For Standard Bedrock:

- Use per-ModelId `EstimatedTPMQuotaUsage` from Step 3.1
- Compare each model's 7-day peak against its specific quota from Step 3.3
- Cache awareness: cache reads do NOT consume quota, cache writes DO

For Mantle GPT-5.x (where `BurnDownConsumed` does not emit):

- Compute utilization from per-Model `TotalInputTokens + TotalOutputTokens`
- Compare against `[bedrock-mantle endpoint]` quota for that model
- Note: output tokens burn at 5:1 rate for Claude Opus/Sonnet 4.5+ (real consumption = InputTokenCount + CacheWriteInputTokenCount + OutputTokenCount x 5)

| Finding                                                        | Severity |
| -------------------------------------------------------------- | -------- |
| Any model's peak utilization >90% of its quota                 | CRITICAL |
| Any `InvocationThrottles` > 0 in 7 days                        | HIGH     |
| Any model's peak >70% with growth trend                        | HIGH     |
| No CRIS enabled + >50% utilization (Standard only, N/A Mantle) | MEDIUM   |

Note: CRIS is detectable via inference profile prefixes in ModelId - `us.`, `eu.`, `apac.` (geographic) or `global.` (global). Absence of any prefix means single-region only.

If per-model quota data cannot be joined to metrics (naming mismatch), mark as INSUFFICIENT_DATA with available numbers shown.

### Dimension 6: Operational Observability

Check which monitoring is in place. Reference: CWR checklist `bedrock` v2.0 defines alarm checks with thresholds. Key checks:

- Throttle alarm (InvocationThrottles > 0)
- Server error alarm (InvocationServerErrors as % of Invocations)
- Client error alarm (InvocationClientErrors as % of Invocations)
- Quota utilization alarm (EstimatedTPMQuotaUsage approaching limit)
- Latency alarm (InvocationLatency p90 by model family)
- Cost alarm

Also check measured values against thresholds:

- If `InvocationServerErrors / Invocations > 1%` = active breach, HIGH
- If `InvocationClientErrors / Invocations > 5%` = active breach, HIGH

| Finding                                                | Severity |
| ------------------------------------------------------ | -------- |
| Measured metric actively breaching a threshold         | HIGH     |
| Zero Bedrock-related alarms configured                 | HIGH     |
| No throttle monitoring                                 | HIGH     |
| Model invocation logging disabled                      | HIGH     |
| CloudTrail data events not enabled for bedrock-runtime | MEDIUM   |
| Missing cost alarm                                     | MEDIUM   |

Note on metric names: The correct CloudWatch names are `InvocationThrottles` (not `ThrottledEvents`) and `EstimatedTPMQuotaUsage` (not `QuotaUtilization`). Some documentation uses alternate names that return zero datapoints.

## Step 5: Generate Report

Output format:

```
# Bedrock Adoption Readiness Assessment
Account: <account-id> | Regions: <list> | Date: <today>
Surfaces: Standard Bedrock [Y/N] | Mantle [Y/N]
7-Day Volume: <N> invocations | 30-Day Spend: $<amount>
Assessment: READY / READY WITH ACTIONS / NOT READY

## Dimension Status
- D1 IAM: [ASSESSED / NOT_ASSESSED: reason]
- D2 Retention: [ASSESSED / UNRESOLVED: needs confirmation]
- D3 Quota: [ASSESSED / INSUFFICIENT_DATA]
- D6 Observability: [ASSESSED]

## Findings
[Sorted by severity, then dimension]

| # | Finding | Severity | Dimension | Recommendation |
|---|---------|----------|-----------|----------------|

## Model Inventory
| Model | Surface | Region | 7-Day Invocations | TPM Peak | Quota | % Used |
|-------|---------|--------|-------------------|----------|-------|--------|

## Priority Actions
1. [Highest severity + remediation]
2. [Next]
3. [Next]

## Next Steps
- Immediate (CRITICAL)
- This week (HIGH)
- This month (MEDIUM)
```

Verdict thresholds:

- **READY**: 0 critical, <=2 high, 0 unresolved, 0 NOT_ASSESSED
- **READY WITH ACTIONS**: 0 critical, (>2 high OR any unresolved OR any NOT_ASSESSED)
- **NOT READY**: Any critical finding

## Severity Definitions

| Severity | Definition                                                   | SLA                       |
| -------- | ------------------------------------------------------------ | ------------------------- |
| CRITICAL | Immediate risk to security, data exposure, or unbounded cost | Fix before production use |
| HIGH     | Significant gap that will cause issues at scale              | Fix within 1 week         |
| MEDIUM   | Notable improvement opportunity                              | Plan within 30 days       |
| LOW      | Minor optimization                                           | Address when convenient   |
| INFO     | Observation, no action required                              | N/A                       |

## References

- Bedrock Security: https://docs.aws.amazon.com/bedrock/latest/userguide/security.html
- Bedrock Quotas: https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html
- Cross-Region Inference: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
- Model Invocation Logging: https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
- Inference Profiles: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html
- Data Retention: https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html
- Enforce ZDR with SCPs: https://aws.amazon.com/blogs/security/enforce-zero-data-retention-on-amazon-bedrock-with-bedrock-projects-and-service-control-policies/
- CloudWatch Metrics TTFT & EstimatedTPMQuotaUsage: https://aws.amazon.com/blogs/machine-learning/improve-operational-visibility-for-inference-workloads-on-amazon-bedrock-with-new-cloudwatch-metrics-for-ttft-and-estimated-quota-consumption/
