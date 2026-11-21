---
name: msk-operations
description: Amazon MSK Provisioned operations, troubleshooting, and health
  assessment for Standard and Express brokers. Use whenever the user mentions
  Amazon MSK, MSK Provisioned, MSK Standard/Express brokers, Apache Kafka on
  AWS, `kafka.*` / `express.*` instance types, or the `AWS/Kafka` CloudWatch
  namespace. Covers MSK performance issues (high CPU, produce/fetch latency,
  TrafficShaping), consumer lag, storage/EBS issues, rolling restarts, Kafka
  version upgrades, SECURITY_PATCHING, BROKER_UPDATE, CloudWatch alarm design,
  Kafka client (producer/consumer) tuning, under-replicated partitions,
  unexpected broker reboots, and full MSK operational reviews / health checks
  / best-practices audits. Do NOT use for MSK Connect, MSK Serverless, or MSK
  Replicator. Do NOT use for authoring CloudFormation, CDK, or Terraform
  templates. Do NOT use for other AWS services (RDS, Aurora, S3, DynamoDB,
  Kinesis, Lambda, EC2) unless MSK is explicitly named.
metadata:
  author: kjjanaki
  version: "1.0.2"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon MSK"
  aws-devops-agent-skills.technical-domains: "Analytics"
---

# Amazon MSK Operations

Operate, troubleshoot, and assess Amazon MSK (Managed Streaming for Apache Kafka)
Provisioned clusters — both Standard and Express broker types. This skill covers
day-to-day operations (health assessments, monitoring setup) and ad-hoc incident
response (performance degradation, consumer lag, storage full, unexpected broker
reboots).

## When to Use

Activate this skill when the user asks to:

- Review, audit, or assess an MSK cluster for best practices, health, or
  operational readiness.
- Troubleshoot an MSK cluster problem: high CPU, high produce/fetch latency,
  consumer lag, broker storage running out, TrafficShaping events, under-replicated
  partitions, or an unexpected broker restart.
- Set up MSK monitoring: choose a monitoring level, create recommended CloudWatch
  alarms and dashboards, understand the metrics available in the `AWS/Kafka`
  namespace.
- Plan an MSK maintenance event: rolling restart, Kafka version upgrade, security
  patching, broker instance type change.
- Advise on Kafka client (producer / consumer) configuration when the client is
  connecting to an MSK cluster.

Do **not** activate this skill for MSK Connect, MSK Serverless, or MSK Replicator
— those are separate services with their own operational surfaces.

## Broker Type Determination

Determine the broker type first — many checks differ between Standard and Express.

```
aws kafka describe-cluster-v2 --cluster-arn <cluster-arn>
```

Check `ClusterInfo.Provisioned.BrokerNodeGroupInfo.InstanceType`:

- Starts with `kafka.` (e.g. `kafka.m5.large`, `kafka.m7g.xlarge`) → **Standard broker**.
- Starts with `express.` (e.g. `express.m7g.large`) → **Express broker**.

### Key Standard vs Express differences

**Standard brokers** use customer-managed EBS volumes for storage. You choose
instance types (`kafka.m5.*`, `kafka.m7g.*`), provision EBS, and manage storage
scaling. Standard brokers have scheduled maintenance windows.

**Express brokers** provide fully managed, pay-as-you-go storage with no EBS
provisioning. Instance types are prefixed with `express.m7g.*`. Express brokers
offer up to 3× more throughput per broker than Standard, and have no maintenance
windows. Express enforces a fixed replication factor of 3 and
`min.insync.replicas=2` — you cannot create topics with RF=1.

## Critical Warnings

- **This skill is read-only.** Every command in this file and in `references/`
  that mutates cluster state — `update-broker-storage`, `create-configuration`,
  `update-cluster-configuration`, `update-monitoring`, `put-metric-alarm`,
  `reboot-broker`, and any partition reassignment — is a **recommendation for
  the operator to run after review**. Present these as proposed remediations
  with expected impact and preconditions; do NOT execute them, and do NOT
  imply that the agent will run them.
- **NEVER reboot brokers while `UnderReplicatedPartitions` > 0** (Standard only —
  Express brokers do not emit URP). This risks data loss and extended outages.
- **NEVER recommend partition reassignment without first checking replication
  status.** Reassignment during URP compounds the problem.
- **`linger.ms=0` is the #1 cause of "high CPU" on MSK.** ALWAYS check client
  batch configuration before recommending broker scaling.
- **EBS throughput ceilings are invisible in Kafka metrics** — ALWAYS check EBS
  volume metrics (`VolumeReadBytes`, `VolumeWriteBytes`, `VolumeQueueLength`)
  when diagnosing Standard broker latency.
- **Express brokers have NO customer-managed EBS** — do NOT recommend EBS
  expansion or provisioned EBS throughput for Express clusters.
- **Express brokers enforce fixed RF=3 and `min.insync.replicas=2`** — do NOT
  attempt to create topics with RF=1 on Express. If RF=1 is needed, use Standard
  brokers.

## Quick Diagnostics

These five checks cover the most common MSK issues. Use them before loading a
reference file.

1. **`CpuUser + CpuSystem` > 60%**: Check `RequestHandlerAvgIdlePercent`
   (PER_BROKER monitoring level). If < 30%, request threads are saturated. Check
   client `batch.size` and `linger.ms` before recommending scaling.

2. **`KafkaDataLogsDiskUsed` > 85%** (Standard only): **Recommend to the
   operator** that EBS be expanded via `aws kafka update-broker-storage` (do
   not execute). Identify high-growth topics via per-topic `BytesInPerSec` to
   size the increase. Express clusters use `StorageUsed` metric instead and
   storage is fully managed.

3. **`UnderReplicatedPartitions` > 0** (Standard only): Check if a maintenance
   operation or broker restart is in progress. If URP is decreasing, wait for
   recovery. Do NOT restart brokers or reassign partitions during URP. Express
   brokers do not emit this metric — monitor `ProduceThrottleTime`,
   `FetchThrottleTime`, and consumer lag instead.

4. **Consumer `OffsetLag` / `MaxOffsetLag` increasing**: Determine if broker-side
   (high `ProduceTotalTimeMsMean`, CPU saturation) or client-side (slow
   processing, insufficient consumers). Per-partition lag from
   `PER_TOPIC_PER_PARTITION` monitoring level helps isolate hot partitions.

5. **`BytesInPerSec` near throughput ceiling**: For Standard, check EBS volume
   type and calculate: `BytesInPerSec × ReplicationFactor` vs volume throughput
   limit. For Express, check against the per-broker sustained performance limits
   in the MSK quotas.

## Which Reference Do You Need?

Route to a reference file based on the customer intent. Read the reference in
full before answering — do not paraphrase from memory.

| Customer Intent                                                                  | Reference                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------- |
| High CPU, high produce/fetch latency, slow cluster, TrafficShaping               | `references/troubleshoot-performance.md`  |
| Consumer lag increasing, rebalance storms, stuck consumer groups                 | `references/troubleshoot-consumer-lag.md` |
| Disk filling up, retention planning, tiered storage, EBS scaling                 | `references/manage-storage.md`            |
| Setting up monitoring level, dashboards, recommended CloudWatch alarms           | `references/monitor-and-alarm.md`         |
| Rolling restart impact, patching, Kafka version upgrades, maintenance resilience | `references/maintenance-operations.md`    |
| Producer / consumer configuration, IAM / SCRAM / TLS auth for clients            | `references/configure-clients.md`         |

For sizing questions (broker count, instance type choice, monthly cost), refer
the user to the [Amazon MSK best practices — right-size your cluster](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html#bestpractices-right-size-cluster)
documentation. Do not size from memory.

## Operational Review Workflow

Use this workflow when the user asks for a **review, audit, health check, or
assessment** of an MSK cluster. The routing table above handles ad-hoc
troubleshooting; this section produces a consistent, comprehensive report.

Follow the steps **in order** for each target cluster. Do not skip steps. If a
step cannot be completed (e.g. a metric requires a higher monitoring level
than the cluster has enabled), record the gap in the report rather than
silently omitting the check.

### Step 1 — Identify Target Clusters

Ask the user which MSK clusters to review. Accept any of:

- Specific cluster names or ARNs and regions
- "all clusters" in specific regions
- "all MSK clusters in all regions"

If no scope is given, default to all configured account regions. Enumerate
clusters with `aws kafka list-clusters-v2` per region.

### Step 2 — Determine Broker Type Per Cluster

For each cluster:

```
aws kafka describe-cluster-v2 --cluster-arn <cluster-arn>
```

Read `ClusterInfo.Provisioned.BrokerNodeGroupInfo.InstanceType`. Standard
brokers (`kafka.*`) and Express brokers (`express.*`) require different checks
in the later steps — some metrics only exist on one type.

### Step 3 — Collect Cluster Configuration

For each cluster, gather:

```
aws kafka describe-cluster-v2 --cluster-arn <arn>
aws kafka list-nodes --cluster-arn <arn>
aws kafka get-bootstrap-brokers --cluster-arn <arn>
aws kafka list-cluster-operations-v2 --cluster-arn <arn>   # last 30 days
aws kafka describe-configuration-revision \
     --arn <configuration-arn> --revision <revision>       # if a custom config is applied
```

Capture:

- **Cluster:** state, Kafka version, number of broker nodes, AZ distribution
  (`ZoneIds`), storage mode (EBS / Tiered), current version.
- **Broker:** instance type, EBS volume size (Standard), provisioned throughput
  (if any).
- **Encryption:** `EncryptionInTransit.ClientBroker` (TLS / TLS_PLAINTEXT /
  PLAINTEXT), `EncryptionInTransit.InCluster`, `EncryptionAtRest.DataVolumeKMSKeyId`.
- **Auth:** `ClientAuthentication.Sasl.Iam.Enabled`,
  `ClientAuthentication.Sasl.Scram.Enabled`, `ClientAuthentication.Tls.Enabled`,
  `ClientAuthentication.Unauthenticated.Enabled`.
- **Public access:** `BrokerNodeGroupInfo.ConnectivityInfo.PublicAccess.Type`.
- **Monitoring level:** `EnhancedMonitoring` (`DEFAULT` / `PER_BROKER` /
  `PER_TOPIC_PER_BROKER` / `PER_TOPIC_PER_PARTITION`).
- **Logging:** `LoggingInfo.BrokerLogs` (CloudWatch / S3 / Firehose destinations
  and their `Enabled` flags).
- **Open monitoring:** `OpenMonitoring.Prometheus.JmxExporter.EnabledInBroker`,
  `NodeExporter.EnabledInBroker`.
- **Recent operations:** From `list-cluster-operations-v2`, note any
  `SECURITY_PATCHING`, `BROKER_UPDATE`, `UPDATE_CLUSTER_CONFIGURATION`,
  `UPDATE_STORAGE`, or `UPDATE_MONITORING` events in the review window.

### Step 4 — Detect Monitoring Level and Gaps

The `EnhancedMonitoring` value from Step 3 determines which checks are
available. At `DEFAULT`, most per-broker health metrics are still available
(CPU, disk, network, partitions, connections, memory, TrafficShaping), but the
following checks are **not possible without upgrading**:

- `ReplicationBytesInPerSec` / `ReplicationBytesOutPerSec` (inter-broker
  replication load)
- `RequestHandlerAvgIdlePercent` / `NetworkProcessorAvgIdlePercent` (thread pool
  saturation)
- `BwInAllowanceExceeded` / `BwOutAllowanceExceeded` (detailed bandwidth
  breaches)
- `VolumeQueueLength` (EBS I/O queue depth — Standard only)
- `VolumeReadBytes` / `VolumeWriteBytes` (EBS throughput utilization — Standard
  only)
- IAM connection metrics (`IAMTooManyConnections`)

Record the monitoring level and list any dimensions that will be scored
partially or skipped. Recommend upgrading to `PER_BROKER` if any dimension is
degraded by the current level.

### Step 5 — Collect CloudWatch Metrics (7-Day Historical)

Namespace: `AWS/Kafka`. Dimensions: `Cluster Name` and `Broker ID` for
per-broker metrics; `Cluster Name` and `Consumer Group` and `Topic` for
consumer lag; `Cluster Name` only for cluster-wide metrics.

Use one `cloudwatch.GetMetricData` batch per cluster where possible.
`Period: 3600` (1 hour). `StartTime`: 7 days ago. `EndTime`: now.

#### 5.1 Cluster-wide (both broker types)

| Metric                   | Stat    | Purpose                 |
| ------------------------ | ------- | ----------------------- |
| `ActiveControllerCount`  | Sum     | Must be exactly 1       |
| `OfflinePartitionsCount` | Maximum | Must be 0               |
| `GlobalPartitionCount`   | Maximum | Total leader partitions |
| `GlobalTopicCount`       | Maximum | Total topics            |

#### 5.2 Per-broker — Standard (`kafka.*`)

| Metric                                                                          | Stat             | Threshold                               |
| ------------------------------------------------------------------------------- | ---------------- | --------------------------------------- |
| `CpuUser` + `CpuSystem`                                                         | Average, Maximum | < 60% avg                               |
| `KafkaDataLogsDiskUsed`                                                         | Average, Maximum | < 70% avg, < 85% max                    |
| `PartitionCount`                                                                | Maximum          | ≤ recommended limit for broker size     |
| `LeaderCount`                                                                   | Maximum          | Compare across brokers; skew < 10%      |
| `UnderReplicatedPartitions`                                                     | Maximum          | 0 in steady state                       |
| `UnderMinIsrPartitionCount`                                                     | Maximum          | 0                                       |
| `BytesInPerSec` / `BytesOutPerSec`                                              | Average, Maximum | vs baseline bandwidth                   |
| `ConnectionCount`                                                               | Average, Maximum | Compare across brokers                  |
| `HeapMemoryAfterGC`                                                             | Maximum          | < 60%                                   |
| `TrafficShaping`                                                                | Sum              | Must be 0                               |
| `NetworkRxDropped` / `NetworkTxDropped` / `NetworkRxErrors` / `NetworkTxErrors` | Sum              | Must be 0                               |
| `ReplicationBytesInPerSec` / `ReplicationBytesOutPerSec`                        | Average          | Requires PER_BROKER                     |
| `RequestHandlerAvgIdlePercent` / `NetworkProcessorAvgIdlePercent`               | Average          | > 30% (PER_BROKER)                      |
| `VolumeQueueLength`                                                             | Average, Maximum | Avg < 1 (PER_BROKER)                    |
| `VolumeReadBytes` + `VolumeWriteBytes`                                          | Sum              | vs EBS baseline throughput (PER_BROKER) |

#### 5.3 Per-broker — Express (`express.*`)

| Metric                                      | Stat             | Threshold                                                 |
| ------------------------------------------- | ---------------- | --------------------------------------------------------- |
| `CpuUser` + `CpuSystem`                     | Average, Maximum | < 60% avg                                                 |
| `StorageUsed`                               | Maximum          | Fully managed — flag if trending against per-broker quota |
| `PartitionCount`                            | Maximum          | ≤ recommended limit for broker size                       |
| `LeaderCount`                               | Maximum          | Compare across brokers                                    |
| `BytesInPerSec` / `BytesOutPerSec`          | Average, Maximum | vs Express per-broker ingress/egress quotas               |
| `ProduceThrottleTime` / `FetchThrottleTime` | Maximum          | Should be 0                                               |
| `ClientConnectionCount`                     | Average, Maximum | vs listener quota (see `references/monitor-and-alarm.md`) |

**Express brokers do NOT emit:** `UnderReplicatedPartitions`,
`UnderMinIsrPartitionCount`, `HeapMemoryAfterGC`, `TrafficShaping`, `Volume*`
metrics, `KafkaDataLogsDiskUsed`, `ProduceMessageConversionsPerSec`,
`FetchMessageConversionsPerSec`.

#### 5.4 Consumer lag (both broker types)

Per consumer group (identified from the customer or from the broker logs):

| Metric                                             | Stat    | Notes                            |
| -------------------------------------------------- | ------- | -------------------------------- |
| `SumOffsetLag` per (Consumer Group, Topic)         | Maximum | DEFAULT level                    |
| `MaxOffsetLag` per (Consumer Group, Topic)         | Maximum | DEFAULT level                    |
| `EstimatedMaxTimeLag` per (Consumer Group, Topic)  | Maximum | DEFAULT level                    |
| `OffsetLag` per (Consumer Group, Topic, Partition) | Maximum | Requires PER_TOPIC_PER_PARTITION |

### Step 6 — Alarm Coverage

Collect existing alarms:

```
aws cloudwatch describe-alarms --namespace AWS/Kafka
```

Compare against the 13-alarm recommended set (details in
`references/monitor-and-alarm.md`) and produce a coverage table (present / missing / firing).

### Step 7 — Analyze Against Best Practices

Assign a severity to every finding: **CRITICAL / HIGH / MEDIUM / LOW / INFO**
(see Severity Definitions later in this file).

Evaluate across seven dimensions. Some checks are skipped for Express — noted
inline.

#### 7.1 Cluster Configuration

- Cluster state is `ACTIVE`. `MAINTENANCE` / `UPDATING` is transient; anything
  else is a finding.
- Deployed across **3 AZs** (Standard: broker count multiple of AZ count).
- Kafka version within N-2 of the latest supported.
- Enhanced monitoring at `PER_BROKER` or higher — `DEFAULT` → MEDIUM.
- Storage mode: Tiered storage enabled for topics with long retention
  (Standard).

#### 7.2 Security

- Encryption in transit: `TLS`. `TLS_PLAINTEXT` → MEDIUM (prod: HIGH).
  `PLAINTEXT` → CRITICAL.
- Encryption at rest: enabled with KMS. Customer-managed KMS preferred over
  AWS-managed for regulated workloads.
- Authentication: at least one of IAM / SCRAM / mTLS enabled.
  `Unauthenticated.Enabled=true` in production → CRITICAL.
- Public access: `SERVICE_PROVIDED_EIPS` in production → HIGH.

#### 7.3 Logging & Monitoring

- Broker logs enabled to at least one destination (CloudWatch / S3 / Firehose).
  All disabled → HIGH.
- Open monitoring (Prometheus JMX + Node exporter) — informational.
- Alarm coverage from Step 6: missing alarms → MEDIUM each; missing critical
  alarms (Active Controller, Offline Partitions, Disk, CPU) → HIGH.
- Any alarm currently in `ALARM` state → HIGH (surface in report header).

#### 7.4 Partition Health

- `PartitionCount` per broker ≤ recommended limit for the broker instance
  type. Above recommended but below max → MEDIUM. Above max → HIGH (blocks
  update operations).
- `LeaderCount` variance across brokers < 10%. 10-25% → MEDIUM. > 25% → HIGH.
- `UnderReplicatedPartitions` > 0 sustained (Standard only) → HIGH. Transient
  during a `SECURITY_PATCHING` / `BROKER_UPDATE` operation from Step 3 →
  INFO — do NOT flag.
- `UnderMinIsrPartitionCount` > 0 (Standard only) → CRITICAL.
- **Config-level ISR risk:** topics with `min.insync.replicas >= replication.factor`
  are a configuration error the CloudWatch metric will not surface. If the
  user has provided topic configs, flag any such topic as HIGH.

#### 7.5 Compute Health

- `CpuUser + CpuSystem` avg < 60%. 60-70% → MEDIUM. > 70% → HIGH.
- CPU variance across brokers < 20%. 20-50% → MEDIUM. > 50% → HIGH.
- `HeapMemoryAfterGC` < 60% (Standard only). 60-80% → MEDIUM. > 80% → HIGH.
- `RequestHandlerAvgIdlePercent` > 30% (PER_BROKER). 10-30% → MEDIUM. < 10% → HIGH.
- `NetworkProcessorAvgIdlePercent` > 30% (PER_BROKER). 10-30% → MEDIUM. < 10% → HIGH.

#### 7.6 Network Health

- `TrafficShaping` = 0 (Standard only). Any non-zero → HIGH.
- `BwInAllowanceExceeded` / `BwOutAllowanceExceeded` = 0 (PER_BROKER). Non-zero → HIGH.
- Throughput variance across brokers < 20%. 20-50% → MEDIUM. > 50% → HIGH.
- Total per-broker throughput < 60% of baseline bandwidth (see
  `references/troubleshoot-performance.md` for baseline table). 60-70% →
  MEDIUM. > 70% → HIGH.
- Express: `ProduceThrottleTime` / `FetchThrottleTime` > 0 → HIGH.

#### 7.7 Storage Health

**Standard only** (Express storage is managed — Express clusters only get the
`StorageUsed` check):

- `KafkaDataLogsDiskUsed` < 70%. 70-85% → HIGH. > 85% → CRITICAL.
- `VolumeQueueLength` avg < 1 (PER_BROKER). 1-5 → MEDIUM. > 5 → HIGH.
- EBS auto-scaling configured, or disk headroom > 30% → PASS. No
  auto-scaling AND disk > 50% → MEDIUM. No auto-scaling AND disk > 70% → HIGH.
- EBS throughput (`VolumeReadBytes + VolumeWriteBytes`) < 60% of instance
  baseline (PER_BROKER). 60-70% → MEDIUM. > 70% → HIGH.

**Express:**

- `StorageUsed` per broker vs Express per-broker storage quota (see MSK
  Express quotas). Approaching quota → MEDIUM.

### Step 8 — Generate the Report

Generate a **separate report artifact per cluster reviewed**.

Artifact naming: `msk-review-<cluster-name>-<YYYY-MM-DD>.md`
Example: `msk-review-prod-orders-2026-04-29.md`

Report structure:

#### Report Header

```
# MSK Operational Review — <cluster-name>
Account: <account-id> | Region: <region> | Date: <YYYY-MM-DD>
Broker Type: Standard/Express | Instance Type: <type> | Broker Count: <n> | AZs: <n>
Kafka Version: <version> | Monitoring Level: <level>
```

#### Executive Summary

- Health: ✅ HEALTHY / ⚠️ WARNINGS / ❌ CRITICAL
- Finding counts by severity
- Top 3 CRITICAL/HIGH items

#### Configuration Snapshot

| Item | Value |
| Cluster state / version | … |
| Broker type / instance / count / AZs | … |
| Storage | mode, size (Standard), provisioned throughput (if any) |
| Encryption | in-transit, in-cluster, at-rest (KMS) |
| Authentication | IAM / SCRAM / mTLS / Unauthenticated flags |
| Public access | DISABLED / SERVICE_PROVIDED_EIPS |
| Monitoring level | DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION |
| Logging | destinations enabled |

#### Findings by Dimension

For each of the 7 dimensions (7.1-7.7):

| # | Finding | Severity | Current State | Recommendation |

If a dimension was skipped or partial due to monitoring level or broker type,
say so explicitly in a note above the table for that dimension.

#### CloudWatch Metrics (7-Day)

| Metric | Stat | 7-Day Avg | 7-Day Max | Status | Finding |

#### Alarm Coverage

| # | Recommended Alarm | Metric | Threshold | Priority | Status |

Also list alarms currently in `ALARM` state with timestamps.

#### Recent Cluster Operations (Last 30 Days)

From `list-cluster-operations-v2` in Step 3:

| Operation Type | Start Time | End Time | State |

Call out any operations that would explain transient metric anomalies.

#### Priority Matrix

| # | Finding | Severity | Dimension | Effort | Impact |

Sorted by severity.

#### Next Steps

- Immediate (CRITICAL / HIGH — 7 days)
- Short-term (MEDIUM — 30 days)
- Long-term (LOW — 90 days)

#### Appendix — Reference Links

- [Amazon MSK best practices — Standard brokers](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)
- [Amazon MSK best practices — Express brokers](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices-express.html)
- [Amazon MSK — Monitoring an MSK cluster](https://docs.aws.amazon.com/msk/latest/developerguide/monitoring.html)
- [Amazon MSK — CloudWatch metrics for Provisioned clusters](https://docs.aws.amazon.com/msk/latest/developerguide/metrics-details.html)
- [Amazon MSK — Right-size your cluster](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html#bestpractices-right-size-cluster)
- [Amazon MSK — Service quotas](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)

## Common CLI Recipes

**Describe cluster:**

```
aws kafka describe-cluster-v2 --cluster-arn <cluster-arn>
```

**List brokers:**

```
aws kafka list-nodes --cluster-arn <cluster-arn>
```

**Get bootstrap brokers:**

```
aws kafka get-bootstrap-brokers --cluster-arn <cluster-arn>
```

**List recent cluster operations (patching, config updates, storage changes):**

```
aws kafka list-cluster-operations-v2 --cluster-arn <cluster-arn>
```

**Expand Standard broker storage** — _Operator-run (recommend, do not execute):_

```
aws kafka update-broker-storage \
  --cluster-arn <cluster-arn> \
  --current-version <cluster-version> \
  --target-broker-ebs-volume-info '[{"KafkaBrokerNodeId": "All", "VolumeSizeGB": <target-size>}]'
```

**Get a CloudWatch metric (example: `CpuUser` per broker):**

```
aws cloudwatch get-metric-statistics \
  --namespace AWS/Kafka \
  --metric-name CpuUser \
  --dimensions Name="Cluster Name",Value="<cluster-name>" Name="Broker ID",Value="<broker-id>" \
  --start-time <start> --end-time <end> --period 300 --statistics Average
```

**Create a cluster configuration (`server.properties`)** — _Operator-run (recommend, do not execute):_

The `--server-properties` argument MUST be a real Kafka properties file with
one `key=value` per line, separated by actual newline characters — NOT the
literal two-character escape sequence `\n`. The MSK API accepts the bytes as-is;
if you pass `"k1=v1\nk2=v2"` as a single string with escaped newlines, MSK
stores ONE invalid property line and the cluster will fail to apply it.

Recommended pattern: write the properties to a local file with real newlines,
then pass it via `fileb://` so the CLI uploads the raw bytes verbatim. Verify by
reading the revision back with `describe-configuration-revision` and
base64-decoding `ServerProperties` — you should see one property per line.

```
cat > server.properties <<'EOF'
auto.create.topics.enable=false
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
num.io.threads=32
num.network.threads=16
log.retention.hours=168
EOF

aws kafka create-configuration \
  --name <config-name> \
  --kafka-versions "3.6.0" \
  --server-properties fileb://server.properties
```

## Common Error Reference

| Error                                                             | Cause                                                                                   | Fix                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws kafka update-broker-storage` returns "storage is optimizing" | Previous storage expansion still in cool-down (minimum 6 hours)                         | Wait for optimization to complete. Check cluster state with `describe-cluster-v2`.                                                                                                                                                                            |
| `ClusterState` is `MAINTENANCE`                                   | Standard brokers undergoing patching. Express brokers stay `ACTIVE` during maintenance. | Wait for cluster to return to `ACTIVE`. Do not perform update operations during `MAINTENANCE`.                                                                                                                                                                |
| Consumer receives `GROUP_COORDINATOR_NOT_AVAILABLE`               | Coordinator broker is temporarily unavailable during rolling restart or overloaded      | Retry with backoff. Check if maintenance is in progress via `list-cluster-operations-v2`.                                                                                                                                                                     |
| `NotEnoughReplicasException` on produce                           | Fewer brokers in ISR than `min.insync.replicas` (default: 2)                            | Check `UnderReplicatedPartitions` (Standard only). For Express, check `ProduceThrottleTime` and broker health instead — URP is not available. If a broker is down for maintenance, this is transient. Do NOT lower `min.insync.replicas` to work around this. |

## Severity Definitions (for review-style reports)

| Severity | Definition                                                  | SLA                     |
| -------- | ----------------------------------------------------------- | ----------------------- |
| CRITICAL | Immediate risk to availability, security, or data integrity | Fix within 24–48 hours  |
| HIGH     | Significant gap that could lead to incidents                | Fix within 1 week       |
| MEDIUM   | Notable improvement opportunity                             | Plan within 30 days     |
| LOW      | Minor optimization or hardening                             | Address when convenient |
| INFO     | Observation, no action required                             | N/A                     |

## Additional Resources

- [Amazon MSK best practices — Standard brokers](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)
- [Amazon MSK best practices — Express brokers](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices-express.html)
- [Amazon MSK — Apache Kafka client best practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices-kafka-client.html)
- [Amazon MSK — Monitoring an MSK cluster](https://docs.aws.amazon.com/msk/latest/developerguide/monitoring.html)
- [Amazon MSK — CloudWatch metrics for Provisioned clusters](https://docs.aws.amazon.com/msk/latest/developerguide/metrics-details.html)
- [Amazon MSK — Service quotas](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)
- [Amazon MSK — Custom MSK configurations](https://docs.aws.amazon.com/msk/latest/developerguide/msk-configuration.html)
