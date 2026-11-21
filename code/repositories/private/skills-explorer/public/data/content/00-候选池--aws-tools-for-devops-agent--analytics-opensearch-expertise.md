---
name: analytics-opensearch-expertise
description: "Amazon OpenSearch Service domain health assessment. Performs read-only, API-driven checks against a customer's OpenSearch domain(s) covering cluster health, node/shard configuration, performance metrics, security posture, and cost optimization signals. Activate this skill for requests about OpenSearch or Elasticsearch domain health, cluster review, domain assessment, performance, security posture, or cost optimization. Given a domain ARN (or name + region), it produces a structured findings report with prioritized recommendations. All checks use read-only AWS control-plane APIs (es:Describe*, es:GetCompatibleVersions, es:DescribeReservedInstances, cloudwatch:GetMetricData) — no data-plane access required."
metadata:
  version: "2.6"
  author: genealpe
---

# OpenSearch Domain Health Assessment

## Overview

This skill performs a comprehensive, read-only health assessment of Amazon OpenSearch Service domains using AWS APIs available through the customer's local AWS profile. It produces a structured report with findings and actionable recommendations.

> **Scope:** CLI-agent compatible. No external packages, no IDE workspace, no human review gates.

## Trigger Keywords

`opensearch`, `opensearch health`, `domain health`, `cluster review`, `opensearch review`, `opensearch assessment`, `opensearch check`, `open search`, `opensearch performance`, `opensearch security`, `opensearch cost`

## Prerequisites

- AWS CLI profile configured with read-only access to the target account
- IAM permissions required:
  - `es:DescribeDomain`
  - `es:DescribeDomainHealth`
  - `es:GetCompatibleVersions`
  - `es:DescribeReservedInstances`
  - `es:ListDomainNames`
  - `cloudwatch:GetMetricData`

## Execution Flow

### Input

**Required:** Domain ARN (e.g., `arn:aws:es:us-west-2:123456789012:domain/my-domain`)

Parse the ARN to extract:

- **Region:** field 4 (e.g., `us-west-2`)
- **Account ID:** field 5 (e.g., `123456789012`)
- **Domain name:** after `domain/` in field 6

**Fallback / Target Resolution (apply these rules exactly — never silently substitute a target):**

1. **Exact match:** the ARN (or name + region) resolves via `DescribeDomain` → proceed with the assessment.
2. **No domain specified:** run `ListDomainNames` in the user's likely region(s) (cross-region scan if needed) and **present the discovered domains as options for the user to choose**. Do not pick one yourself unless exactly one domain exists in the entire account — state that you did so.
3. **Specified but NOT found:** search for candidates (`ListDomainNames` in the ARN's region, then other regions). Then **STOP and confirm — do NOT assess**:
   - Report clearly: "Domain {given} not found in {region}."
   - List the closest candidate(s) with their regions (e.g., name differs by a suffix, or same name in another region).
   - Ask the user to confirm which domain to assess. **Never run the assessment against a domain the user did not name without their explicit confirmation** — in accounts with similarly-named sibling domains (e.g., `prod-es-content` / `prod-es-users`), a silently substituted target produces a confident report about the wrong domain, which is worse than an error.
4. If the user provides only a domain name with no region, ask for the region (or apply rule 3's candidate search).

### Steps

```
1. Parse domain ARN → region, account, domain name
2. Resolve the target (Target Resolution rules above) — confirm with the user if not an exact match
3. Describe domain configuration (DescribeDomain)
4. Describe domain health (DescribeDomainHealth)
5. Pull CloudWatch metrics (last 24h)
6. Check upgrade eligibility (GetCompatibleVersions; ListVersions fallback)
7. Check reserved instance coverage (DescribeReservedInstances)
8. Analyze findings against thresholds
9. Load the Remediation Reference — read_skill_resource(skill_id='analytics-opensearch-expertise',
   path='references/remediation-reference.md') — MANDATORY before writing recommendations
10. Generate report with recommendations
```

## API Compatibility (DevOps Agent tooling)

The DevOps Agent AWS tool exposes the LEGACY Elasticsearch-compatible client. Call legacy
operation names FIRST; fall back to the modern names only if the legacy call fails:

| Purpose            | Try first (legacy)                          | Modern equivalent             |
| ------------------ | ------------------------------------------- | ----------------------------- |
| Domain config      | `describe_elasticsearch_domain`             | `describe_domain`             |
| Version catalog    | `list_elasticsearch_versions`               | `list_versions`               |
| Upgrade targets    | `get_compatible_elasticsearch_versions`     | `get_compatible_versions`     |
| Reserved instances | `describe_reserved_elasticsearch_instances` | `describe_reserved_instances` |

- IAM note: the execution role's managed policy grants `es:Describe*` and `es:List*` —
  Describe/List operations succeed under either naming; `Get*` actions (BOTH GetCompatible
  variants) are typically denied. This is exactly why the 1.4 ListVersions fallback exists.
- `DescribeDomainHealth` has NO legacy equivalent. If it fails, do NOT skip checks 2.2/2.3 —
  use CloudWatch instead: `Shards.active` (Maximum) = active shards, `Shards.unassigned`
  (Maximum) = unassigned, TotalShards ≈ active + unassigned; `ClusterStatus.green/yellow/red`
  for 1.1/3.7. Never report the checks as SKIPPED when this fallback is available.
- All CloudWatch metrics in this skill: namespace `AWS/ES`, dimensions `DomainName` and
  `ClientId` (the account ID).

## Checks & Decision Logic

### Category 1: Cluster Health & Configuration

#### 1.1 Cluster Status

- **API:** `DescribeDomainHealth`
- **Field:** `ClusterHealth` (green | yellow | red)
- **Logic:**
  - GREEN → ✅ All primary and replica shards assigned
  - YELLOW → ⚠️ All primaries assigned, some replicas unassigned
  - RED → 🔴 Some primary shards unassigned — data loss risk

#### 1.2 Node Count & AZ Balance

- **API:** `DescribeDomain` → `ClusterConfig`
- **Fields:** `InstanceCount`, `ZoneAwarenessEnabled`, `AvailabilityZoneCount`
- **Logic:**
  - If `ZoneAwarenessEnabled == true`:
    - `InstanceCount % AvailabilityZoneCount != 0` → ⚠️ "Data node count ({count}) is not a multiple of AZ count ({az_count}). This causes uneven shard distribution across AZs, reducing fault tolerance."
    - Recommendation: "Adjust data node count to a multiple of {az_count} (e.g., {nearest_multiple})."
  - If `ZoneAwarenessEnabled == false` and `InstanceCount > 1`:
    - ⚠️ "Multi-AZ is not enabled despite having {count} data nodes. Single-AZ deployment risks full cluster unavailability during AZ failure."

#### 1.3 Dedicated Master Configuration

- **API:** `DescribeDomain` → `ClusterConfig`
- **Fields:** `DedicatedMasterEnabled`, `DedicatedMasterType`, `DedicatedMasterCount`
- **Logic:**
  - `DedicatedMasterEnabled == false` AND `InstanceCount >= 3` → ⚠️ "No dedicated master nodes. Clusters with 3+ data nodes should use dedicated masters for stability."
  - `DedicatedMasterCount == 2` → ⚠️ "Even number of master nodes ({count}) risks split-brain. Use 3 dedicated master nodes."
  - `DedicatedMasterCount < 3` → ⚠️ "Fewer than 3 master nodes reduces fault tolerance."

#### 1.4 Engine Version & Upgrade Eligibility

- **API:** `GetCompatibleVersions` with `DomainName`
- **Fallback (use when `GetCompatibleVersions` returns AccessDeniedException — do NOT skip):**
  call `ListVersions` and derive upgrade candidates using these two rules:
  1. Direct upgrade candidates = versions in `ListVersions` with the SAME major version as the
     domain and a LATER minor version (e.g., a 2.11 domain → every later 2.x in the region).
  2. Next-major path = via the LATEST available minor of the current major (compute it from
     `ListVersions`; never hard-code a specific version number).
     Label fallback results as "derived upgrade candidates (ListVersions + documented upgrade-path
     rules)" and cite https://docs.aws.amazon.com/opensearch-service/latest/developerguide/version-migration.html
     for the reader. Only mark 1.4 SKIPPED if BOTH APIs are denied.
     **Note placement:** the fallback provenance note belongs INSIDE the 1.4 finding ONLY — do NOT
     surface it in the Executive Summary or any report-level note box, and do NOT name API errors
     (e.g., AccessDeniedException) anywhere in the report. Phrase it customer-friendly: "Upgrade
     candidates were derived from the available version listings and are not API-confirmed — verify
     eligible target versions in the console before planning an upgrade."
     Render candidates as a SET of direct single-hop targets (comma-separated) — NEVER as an arrow chain (NOT "2.13 → 2.15 → 2.19"): every listed same-major version is directly reachable in ONE hop. Any upgrade recommendation MUST propose a single hop to the latest same-major version (plus one more hop for a major jump). Do NOT invent sequential multi-hop plans or per-hop time estimates.
- **Logic:**
  - If compatible target versions exist → ℹ️ "Current version: {current}. Upgrades available: {targets}."
  - If current version is more than 2 releases behind the latest same-major version → ⚠️ "Consider upgrading for performance improvements and security patches."
  - **Counting rule (apply exactly):** "releases behind" = the COUNT of later same-major versions returned by `ListVersions`/`GetCompatibleVersions` (e.g., 2.11 with {2.13, 2.15, 2.17, 2.19} available = 4 releases behind) — NEVER the numeric delta between version numbers (2.19 − 2.11 is NOT "8 versions behind").

### Category 2: Storage & Shard Strategy

#### 2.1 EBS Configuration

- **API:** `DescribeDomain` → `EBSOptions`
- **Fields:** `VolumeType`, `VolumeSize`, `Iops`, `Throughput`
- **Logic:**
  - `VolumeType == "gp2"` → ⚠️ "Using gp2 volumes. gp3 offers better price/performance with configurable IOPS and throughput."
  - Report total cluster storage: `VolumeSize × InstanceCount`
- **API (throttle detection):** CloudWatch `IopsThrottle`, `ThroughputThrottle`, `ReadIOPSMicroBursting`, `WriteIOPSMicroBursting`, `ReadThroughputMicroBursting`, `WriteThroughputMicroBursting` (Maximum statistic, last 7 days)
- **Logic (throttle detection):**
  - `IopsThrottle` Max > 0 OR `ThroughputThrottle` Max > 0 in the window → ⚠️ "EBS IOPS/throughput throttling detected. Increase provisioned `Iops`/`Throughput` on gp3 via `UpdateDomainConfig`."
  - Throttle metrics 0 but any microbursting metric > 0 on multiple days → ℹ️ "Workload bursts above the provisioned EBS baseline; monitor — sustained growth will lead to throttling. Consider raising gp3 `Iops`/`Throughput`."
  - No datapoints (non-EBS domain, e.g. instance-store or OR remote-store instance families) → skip this sub-check silently; do NOT mark check 2.1 SKIPPED.

#### 2.2 Shard Count & Density

- **API:** `DescribeDomainHealth`
- **Fields:** `TotalShards`, `ActiveShards`
- **Compute:** `shards_per_node = TotalShards / InstanceCount`
- **Version-dependent limits (from `DescribeDomain` → `EngineVersion`):**
  - OpenSearch ≤ 2.15: Hard limit = **1,000 shards/node**
  - OpenSearch 2.17+: Hard limit = **1,000 shards per 16 GB of data node heap**
- **Heap estimation (MUST use the real instance type, not an assumed value):** estimate per-node JVM heap from the data node instance type: `heap_GiB ≈ min(32, instance_RAM_GiB / 2)` (e.g., t3.medium.search 4 GiB RAM → ~2 GiB heap; r6g.xlarge.search 32 GiB RAM → ~16 GiB heap).
  **Instance RAM reference (GiB):** t3.small=2 · t3.medium=4 · c6g.large=4 · m6g.large=8 ·
  c6g.xlarge=8 · r6g.large=16 · m6g.xlarge=16 · c6g.2xlarge=16 · r6g.xlarge=32 ·
  m6g.2xlarge=32 · r6g.2xlarge=64 (heap caps at 32 GiB). For unlisted types use the EC2
  equivalent's memory — never guess silently; name the assumed RAM in the report.
- **Best-practice threshold:** `bp_limit = 25 × heap_GiB` shards/node.
- **Logic (apply these exact thresholds — do not substitute your own; the verdict tier is determined ONLY by which line matches, never by judgment):**
  - `shards_per_node > hard_limit` → 🔴 "Exceeds hard shard limit for engine version {version}."
  - `shards_per_node > 4 × bp_limit` → 🔴 "Shard density ({shards_per_node}/node) is more than 4× the best-practice limit ({bp_limit}/node for ~{heap_GiB} GiB heap). Severe heap/GC and recovery risk." (This tier is 🔴, not ⚠️ — do not downgrade.)
  - `shards_per_node > bp_limit` → ⚠️ "Shard density ({shards_per_node}/node) exceeds best-practice threshold of 25 shards/GiB heap ({bp_limit}/node for ~{heap_GiB} GiB heap)."
  - `shards_per_node > 0.5 × bp_limit` → ℹ️ "Moderate shard density. Monitor JVM heap pressure."
  - `shards_per_node <= 0.5 × bp_limit` → ✅ PASS. (Verbatim: at or below half the best-practice limit the verdict is PASS, never ℹ️ — low density is not a finding.)

#### 2.3 Active Shards vs. Total Shards

- **API:** `DescribeDomainHealth`
- **Fields:** `ActiveShards`, `TotalShards`
- **Expected:** `ActiveShards == TotalShards` (all shards placed and serving)
- **Logic:**
  - `ActiveShards < TotalShards`:
    - Delta = `TotalShards - ActiveShards`
    - ⚠️ "{delta} shards are not active. Non-active shards may be:"
    - "• **Initializing** — being allocated after a node restart or scaling event (transient, typically resolves in minutes)"
    - "• **Relocating** — being moved during a rebalance operation (transient)"
    - "• **Unassigned** — cannot be placed on any node (persistent problem). Common causes: insufficient disk space, allocation filtering rules, AZ awareness constraints with unbalanced node counts, or max shards per node limit reached."
    - Recommendation: "Check `_cluster/allocation/explain` for unassigned shard root cause."

#### 2.4 Free Storage Space

- **API:** CloudWatch `FreeStorageSpace` (Minimum statistic, last 24h)
- **CRITICAL — the Minimum statistic is PER-NODE (the lowest single node's free MB), NOT a
  cluster-wide total. Compute free % against ONE node's volume, never the cluster total:**
  `free_pct = FreeStorageSpace_min_MB / (VolumeSize_GiB × 1024) × 100`
  (Dividing the per-node Minimum by `VolumeSize × InstanceCount` understates free space by a
  factor of InstanceCount — this is wrong. Cross-check: the Sum statistic ÷ (VolumeSize ×
  InstanceCount × 1024) should give approximately the same percentage.)
- **Note:** usable space per node is less than the raw volume size due to OS/service reserved
  overhead — an empty node typically shows ~72% free, not ~97%.
- **Logic (apply these exact thresholds verbatim):**
  - `free_pct < 10%` → 🔴 "Free storage below 10%. High watermark may trigger read-only mode."
  - `free_pct < 20%` → ⚠️ "Free storage below 20%. Approaching low watermark. Plan capacity increase."
  - `free_pct < 30%` → ℹ️ "Storage utilization above 70%. Monitor trend."
  - `free_pct >= 30%` → ✅ PASS.
  - If the metric returns NO datapoints (new domain, or configuration change in progress) →
    SKIPPED "FreeStorageSpace metric unavailable" — never silently omit the check.

### Category 3: Performance Metrics

> **Note on percentiles:** CloudWatch metrics for OpenSearch (`SearchLatency`, `IndexingLatency`) report aggregate values, not per-request percentiles. We use the **Maximum** statistic over 1-minute periods as a "worst-case" proxy. True p50/p99 latency requires OpenSearch slow-log analysis or UltraWarm query insights, which is outside the scope of API-only checks.

**Time range:** Last 24 hours, 1-minute period granularity.

#### 3.1 JVM Memory Pressure

- **Metric:** `JVMMemoryPressure`, Statistic: `Maximum` — **the verdict MUST be computed from the
  Maximum statistic. Never substitute Average (an idle cluster commonly shows Avg ~43% while Max
  sustains ~74% — these produce different verdicts). Report Average only as context.**
- **Logic:**
  - Max > 92% → 🔴 "JVM heap pressure critically high ({value}%). Cluster is at risk of circuit breaker trips and OOM. Consider scaling up instance type or reducing shard count."
  - Max > 80% → ⚠️ "JVM heap pressure elevated ({value}%). Approaching GC thrashing threshold."
  - Max > 70% → ℹ️ "JVM heap pressure moderate. Monitor trend."

#### 3.2 CPU Utilization

- **Metric:** `CPUUtilization`, Statistic: `Average` (sustained) and `Maximum` (spikes)
- **Logic:**
  - Avg > 80% sustained (>50% of datapoints) → ⚠️ "Sustained high CPU. Cluster may be undersized for current workload."
  - Max > 95% → ℹ️ "CPU spikes observed. Check for expensive queries or bulk indexing bursts."

#### 3.3 Search Latency

- **Metric:** `SearchLatency`, Statistic: `Maximum` (worst-case proxy)
- **Logic:**
  - Max > 500ms → ℹ️ "Worst-case search latency {value}ms — elevated spikes observed. Investigate slow queries if user-facing impact is reported."
  - Report average as baseline context.
  - **Informational only — search latency NEVER renders ⚠️ or 🔴.** The 500ms marker is a heuristic: AWS does not define a canonical latency threshold; acceptable latency is workload-dependent, so frame findings against the customer's own baseline.

#### 3.4 Indexing Latency

- **Metric:** `IndexingLatency`, Statistic: `Maximum` (worst-case proxy)
- **Logic:**
  - Max > 500ms → ℹ️ "Worst-case indexing latency {value}ms. Check merge pressure or refresh interval if ingestion throughput is impacted."
  - Report average as baseline context.
  - **Informational only — indexing latency NEVER renders ⚠️ or 🔴.** Heuristic marker; frame against the workload's own baseline.

#### 3.5 Search & Indexing Rate

- **Metrics:** `SearchRate` (Sum), `IndexingRate` (Sum)
- **Purpose:** Workload characterization — reported for context, no threshold alerts.
- **Output:** "Search rate: ~{avg_per_min} req/min. Indexing rate: ~{avg_per_min} docs/min."

#### 3.6 HTTP Errors

- **Metrics:** `4xx` (Sum), `5xx` (Sum)
- **Logic (the tier is determined ONLY by 5xx; 4xx volume never raises the tier):**
  - `5xx > 0` → ⚠️ "{count} server errors (5xx) in last 24h. Indicates cluster-side failures (overload, circuit breaker, shard failures)."
  - `5xx == 0` AND `4xx > 0` → ℹ️ "{count} client errors (4xx). May indicate malformed queries, auth issues, or unauthenticated probes against a public endpoint." (Verbatim: with zero 5xx this is ℹ️ regardless of 4xx volume — never ⚠️. Note spikes/patterns as context only.)
  - `5xx == 0` AND `4xx == 0` → ✅ PASS.

#### 3.7 Cluster Status History

- **Metrics:** `ClusterStatus.red` (Maximum), `ClusterStatus.yellow` (Maximum)
- **Logic:**
  - Any `red == 1` datapoints → 🔴 "Cluster entered RED status {count} times in last 24h."
  - Any `yellow == 1` datapoints (and currently not yellow) → ℹ️ "Cluster experienced YELLOW status {count} times in last 24h (now recovered)."
  - If the cluster is CURRENTLY yellow (1.1 is already ⚠️), still report the 24h yellow
    datapoint count here as history context — never omit 3.7.

### Category 4: Security & Access

> **SEVERITY OVERRIDE PROHIBITION (apply exactly):** The verdict tier for every check in this
> document comes ONLY from the Logic line that matches the observed values — NEVER from general
> security judgment. Several security checks below are deliberately rated ⚠️ (not 🔴) by owner
> decision: a single disabled control in isolation is a Warning; only the fully-compounded 4.4
> case is Critical. Rendering 4.1, 4.2, 4.3, 4.5, or 4.6 as 🔴/CRITICAL is a SPEC VIOLATION even
> if it feels more correct — if your judgment disagrees with a Logic line, the Logic line wins.
> You may add ONE sentence of context inside the finding; you may never change the verdict tier,
> the emoji, or the severity word. This applies to the matrix, the executive summary, section
> headings, and prose equally.

#### 4.1 Encryption at Rest

- **API:** `DescribeDomain` → `EncryptionAtRestOptions.Enabled`
- **Logic:**
  - `false` → ⚠️ "Encryption at rest is disabled. Data on disk is unencrypted — non-compliant with most regulatory frameworks." (⚠️ by owner decision — do NOT escalate to 🔴.)

#### 4.2 Node-to-Node Encryption

- **API:** `DescribeDomain` → `NodeToNodeEncryptionOptions.Enabled`
- **Logic:**
  - `false` → ⚠️ "Node-to-node encryption disabled. Inter-node traffic is unencrypted." (⚠️ by owner decision — do NOT escalate to 🔴.)

#### 4.3 HTTPS Enforcement

- **API:** `DescribeDomain` → `DomainEndpointOptions.EnforceHTTPS`
- **Logic:**
  - `false` → ⚠️ "HTTPS not enforced. Clients can connect over HTTP (plaintext)."
  - Check `TLSSecurityPolicy` — if not `Policy-Min-TLS-1-2-2019-07` or newer → ℹ️ "TLS policy allows older protocol versions."

#### 4.4 Network Exposure

- **API:** `DescribeDomain` → `VPCOptions`
- **Logic (deterministic compound-risk escalation — apply exactly):**
  - If `VPCOptions` is empty/null AND `EnforceHTTPS == false` AND `AdvancedSecurityOptions.Enabled == false` → 🔴 "Domain uses a public endpoint with BOTH transport and access controls disabled — fully compounded exposure. Migrate to VPC or close both gaps." (This is an AND — BOTH controls must be disabled. A single weak control does NOT escalate 4.4; it is already flagged ⚠️ by its own check: HTTPS by 4.3, FGAC by 4.6. The fully-compounded case is the ONLY security condition rated 🔴.)
  - If `VPCOptions` is empty/null (any other combination) → ⚠️ "Domain uses a public endpoint{; weak control: {name the single false one, if any}}. Consider VPC deployment for network isolation."
  - If VPC deployed → ✅ Report VPC ID, subnet IDs, security group IDs.

#### 4.5 Access Policy Analysis

- **API:** `DescribeDomain` → `AccessPolicies` (JSON string)
- **Logic:** Parse the resource-based policy:
  - Principal == `"*"` with no IP condition → ⚠️ "Access policy allows unauthenticated access from any IP."
  - Principal == `"*"` with IP condition → ℹ️ "Access restricted by IP/CIDR but no IAM authentication."
  - Specific AWS principals → ✅ Report principal list.

#### 4.6 Fine-Grained Access Control (FGAC)

- **API:** `DescribeDomain` → `AdvancedSecurityOptions`
- **Fields:** `Enabled`, `InternalUserDatabaseEnabled`
- **Logic:**
  - `Enabled == false` → ⚠️ "Fine-grained access control disabled. No index-level or document-level permissions." (⚠️ by owner decision — do NOT escalate to 🔴.)
  - `InternalUserDatabaseEnabled == true` → ℹ️ "Internal user database enabled. Consider SAML or IAM-based auth for production."

### Category 5: Cost Optimization Signals

#### 5.1 Instance Right-Sizing

- **Inputs:** Instance type (from config) + CPU avg + JVM pressure
- **Logic (BOTH conditions MUST hold — this is a conjunctive rule):**
  - CPU avg < 20% AND JVM pressure max < 50% → ℹ️ "Low utilization suggests potential over-provisioning. Consider downsizing instance type."
  - If JVM pressure ≥ 50%, do NOT emit this finding regardless of CPU — the heap is doing real work even if CPU is idle.
  - Both high → already flagged in performance section.

#### 5.2 Storage Tiering Opportunity

- **API:** `DescribeDomain` → `ClusterConfig.WarmEnabled`, `ColdStorageOptions.Enabled`
- **Logic:**
  - `WarmEnabled == false` → ℹ️ "UltraWarm not enabled. If you have infrequently accessed indices (e.g., >30 days old), UltraWarm can reduce cost by ~80% for those indices."
  - `ColdStorageEnabled == false` AND `WarmEnabled == true` → ℹ️ "Cold storage not enabled. For rarely accessed data, cold storage offers lowest-cost option."

#### 5.3 Reserved Instance Coverage

- **API:** `DescribeReservedInstances`
- **Logic:**
  - No active RIs → ℹ️ "No reserved instances. For steady-state workloads, RIs can save 30-50% vs. on-demand." (An EMPTY result is NOT an error — empty means no RIs.)
  - If the API returns AccessDenied → SKIPPED with the reason stated.
  - Compare RI instance type/count vs. current domain config → report coverage gap.

### Remediation Reference rule (apply exactly)

For EVERY finding rated 🔴, ⚠️, or ℹ️, the Prioritized Recommendations section MUST include that check's entry from `references/remediation-reference.md` (loaded in Execution Flow step 9 via read_skill_resource): copy the "Why it matters" line and "Resolve" steps verbatim (you may instantiate observed values, e.g. the actual master count), and include the "Dive deeper" link(s) EXACTLY as written. NEVER emit a documentation link that is not present in the Remediation Reference — do not construct, recall, or infer URLs from any other source. PASS/✅ checks get no remediation entry.

## Output Format

> **MANDATORY COVERAGE RULE:** The report MUST evaluate and account for EVERY check in this document (1.1–1.4, 2.1–2.4, 3.1–3.7, 4.1–4.6, 5.1–5.3 — 24 checks total). No check may be silently omitted.
> **ID FIDELITY:** matrix rows MUST use these exact IDs with these exact meanings — never renumber,
> split, merge, or invent checks: 1.1 Cluster Status · 1.2 Node Count & AZ Balance · 1.3 Dedicated
> Masters · 1.4 Engine Version · 2.1 EBS Configuration · 2.2 Shard Count & Density · 2.3 Active vs
> Total Shards · 2.4 Free Storage · 3.1 JVM Memory Pressure · 3.2 CPU Utilization · 3.3 Search
> Latency · 3.4 Indexing Latency · 3.5 Search & Indexing Rate · 3.6 HTTP Errors · 3.7 Cluster
> Status History · 4.1 Encryption at Rest · 4.2 Node-to-Node Encryption · 4.3 HTTPS Enforcement ·
> 4.4 Network Exposure · 4.5 Access Policy · 4.6 FGAC · 5.1 Instance Right-Sizing · 5.2 Storage
> Tiering · 5.3 Reserved Instances. (Splitting 1.1 into red/yellow/green rows, or using "1.4" for
> service-software patches, are documented failure modes — do not reproduce them.)
> **CATEGORY ROLL-UP:** each category's executive-summary status = the WORST finding in it:
> any 🔴 → Critical; else any ⚠️ → Warning; else all ✅/ℹ️ → Healthy. Never judgment-based. Apply the exact thresholds written in each check's Logic section verbatim — do not substitute your own thresholds or severity levels, and do not round a verdict up or down a tier based on judgment: the tier is determined solely by which Logic line matches. If a check cannot be evaluated (API error, no data), it MUST appear in the Check Coverage Matrix as SKIPPED with the reason. For every CloudWatch-based check (2.1 throttle sub-check, 2.4, 3.1–3.7, 5.1), the matrix's Observed Value column MUST name the statistic used (e.g., "Max=74.3% (Maximum stat)") — it must match the statistic named in that check's spec. Before finishing, count the matrix rows: if the count is not exactly 24, the report is incomplete — fix it before responding.

Structure the report as:

```markdown
# OpenSearch Domain Health Assessment

## Domain: {domain_name}

**Region:** {region} | **Engine:** {engine_version} | **Assessed:** {timestamp}

## Summary

| Category          | Status   | Findings           |
| ----------------- | -------- | ------------------ |
| Cluster Health    | 🟢/🟡/🔴 | {one-line summary} |
| Storage & Shards  | 🟢/🟡/🔴 | {one-line summary} |
| Performance       | 🟢/🟡/🔴 | {one-line summary} |
| Security          | 🟢/🟡/🔴 | {one-line summary} |
| Cost Optimization | 🟢/🟡/⚪ | {one-line summary} |

## Detailed Findings

### 🔴 Critical (act now)

{findings}

### ⚠️ Warnings (plan action)

{findings}

### ℹ️ Informational

{findings}

### ✅ Passing Checks

{list of checks that passed}

## Recommendations (prioritized)

1. {highest priority}
2. ...

## Raw Data Reference

{key metrics and config values for verification}

## Check Coverage Matrix (REQUIRED — one row per check, all 24, in order)

| Check                                                              | Verdict  | Observed value | Threshold applied |
| ------------------------------------------------------------------ | -------- | -------------- | ----------------- |
| 1.1 Cluster status                                                 | 🟢/⚠️/🔴 | {value}        | {rule}            |
| 1.2 Node/AZ balance                                                | ...      | ...            | ...               |
| ... (every check through 5.3 — SKIPPED rows must state the reason) |
```

## Error Handling

- If `DescribeDomainHealth` returns `Processing` → domain is being modified. Report current state with caveat.
- If any API returns `AccessDeniedException` → report which check was skipped and what permission is needed.
- If CloudWatch returns no datapoints → report "No data available for {metric}. Domain may be newly created or idle."
