---
name: bedrock-operation-review
description: Comprehensive Amazon Bedrock review aligned with the AWS
  Well-Architected Framework and Bedrock best practices. Use this skill when
  a user asks to review, audit, or assess Amazon Bedrock workloads for
  best-practices compliance, security posture, performance, cost optimization,
  service quotas, or resilience. Triggers on requests
  like "Bedrock review", "Bedrock best practices audit", "GenAI operational
  assessment", "review my Bedrock account", "Bedrock health check", "Bedrock cost
  optimization review", or "ORR for Bedrock".
metadata:
  author: smnixon
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon Bedrock"
  aws-devops-agent-skills.technical-domains: "Machine Learning, GenAI"
---

# Amazon Bedrock Operational Review

Conduct a comprehensive operational review of Amazon Bedrock workloads aligned with the
[AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
and [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html)
best practices.

This skill uses the **AWS Bedrock, Bedrock Agent, CloudWatch, Service Quotas, and
EC2 APIs only** — all data is collected through native AWS control-plane APIs and
CloudWatch metrics. It performs no data-plane model invocations and reads no prompt
or response content.

## When to Use

Activate this skill when the user asks to:

- Review, audit, or assess an Amazon Bedrock workload
- Check Bedrock best-practices compliance
- Evaluate Bedrock security, performance, cost, quotas, or resilience
- Perform a Bedrock operational readiness review (ORR)
- Investigate Bedrock configuration drift, throttling, or cost drivers

## Step 1: Identify Target Scope

Ask the user which accounts and regions to review. Accept:

- Specific account IDs and regions
- "all regions" for a given account
- A specific pillar or set of checks (e.g. "just cost optimization")

If no scope is given, default to all configured account regions and all pillars.
Default the analysis window to the last 7 days unless the user specifies a range
(historical windows older than ~2 weeks may have reduced CloudWatch resolution).

## Step 2: Discover Bedrock Resources

Per account/region, begin by checking whether the account actually uses Bedrock in
this region. **Do not use `bedrock.ListFoundationModels` as an activity signal** — it
returns the regional model catalog available to the account and is generally non-empty
in every supported region regardless of usage, so it is treated as catalog data only
(see [ListFoundationModels](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html)).

Instead, determine activity from **account-owned resources and `AWS/Bedrock` metrics**:

- Account-owned resources: `bedrockagent.ListAgents`, `bedrockagent.ListKnowledgeBases`,
  `bedrock.ListGuardrails`, `bedrock.ListCustomModels`,
  `bedrock.ListProvisionedModelThroughputs`, `bedrock.ListInferenceProfiles`
  (application-scoped), and `bedrock.ListModelCustomizationJobs`.
- Invocation activity: `cloudwatch.ListMetrics` for the `AWS/Bedrock` namespace.

**If no account-owned Bedrock resources exist AND CloudWatch shows no `AWS/Bedrock`
metrics for the region, record "No Bedrock activity detected — skipping pillar
analysis" for that region and move on. Do not generate empty findings tables for
inactive regions.**

For regions where Bedrock is active, collect the full resource inventory:

```
bedrock.ListFoundationModels                   # catalog reference only: model
                                               # availability + lifecycle status
                                               # (NOT an account-activity signal)
bedrock.ListGuardrails / GetGuardrail          # configured guardrails
bedrock.GetModelInvocationLoggingConfiguration
bedrock.ListInferenceProfiles / GetInferenceProfile
bedrock.ListPromptRouters / GetPromptRouter
bedrock.ListProvisionedModelThroughputs / GetProvisionedModelThroughput
bedrock.ListCustomModels / GetCustomModel
bedrock.ListModelCustomizationJobs / GetModelCustomizationJob
bedrockagent.ListAgents / GetAgent             # agents (draft version)
bedrockagent.ListAgentVersions / GetAgentVersion  # deployed versions — read only the
                                               # per-version model ID, orchestration
                                               # type, and whether a prompt override is
                                               # present. Do NOT read the override
                                               # base-prompt template text.
bedrockagent.ListAgentAliases
bedrockagent.ListKnowledgeBases / GetKnowledgeBase
bedrockagent.ListDataSources / GetDataSource
bedrockagent.ListPrompts                       # Prompt Management: presence/metadata
                                               # only (identifiers, versions, counts).
                                               # Do NOT call GetPrompt — it returns
                                               # prompt template/variant content, which
                                               # this skill does not read.
```

Capture per resource: identifiers, ARNs, status, creation/update timestamps,
encryption configuration (AWS-managed vs customer-managed KMS key), and any
VPC configuration.

## Step 3: Collect CloudWatch Metrics (namespace `AWS/Bedrock`)

**Before querying metrics, load the authoritative thresholds reference:**

```
read_skill_resource(skill_id="bedrock-operation-review", path="references/metrics-thresholds.md")
```

Use the thresholds from that file when classifying metric values as Normal, Warning,
or Critical throughout this step and Step 4.

Discover which models are actually invoked with `cloudwatch.ListMetrics`
(dimension `ModelId`), then pull metric data with `cloudwatch.GetMetricData`.
Use the user's selected window; default to 7 days.

Key model-level metrics (dimension `ModelId`):

| Metric                    | Stat         | Signal                              |
| ------------------------- | ------------ | ----------------------------------- |
| Invocations               | Sum          | Volume / denominator for rate calcs |
| InvocationThrottles       | Sum          | Throttling / quota pressure         |
| InvocationServerErrors    | Sum          | Server-side failures                |
| InvocationClientErrors    | Sum          | Bad input / blocked content         |
| InvocationLatency         | Average, p95 | End-to-end latency                  |
| TimeToFirstToken          | Average, p95 | Perceived latency (streaming)       |
| InputTokenCount           | Sum          | Input token volume                  |
| OutputTokenCount          | Sum          | Output token volume                 |
| InvocationsIntervened     | Sum          | Guardrail interventions             |
| TextUnitCount             | Sum          | Guardrail text-unit consumption     |
| CacheReadInputTokenCount  | Sum          | Prompt cache reads                  |
| CacheWriteInputTokenCount | Sum          | Prompt cache writes                 |

GPU metrics for self-managed workloads live in the `CWAgent` namespace
(`nvidia_smi_utilization_gpu`, `nvidia_smi_memory_util`).

`cloudwatch.GetMetricData` allows up to 500 metric-data queries per call — batch
requests and paginate when a region has many invoked models.

## Step 4: Analyze Against Best Practices

**Before evaluating findings, load the best-practices checklist:**

```
read_skill_resource(skill_id="bedrock-operation-review", path="references/best-practices-checklist.md")
```

Use the checklist as the canonical list of items to evaluate for each pillar. Mark
each item as ✅ Pass, ⚠️ Warning, ❌ Fail, or ➖ Not Applicable, and generate a
finding for every Fail or Warning.

Evaluate all collected data across the pillars below and assign a severity to every
finding: CRITICAL, HIGH, MEDIUM, LOW, or INFO. The pillars mirror the Bedrock
operational review structure: **Security, Performance, Service Quotas,
Cost Optimization, Resilience.**

### 4.1 Security

Ref: [Security in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/security.html)

- **Guardrails**: no guardrail configured on high-volume workloads → HIGH. Use
  guardrails to filter hate, insult, sexual, violence, and PII content and to block
  denied topics relevant to the use case.
  [Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
- **Guardrail signals**: high `InvocationClientErrors` (>5% of `Invocations`)
  indicates problematic content reaching models — filter before invocation → MEDIUM.
  `InvocationsIntervened` <5% of invocations on an active guardrail suggests
  under-configuration; >15% suggests policy over-tuning → review.
- **Model invocation logging**: for workloads handling sensitive content (PII, PCI,
  HIPAA), enabling invocation logging persists prompt/output on the account and may
  conflict with data-handling requirements. Flag logging configuration mismatches →
  MEDIUM.
  [Model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html)
- **Knowledge Base configuration**: chunking (200–1000 tokens), embedding strategy,
  encryption, access controls, and VPC endpoints → MEDIUM where missing.
  [Knowledge bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)
- **Knowledge Base data source encryption**: data sources without a customer-managed
  KMS key when handling sensitive content → MEDIUM.
  [Encryption of knowledge base resources](https://docs.aws.amazon.com/bedrock/latest/userguide/encryption-kb.html)
- **VPC configuration for model customization jobs**: customization jobs without a
  configured VPC expose training data to the internet → HIGH. (us-east-1, us-west-2)
  [Configure a VPC for Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/usingVPC.html)
- **IAM fine-grained access control**: agent/alias IAM policies using resource `*`
  without justification → MEDIUM. Follow least privilege for inference endpoints.
  A comprehensive least-privilege audit of all IAM policies is out of scope for this
  skill — flag obvious `*`-resource findings only, at INFO severity.
  [IAM for Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html)
- **Knowledge Base logging**: KB ingestion log delivery not configured → LOW.
  CloudTrail and CloudWatch not enabled for anomaly detection → MEDIUM.
- **Prompt injection**: this skill does not read prompt template content, so it does
  not assess whether individual templates are hardened. Instead, treat a guardrail
  configured with prompt-attack filtering as the control signal — workloads with no
  guardrail (or a guardrail lacking a prompt-attack content filter) are exposed to
  prompt injection → MEDIUM. Provide general hardening guidance by reference only.
  [Prompt engineering best practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/llm-prompt-engineering-best-practices/introduction.html)
- **Model access**: Amazon Bedrock foundation models are enabled by default (no
  explicit access request needed) — model access should instead be controlled via
  IAM and SCP policies scoped to the essential models for the use case (least
  privilege). A comprehensive least-privilege audit is out of scope for this skill —
  report gaps at INFO severity only.
  [Model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)

### 4.2 Performance

Ref: [Monitoring Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring.html)

- **Latency and throttling**: `InvocationLatency` p95, `TimeToFirstToken` p95,
  throttle rate (`InvocationThrottles / Invocations`), and server error rate. High
  throttle rate → HIGH (add retries with exponential backoff + jitter, request quota
  increase, spread load, use CRIS). Prefer smaller models and streaming for
  latency-sensitive apps.
  [Improve Bedrock performance](https://repost.aws/knowledge-center/bedrock-improve-performance-latency)
- **Agent performance**: agents can use a latency-optimized flow when they have a
  single knowledge base, no enabled action groups, don't ask follow-ups, and use the
  default orchestration template → flag agents that miss these conditions.
  [Optimize agent performance](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-optimize-performance.html)
- **Agent version configuration drift**: compare deployed alias versions (from
  `GetAgentVersion`) against the draft. Aliases pinned to outdated versions with
  different model IDs or orchestration types than the current draft → MEDIUM (may
  miss performance or capability improvements).
- **Invoked model versions**: models in Legacy or End-of-Life state still receiving
  invocations → MEDIUM (plan upgrade; check the model card for its EOL date rather
  than assuming a fixed notice period — Legacy notice periods are either 6 months or
  45 days depending on the model, with most models using 6 months).
  [Model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html)
- **Data automation**: success rate <95%, error rate >5%, or throttle rate >1% for
  production workloads → MEDIUM.
  [Bedrock Data Automation](https://docs.aws.amazon.com/bedrock/latest/userguide/bda.html)
- **Bedrock service tier**: verify tier selection (`default`, `flex`, `priority`,
  `reserved`) matches workload criticality. Latency-sensitive apps on Flex, or batch
  workloads on Priority, are misaligned → MEDIUM.
  [Service tiers](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html)

### 4.3 Service Quotas

Ref: [Bedrock quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html)

- **Model quotas**: compare observed P95 invocations-per-minute and tokens-per-minute
  against the account RPM/TPM quotas (including CRIS and Global CRIS quotas) from
  `servicequotas.GetServiceQuota`. Utilization >75% → MEDIUM (request increase before
  throttling); sustained near the limit → HIGH.
- **Guardrail service quotas**: track ApplyGuardrail requests and text-unit
  consumption for content filter, denied topic, sensitive information, word filter,
  and contextual grounding policies. Utilization >75% → MEDIUM. Note: CloudWatch
  metrics don't distinguish Classic vs Standard policy versions, so review manually
  when both are configured.
  [Guardrail quotas](https://docs.aws.amazon.com/general/latest/gr/bedrock.html#limits_bedrock)

### 4.4 Cost Optimization

Ref: [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)

- **Application inference profiles**: not used for cost allocation / tagging → LOW.
  App inference profiles integrate with Cost Allocation Tags for usage tracking.
  [Track cost and usage with inference profiles](https://aws.amazon.com/blogs/machine-learning/track-allocate-and-manage-your-generative-ai-cost-and-usage-with-amazon-bedrock/)
- **Custom model distillation**: narrow, repetitive, high-volume tasks on premium
  large models are distillation candidates. Rule of thumb: `InvocationLatency` p99
  > 3000 ms AND `InputTokenCount` >1M/month AND throttle rate >5% → high-priority
  > candidate → MEDIUM opportunity. (us-east-1, us-west-2)
  > [Model distillation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-distillation.html)
- **Prompt caching**: cache offload % =
  `CacheReadInputTokenCount / (CacheReadInputTokenCount + CacheWriteInputTokenCount)`.
  Statuses: Not Supported, Not Enabled, Misconfigured (writes but no reads),
  Underutilized (<50%), Optimized (≥50%). Input-heavy repeated context that isn't
  cached → MEDIUM opportunity (up to ~85% latency and ~90% cost reduction on cached
  prefixes).
  [Prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- **Prompt management**: presence indicates adoption maturity — INFO. Encourage
  versioning and variant testing for cost/quality tradeoffs.
  [Prompt management](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-management.html)
- **Intelligent prompt routing**: routes requests within a model family to the
  best-quality/lowest-cost model. Absence on mixed-complexity workloads → LOW
  opportunity.
  [Intelligent prompt routing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)
- **Provisioned throughput**: balance provisioned commitments against on-demand.
  Idle or expiring provisioned models, or steady baseline load on on-demand → MEDIUM.
  [Provisioned Throughput](https://docs.aws.amazon.com/bedrock/latest/userguide/prov-throughput.html)
- **Batch inference opportunity**: high-volume (>10K/day), latency-tolerant, or
  scheduled workloads on on-demand → MEDIUM (up to ~50% cost savings). Self-managed
  batch on EC2 GPU / SageMaker Batch Transform → migrate to managed Batch Inference.
  [Batch inference](https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference.html)
- **EC2 GPU utilization** (self-managed P4/P5/P5en/P6, requires CloudWatch Agent +
  NVIDIA DCGM plugin, 7-day minimum window):
  - Avg GPU util <40% → over-provisioned → migrate training to Trainium2 (~30–50%).
  - Avg GPU memory util >90% → OOM risk → model parallelism / larger instance.
  - GPU usage CV (StdDev/Mean) >0.5 → bursty → Spot Instances / Capacity Blocks.
  - Avg GPU util >80% sustained → commitment candidate → ML Savings Plans / RIs.

### 4.5 Resilience

Ref: [Cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)

- **Cross-Region Inference (CRIS)**: CRIS adoption % =
  `Profile InputTokenCount / (Profile InputTokenCount + Base Model InputTokenCount)`.
  Low adoption (traffic bypassing the inference profile by invoking base models
  directly) reduces burst resilience and, for global profiles, forgoes ~10% savings →
  MEDIUM.

## Step 5: Generate Report

Generate a shareable report artifact for the review.

Artifact naming: `bedrock-review-<account-id>-<region>-<YYYY-MM-DD>.md`
Example: `bedrock-review-123456789012-us-east-1-2026-04-29.md`

Structure the Markdown document with:

### Report Header

```
# Amazon Bedrock Operational Review — <account-id> / <region>
Date: <YYYY-MM-DD> | Analysis window: <start> to <end>
Pillars reviewed: <list>
```

### Executive Summary

- Health: ✅ HEALTHY / ⚠️ WARNINGS / ❌ CRITICAL
- Finding counts by severity
- Top 3 critical/high items

### Findings by Pillar

For each of Security, Performance, Service Quotas, Cost Optimization,
Resilience:

| # | Finding | Severity | Current State | Recommendation |

### CloudWatch Metrics Summary

| Metric | Model | Stat | Value | Status | Finding |

### Service Quota Utilization

| Quota | Value | Observed P95 | Utilization % | Risk |

### Cost Optimization Opportunities

| Opportunity | Signal | Est. Impact | Effort |

### Priority Matrix

| # | Finding | Severity | Pillar | Effort | Impact |

### Next Steps

- Immediate (CRITICAL/HIGH — 7 days)
- Short-term (MEDIUM — 30 days)
- Long-term (LOW — 90 days)

### Appendix — Reference Links

- [Amazon Bedrock User Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html)
- [Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
- [Monitoring Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring.html)
- [Bedrock Quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html)
- [Prompt Caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
- [Model Distillation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-distillation.html)
- [Batch Inference](https://docs.aws.amazon.com/bedrock/latest/userguide/batch-inference.html)
- [Cross-Region Inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)

## Severity Definitions

| Severity | Definition                                                  | SLA                     |
| -------- | ----------------------------------------------------------- | ----------------------- |
| CRITICAL | Immediate risk to availability, security, or data integrity | Fix within 24–48 hours  |
| HIGH     | Significant gap that could lead to incidents                | Fix within 1 week       |
| MEDIUM   | Notable improvement opportunity                             | Plan within 30 days     |
| LOW      | Minor optimization or hardening                             | Address when convenient |
| INFO     | Observation, no action required                             | N/A                     |

## Region-Restricted Checks

Some checks only run in specific regions:

- **VPC Configuration for Model Customization Job**: us-east-1, us-west-2
- **Custom Model Distillation**: us-east-1, us-west-2
- **Application Inference Profiles**: us-east-1, us-east-2, us-west-2,
  ap-northeast-1, ap-northeast-2, ap-southeast-2, ap-south-1, eu-central-1,
  eu-west-1, eu-west-3, us-gov-east-1, us-gov-west-1

Skip a check silently in unsupported regions rather than reporting a failure.

## Known API Quirks

- CloudWatch metrics for guardrail Content Filter and Denied Topic policies do **not**
  distinguish Classic vs Standard policy versions — utilization can be inaccurate when
  both are configured. Review manually.
- `cloudwatch.GetMetricData` caps at 500 metric-data queries per call — batch and
  paginate for accounts with many invoked models.
- Some models are only invocable through Cross-Region Inference profiles and will show
  0 direct token usage (100% CRIS adoption by design).
- Prompt cache entries expire after ~5 minutes of inactivity; aggregate CloudWatch
  windows are directional, not per-session.
- EC2 GPU signals require the CloudWatch Agent with the NVIDIA DCGM plugin; without it,
  `nvidia_smi_*` metrics are absent and GPU signals can't be evaluated.

## Data Source Boundaries

This skill collects data exclusively through native AWS APIs
(`bedrock`, `bedrockagent`, `cloudwatch`, `servicequotas`, `ec2`). It does **not**:

- Invoke any foundation model (no data-plane calls).
- Read prompt or response content.
- Depend on any non-AWS tooling or internal scripts — the skill is self-contained on
  the DevOps Agent's primary cloud-source IAM role.
