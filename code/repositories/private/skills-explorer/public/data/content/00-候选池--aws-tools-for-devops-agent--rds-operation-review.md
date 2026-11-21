---
name: rds-operation-review
description: Comprehensive Amazon RDS and Aurora operational review aligned with the
  AWS Well-Architected Framework and RDS/Aurora best practices. Use this skill when
  a user asks to review, audit, or assess RDS instances or Aurora clusters for best
  practices compliance, security posture, reliability, performance, cost optimization,
  backups, encryption, or operational readiness. Triggers on requests like "RDS
  review", "Aurora best practices audit", "database operational assessment", "review
  my RDS instance", "RDS health check", or "ORR for RDS".
metadata:
  author: yakiratz-aws
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon RDS"
  aws-devops-agent-skills.technical-domains: "Databases"
---

# RDS / Aurora Operational Review

Conduct a comprehensive operational review of Amazon RDS instances and Amazon Aurora
clusters aligned with the [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
and the [Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html)
and [Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_BestPractices.html)
best-practices guides.

This skill uses the **AWS RDS, Aurora, CloudWatch, CloudWatch Logs, EC2, and Cost
Explorer APIs only** — no Kubernetes (`k8s`) or `eks` MCP tools. All data is
collected through native AWS APIs available to the DevOps Agent's primary cloud
source role.

## When to Use

Activate this skill when the user asks to:

- Review, audit, or assess RDS instances or Aurora clusters
- Check RDS / Aurora best-practices compliance
- Evaluate database security, cost, reliability, performance, or backups
- Perform an RDS / Aurora operational readiness review (ORR)
- Investigate database health or configuration drift

## Step 1: Identify Target Resources

Ask the user which databases to review. Accept:

- Specific instance / cluster identifiers and regions
- "all instances" / "all clusters" in specific regions
- "all RDS in all regions"

If no scope is given, default to all configured account regions.

## Step 2: Discover RDS / Aurora Resources

Per region (skip empty regions):

```
rds.DescribeDBInstances           # RDS instances + Aurora cluster member instances
rds.DescribeDBClusters            # Aurora clusters (skip if user said "Provisioned only")
rds.DescribeDBClusterEndpoints    # Aurora reader/writer endpoints
rds.DescribeGlobalClusters        # Aurora Global Database (cross-region)
rds.DescribeDBProxies             # RDS Proxy
```

Capture per resource:

- Engine, engineVersion, dbInstanceClass / serverlessV2 capacity
- Multi-AZ, AvailabilityZones, subnetGroup, VpcId
- AllocatedStorage, MaxAllocatedStorage, StorageType, Iops, StorageThroughput, StorageEncrypted, KmsKeyId
- BackupRetentionPeriod, PreferredBackupWindow, PreferredMaintenanceWindow, AutoMinorVersionUpgrade
- DeletionProtection, PubliclyAccessible, IAMDatabaseAuthenticationEnabled
- PerformanceInsightsEnabled, PerformanceInsightsRetentionPeriod, MonitoringInterval (Enhanced Monitoring), MonitoringRoleArn
- EnabledCloudwatchLogsExports, AssociatedRoles
- ReadReplicaSourceDBInstanceIdentifier / ReadReplicaDBInstanceIdentifiers
- Tags (`rds.ListTagsForResource` — param name is `ResourceName` and value is the resource ARN)

## Step 3: Discover Configuration Dependencies

For each database, collect:

```
rds.DescribeDBParameterGroups           # custom vs default
rds.DescribeDBClusterParameterGroups    # Aurora
rds.DescribeOptionGroups                # RDS option groups
rds.DescribeDBSubnetGroups              # subnet AZ spread
ec2.DescribeSecurityGroups              # vpcSecurityGroupIds → ingress rules
kms.DescribeKey                         # for KmsKeyId (encryption at rest)
```

## Step 4: Collect Backups, Snapshots, Maintenance

```
rds.DescribeDBSnapshots                            # manual + automated, per instance
rds.DescribeDBClusterSnapshots                     # Aurora
rds.DescribeDBInstanceAutomatedBackups
rds.DescribeDBClusterAutomatedBackups
rds.DescribeDBEngineVersions                       # current vs latest minor/major
rds.DescribePendingMaintenanceActions
rds.DescribeEvents                                 # last 14 days; duration in MINUTES (20160)
rds.DescribeEventSubscriptions
```

For each instance/cluster, also fetch:

- `rds.DescribeDBLogFiles` — list of logs available locally on the DB
- `logs.DescribeLogGroups` with prefix:
  - Instances: `/aws/rds/instance/<dbInstanceIdentifier>/`
  - Aurora: `/aws/rds/cluster/<dbClusterIdentifier>/`

## Step 5: Collect CloudWatch Metrics (7-Day Historical)

**One** `cloudwatch.GetMetricData` call per resource. `Period: 21600` (6 hours).
`StartTime`: 7 days ago. `EndTime`: now.

### 5.1 RDS Instances (dimension `DBInstanceIdentifier`)

| id          | metricName                | stat    | unit    |
| ----------- | ------------------------- | ------- | ------- |
| `cpu`       | CPUUtilization            | Average | %       |
| `freeMem`   | FreeableMemory            | Minimum | bytes   |
| `freeSpace` | FreeStorageSpace          | Minimum | bytes   |
| `readIops`  | ReadIOPS                  | Average | count/s |
| `writeIops` | WriteIOPS                 | Average | count/s |
| `readLat`   | ReadLatency               | Average | s       |
| `writeLat`  | WriteLatency              | Average | s       |
| `dbConn`    | DatabaseConnections       | Maximum | count   |
| `swap`      | SwapUsage                 | Average | bytes   |
| `netIn`     | NetworkReceiveThroughput  | Average | bytes/s |
| `netOut`    | NetworkTransmitThroughput | Average | bytes/s |
| `binLog`    | BinLogDiskUsage           | Average | bytes   |
| `replLag`   | ReplicaLag                | Maximum | s       |

### 5.2 Aurora Clusters (dimension `DBClusterIdentifier`)

| id              | metricName                 | stat    | unit  |
| --------------- | -------------------------- | ------- | ----- |
| `cpu`           | CPUUtilization             | Average | %     |
| `freeMem`       | FreeableMemory             | Minimum | bytes |
| `dbConn`        | DatabaseConnections        | Maximum | count |
| `replLag`       | AuroraReplicaLag           | Maximum | ms    |
| `bufCache`      | BufferCacheHitRatio        | Average | %     |
| `commitLat`     | CommitLatency              | Average | ms    |
| `readLat`       | ReadLatency                | Average | s     |
| `writeLat`      | WriteLatency               | Average | s     |
| `volReadIops`   | VolumeReadIOPs             | Sum     | count |
| `volWriteIops`  | VolumeWriteIOPs            | Sum     | count |
| `serverlessAcu` | ServerlessDatabaseCapacity | Average | ACU   |

### 5.3 Per-Instance Aurora Members

Same instance metrics as 5.1, dimensioned by `DBInstanceIdentifier` of each cluster member.

Fetch `cloudwatch.DescribeAlarmsForMetric` for the key metrics
(`CPUUtilization`, `FreeStorageSpace`, `DatabaseConnections`, `ReadLatency`,
`WriteLatency`, `ReplicaLag` / `AuroraReplicaLag`) per resource so the report can
flag missing alarms.

## Step 6: Collect Logs (7-Day)

Per database log group, scan with `logs.FilterLogEvents` for:

| Pattern                                              | What it indicates     |
| ---------------------------------------------------- | --------------------- |
| `ERROR` / `FATAL`                                    | engine errors         |
| `Out of memory` / `OOM`                              | memory pressure       |
| `connection limit exceeded` / `too many connections` | connection saturation |
| `deadlock` / `lock wait timeout`                     | contention            |
| `slow query` / `duration: ` (Postgres slow log)      | query performance     |
| `aborted connection` (MySQL)                         | client/network issues |
| `replication has stopped` / `IO_THREAD` errors       | replication health    |
| `checkpoint` warnings / `archiver failed`            | I/O / WAL issues      |
| `failed to connect` / `authentication failed`        | auth/network          |

Record occurrence counts per pattern over the 7-day window.

## Step 7: Collect CloudTrail-Visible RDS Events

Use `rds.DescribeEvents` (last 14 days) per resource — covers the same
operational signal as CloudTrail for RDS without an extra API permission.
Look for: `failover`, `restart`, `parameter group apply`, `out-of-memory`,
`storage-full`, `low-storage`, `automated-backup-failed`,
`maintenance`-related events, `read replica error`, `instance stopped`.

## Step 8: Cost Data

Once per review (not per resource):

```
costexplorer.GetCostAndUsage     # 3 months, by USAGE_TYPE,
                                 # filter Service = "Amazon Relational Database Service"
rds.DescribeReservedDBInstances  # RI inventory
```

Estimate per-database monthly cost as a proportional split of the latest month
total (Cost Explorer doesn't break down per DB):

1. Get the most recent full month total RDS spend.
2. Per resource, weight by `vCPUs(instance class) × (Multi-AZ ? 2 : 1) + allocatedStorageGB`.
3. For Aurora clusters, sum across cluster member instances; storage is cluster-shared.
4. Note the estimate in the report with an "estimated" badge.

## Step 9: Analyze Against Best Practices

Evaluate ALL collected data across the five Well-Architected pillars and assign a
severity to every finding: CRITICAL, HIGH, MEDIUM, LOW, or INFO.

### 9.1 Security

Ref: [Security in Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.html)

- **Network exposure**: `PubliclyAccessible=true` → CRITICAL for production. Security groups with `0.0.0.0/0` ingress on the DB port → CRITICAL.
- **Encryption at rest**: `StorageEncrypted=false` → HIGH (or CRITICAL for regulated workloads). Customer-managed KMS key preferred over AWS-managed.
- **Encryption in transit**: parameter `rds.force_ssl=1` (Postgres) / `require_secure_transport=ON` (MySQL/MariaDB) → MEDIUM if not set.
- **IAM auth**: `IAMDatabaseAuthenticationEnabled=false` → MEDIUM. Master password in app code instead of Secrets Manager → HIGH.
- **Secrets Manager rotation**: not enabled → MEDIUM.
- **Audit logging**: engine audit logs not in `EnabledCloudwatchLogsExports` → MEDIUM (HIGH for PCI/HIPAA scope).
- **CMK rotation**: KMS key without automatic rotation → LOW.

### 9.2 Reliability

Ref: [High Availability for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)

- **Multi-AZ**: production single-AZ → HIGH (Aurora: ≥1 reader in a different AZ).
- **Subnet group AZ spread**: subnets span <2 AZs → HIGH.
- **Backups**: `BackupRetentionPeriod=0` → CRITICAL. <7 days for production → HIGH.
- **Deletion protection**: production with `DeletionProtection=false` → HIGH.
- **Auto minor version upgrade**: `AutoMinorVersionUpgrade=false` for non-prod → MEDIUM.
- **Custom parameter group**: instance using `default.<engine>` parameter group → MEDIUM (can't tune).
- **Pending maintenance**: required actions not applied within window → MEDIUM, escalating with age.
- **Replication health (read replicas)**: `ReplicaLag` 7-day max > 30s → HIGH; > 300s → CRITICAL.
- **Aurora replicas**: clusters with no reader → MEDIUM; single-AZ readers → MEDIUM.
- **DR**: cross-region read replica or Aurora Global Database absent for tier-1 workloads → MEDIUM.

### 9.3 Performance

Ref: [DB Instance Performance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Monitoring.html)

7-day metric thresholds (full table in `references/metrics-thresholds.md`):

- `CPUUtilization` avg > 70% → MEDIUM, > 90% → HIGH.
- `FreeStorageSpace` < 20% allocated → HIGH, < 10% → CRITICAL.
- `FreeableMemory` < 10% instance class memory → HIGH; sustained `SwapUsage` > 0 → MEDIUM.
- `DatabaseConnections` max > 80% of `max_connections` parameter → HIGH.
- `ReadLatency` / `WriteLatency` avg > 20ms (10ms for io1/io2) → MEDIUM.
- `BufferCacheHitRatio` (Aurora) < 95% → MEDIUM, < 90% → HIGH.
- `BinLogDiskUsage` growth without retention bounds → MEDIUM.
- **Performance Insights** disabled → MEDIUM (free 7-day tier should always be on).
- **Enhanced Monitoring** disabled or interval > 60s for production → MEDIUM.
- **Connection pooling**: high connection churn / no RDS Proxy → MEDIUM for serverless / many-client workloads.

### 9.4 Cost Optimization

Ref: [Cost-Optimized Architectures](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html#CHAP_BestPractices.Optimization)

- **Stopped instances**: `DBInstanceStatus=stopped` (still pays storage) → HIGH.
- **Previous-generation classes**: `db.m4 / db.r4 / db.t2` → MEDIUM.
- **gp2 → gp3**: any `StorageType=gp2` → MEDIUM (≈20% cheaper, equal/better performance).
- **Over-provisioned IOPS**: `io1`/`io2` with avg `IOPS used / IOPS provisioned < 50%` → MEDIUM.
- **Reserved Instance coverage**: production On-Demand without RIs → MEDIUM, with estimated savings.
- **Storage autoscaling**: `MaxAllocatedStorage` not set → LOW, increases stockout risk.
- **Idle databases**: `DatabaseConnections` 7-day max < 5 + `CPUUtilization` 7-day avg < 5% → MEDIUM (candidate to stop / delete).
- **Manual snapshots**: many > 90 days old → LOW (review retention).
- **Cost-allocation tags**: missing `Environment`, `Owner`, `CostCenter` → LOW.
- **Graviton migration**: x86 (`db.r5`, `db.m5`, `db.t3`) where Graviton is supported → MEDIUM (~20% saving).

### 9.5 Operational Excellence

Ref: [Monitoring Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Monitoring.html)

- **CloudWatch alarms**: missing alarms on `CPUUtilization`, `FreeStorageSpace`, `DatabaseConnections`, `FreeableMemory`, `ReplicaLag` → MEDIUM each.
- **Event subscriptions**: no `rds.DescribeEventSubscriptions` covering this resource → MEDIUM.
- **Engine version currency**: minor version not latest available → LOW; major version EOL/within 6 months → HIGH.
- **Log exports**: engine error / slow / audit logs not exported to CloudWatch → MEDIUM.
- **Maintenance window**: not configured / overlaps business hours → LOW.
- **Tagging**: missing operational tags (`Environment`, `Owner`, `Runbook`, `OnCall`) → LOW.
- **Drift**: parameters changed in default parameter group (impossible by design — use as a flag for non-default usage check).

## Step 10: Generate Report

Generate a separate shareable report artifact for **each resource** reviewed.

Artifact naming: `rds-review-<resource-name>-<YYYY-MM-DD>.md`
Example: `rds-review-prod-aurora-2026-04-29.md`

For each resource, create the artifact as a Markdown document with:

### Report Header

```
# RDS / Aurora Operational Review — <resource-name>
Account: <account-id> | Region: <region> | Date: <YYYY-MM-DD>
Engine: <engine> <engineVersion> | Class: <dbInstanceClass / serverlessV2 ACU> | Multi-AZ: <yes/no>
```

### Executive Summary

- Health: ✅ HEALTHY / ⚠️ WARNINGS / ❌ CRITICAL
- Finding counts by severity
- Top 3 critical/high items

### Configuration Snapshot

| Item | Value |
| Engine / version | … |
| Storage | type, allocated, max, IOPS, throughput, encrypted (KMS) |
| Network | VPC, subnet group, AZs, public access, security groups |
| Backup | retention, window, automated, deletion protection |
| HA / DR | Multi-AZ, replicas, Global DB |
| Auth | IAM auth, Secrets Manager, master user |
| Observability | Performance Insights, Enhanced Monitoring, log exports |

### Findings by Pillar

For each of Security, Reliability, Performance, Cost, Operational Excellence:

| # | Finding | Severity | Current State | Recommendation |

### CloudWatch Metrics (7-Day)

| Metric | Stat | 7-Day Avg | 7-Day Max / Min | Status | Finding |

### Log Pattern Analysis (7-Day)

| Pattern | Occurrences | Severity | Finding |

### RDS Events (14-Day)

Notable events (failovers, restarts, low-storage, OOM, maintenance) with timestamps.

### Pending Maintenance

List from `rds.DescribePendingMaintenanceActions` with action type, target window, age.

### Engine Version

Current vs latest minor / latest major. Flag EOL.

### Cost Summary

- Latest-month estimated cost for this resource (proportional split, with "estimated" badge)
- RI coverage status
- Top 3 cost-optimization opportunities (linked to findings)

### Priority Matrix

| # | Finding | Severity | Pillar | Effort | Impact |

### Next Steps

- Immediate (CRITICAL/HIGH — 7 days)
- Short-term (MEDIUM — 30 days)
- Long-term (LOW — 90 days)

### Appendix — Reference Links

- [Amazon RDS Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html)
- [Amazon Aurora Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_BestPractices.html)
- [Monitoring RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Monitoring.html)
- [Performance Insights](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.html)
- [Encrypting RDS Resources](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html)
- [Multi-AZ DB Instance Deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)
- [Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)

## Severity Definitions

| Severity | Definition                                                  | SLA                     |
| -------- | ----------------------------------------------------------- | ----------------------- |
| CRITICAL | Immediate risk to availability, security, or data integrity | Fix within 24–48 hours  |
| HIGH     | Significant gap that could lead to incidents                | Fix within 1 week       |
| MEDIUM   | Notable improvement opportunity                             | Plan within 30 days     |
| LOW      | Minor optimization or hardening                             | Address when convenient |
| INFO     | Observation, no action required                             | N/A                     |

## Engine-Specific Considerations

- **MySQL / MariaDB** — `innodb_buffer_pool_size`, `max_connections`, slow query log,
  binlog retention, deprecated `query_cache_type` on 8.0+.
- **PostgreSQL** — `shared_buffers`, `work_mem`, autovacuum, `pg_stat_statements`,
  `log_min_duration_statement`, replication slots.
- **Oracle** — BYOL tracking, SGA/PGA sizing, AWR, tablespace autoextend.
- **SQL Server** — tempdb file count (1 per vCPU up to 8), MAXDOP, cost threshold for
  parallelism, Always On AGs vs Multi-AZ.
- **Aurora** — Serverless v2 ACU floor/ceiling, Global Database for DR, fast clones,
  Backtrack (MySQL only), cluster cache management.

## Known API Quirks (recorded so the agent doesn't trip on them)

- `rds.ListTagsForResource` — parameter is `ResourceName`, **value is the resource ARN**.
- `rds.DescribeEvents` — `Duration` is in **minutes** (20160 = 14 days).
- `applicationautoscaling.DescribeScalableTargets` — `ServiceNamespace="rds"` covers Aurora replica autoscaling.
- `logs.DescribeLogGroups` prefix differs:
  - Instances: `/aws/rds/instance/<id>/`
  - Aurora clusters: `/aws/rds/cluster/<id>/`
- Some Aurora metrics are cluster-only (`AuroraReplicaLag`, `BufferCacheHitRatio`,
  `VolumeReadIOPs`), others are instance-only (`FreeableMemory`, `CPUUtilization` per
  member). Query the right dimension or both.
- `rds.DescribeDBSnapshots` requires pagination for accounts with many snapshots —
  use `MaxRecords` and `Marker`.

## Data Source Boundaries

This skill explicitly does **not** call:

- Kubernetes API / `k8s` MCP — RDS is fully managed; no cluster API exists.
- `eks` MCP — outside scope.
- Dante or any non-AWS scripts — keep the skill self-contained on the AWS DevOps Agent's primary cloud-source IAM role.

If a customer needs deeper SQL-level analysis (e.g. Performance Insights `db.load`
breakdowns, top SQL by wait event), call `pi.GetResourceMetrics` and
`pi.DescribeDimensionKeys` directly — both are in the same `rds` permission family
when Performance Insights is enabled.
