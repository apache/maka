---
name: database-migration-service-expertise
description: AWS Database Migration Service (DMS) operational review and troubleshooting
  skill. Conducts best practices validation, health assessments, performance diagnostics,
  cost optimization reviews, and migration cutover guidance. Triggers on requests like
  "DMS review", "DMS health check", "DMS troubleshooting", "migration assessment",
  "DMS best practices audit", "DMS cost optimization", "replication instance review",
  "CDC latency issue", or "DMS task failure".
metadata:
  author: tabhiman
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "AWS Database Migration Service"
  aws-devops-agent-skills.technical-domains: "Database"
---

# AWS DMS Operational Review & Troubleshooting

Conduct comprehensive operational reviews, best practices validation, troubleshooting,
and cost optimization assessments for AWS Database Migration Service (DMS) environments
aligned with AWS Well-Architected principles.

## When to Use

Activate this skill when the user asks to:

- Review, audit, or assess DMS configurations
- Check DMS best practices compliance
- Troubleshoot DMS task failures, latency, or connectivity issues
- Evaluate DMS cost optimization opportunities
- Plan or execute a database migration cutover
- Assess DMS version deprecations and upgrade paths
- Run a pre-migration assessment
- Evaluate DMS Serverless vs provisioned suitability
- Investigate data validation mismatches
- Review DMS homogeneous data migration options

## Step 1: Identify Target Resources

Ask the user which DMS resources to review. Accept:

- Specific replication instance names and regions
- Specific replication task identifiers
- "all instances" in a specific region
- "all instances in all regions"

Query AWS APIs to discover DMS resources:

- List replication instances across the configured account regions
- List replication tasks and their states
- List endpoints and connectivity status

## Step 2: Collect DMS Configuration

For EACH replication instance and its associated tasks, gather the following data using AWS APIs.

### 2.1 Replication Instance Config

Engine version, instance class, Multi-AZ, storage, public accessibility, KMS encryption, auto-upgrade, VPC/subnet configuration, pending maintenance actions.

```bash
aws dms describe-replication-instances --profile <profile> --region <region>
aws dms describe-pending-maintenance-actions --profile <profile> --region <region>
```

### 2.2 Replication Tasks

Task identifiers, status, migration type, table mappings, task settings, CDC start positions, last failure messages, stop reasons, replication task statistics.

```bash
aws dms describe-replication-tasks --profile <profile> --region <region>
```

### 2.3 Endpoints

Endpoint identifiers, types (source/target), engine names, SSL mode, connection status, Secrets Manager integration, security group configurations.

```bash
aws dms describe-endpoints --profile <profile> --region <region>
aws dms describe-connections --filter Name=endpoint-arn,Values=<endpoint-arn> --profile <profile> --region <region>
```

### 2.4 Table Statistics

Per-table state, row counts, validation state, error rows, DDL counts.

```bash
aws dms describe-table-statistics --replication-task-arn <task-arn> --profile <profile> --region <region>
```

### 2.5 DMS Serverless (if applicable)

Replication configs, serverless replications, DCU utilization.

```bash
aws dms describe-replication-configs --profile <profile> --region <region>
aws dms describe-replications --profile <profile> --region <region>
```

### 2.6 Version and Deprecation Data

Available engine versions, pending maintenance actions, AWS Health events.

```bash
aws dms describe-orderable-replication-instances --query "OrderableReplicationInstances[*].EngineVersion" --profile <profile> --region <region>
aws health describe-events --filter '{"services":["DMS"],"eventTypeCategories":["scheduledChange"]}' --profile <profile> --region us-east-1
```

> **Note:** AWS Health API is a global service and must be called with `--region us-east-1` regardless of where DMS resources are deployed.

## Step 3: Collect Observability Data (7-Day Historical)

### 3.1 CloudWatch Metrics (7 days)

**Replication Instance Metrics** (namespace: AWS/DMS):

- CPUUtilization (Average, Maximum)
- FreeableMemory (Average, Minimum)
- SwapUsage (Average, Maximum)
- DiskQueueDepth (Average, Maximum)
- ReadIOPS / WriteIOPS (Average, Maximum)
- ReadLatency / WriteLatency (Average, Maximum)
- NetworkTransmitThroughput (Average)
- NetworkReceiveThroughput (Average)

**Task Metrics** (namespace: AWS/DMS):

- CDCLatencySource (Average, Maximum)
- CDCLatencyTarget (Average, Maximum)
- CDCIncomingChanges (Average, Maximum)
- CDCChangesMemorySource (Average, Maximum)
- CDCChangesDiskSource (Maximum)
- CDCChangesDiskTarget (Maximum)
- FullLoadThroughputBandwidthTarget (Average)
- FullLoadThroughputRowsTarget (Average)

**DMS Serverless** (namespace: AWS/DMS, if applicable):

- ServerlessTotalCapacityUnits (Average, Maximum)

### 3.2 CloudWatch Logs (7 days)

Query task logs for error patterns:

- `ERROR` — general errors (count)
- Network/connectivity errors (`Network error`, `Connection lost`, `timeout`)
- Memory/resource errors (`out of memory`, `OOM`, `swap`)
- CDC-specific errors (WAL, binlog, LogMiner patterns)
- Data/constraint errors (`truncation`, `constraint`, `duplicate key`)

### 3.3 AWS Health Events

Query DMS scheduled changes and deprecation notices:

- Upcoming engine version deprecations
- Pending mandatory maintenance actions
- Certificate expirations

## Step 4: Analyze Against Best Practices

Evaluate ALL collected data against these categories. Assign severity to every finding: CRITICAL, HIGH, MEDIUM, LOW, or INFO.

Reference: `references/dms-best-practices.md` for detailed best practices.
Reference: `references/dms-validation-checklist.md` for validation criteria and thresholds.
Reference: `references/dms-version-reference.md` for version lifecycle and known issues.

### 4.1 Instance Health (25 points)

- Instance status (must be "available")
- Engine version currency (EOL → CRITICAL; not on latest or latest-1 active version → HIGH)
- Instance class appropriate (CPU < 80%, Memory > 20% free)
- Multi-AZ for production CDC tasks
- Storage utilization (< 80%)
- Not publicly accessible
- KMS encryption enabled
- Auto minor version upgrade enabled (non-prod)

### 4.2 Task Health (25 points)

- Task status (running/stopped, not failed/error)
- No tables in error/suspended state
- Logging enabled on all tasks
- CDC latency within thresholds (< 120s)
- Recovery checkpoint exists
- No full load error rows
- Task settings follow best practices (LOB mode, parallelism, batch apply)

### 4.3 Endpoint Security (20 points)

- SSL/TLS enabled on all endpoints (SslMode != "none")
- Secrets Manager integration for credentials
- Connection tests passing
- Security groups restrict access (no 0.0.0.0/0)
- VPC endpoints configured for AWS services
- Private subnet placement (not publicly accessible)

### 4.4 Performance (15 points)

- CPU utilization within thresholds (< 80% avg)
- Freeable memory adequate (> 2 GB minimum)
- No swap usage (SwapUsage = 0)
- Disk queue depth normal (< 10)
- No sustained disk-based CDC caching (CDCChangesDisk* = 0)
- CDC throughput adequate for workload

### 4.5 Cost Efficiency (15 points)

- No over-provisioned instances (CPU avg > 20% for 7+ days)
- No idle instances (no running tasks for 7+ days)
- Multi-AZ justified (production/critical only)
- Debug logging disabled in production
- Same-engine migrations using homogeneous/native tools where applicable
- DMS Serverless evaluated for variable workloads

## Step 5: Troubleshooting (When Applicable)

When the user reports an active issue, follow this structured approach:

### Phase 0: Version Check (Always First)

Check DMS engine version and cross-reference with `references/dms-version-reference.md` for known bugs.

### Phase 1: Error Classification

Route by error category:

| Error Pattern                             | Category            | Diagnostic Path      |
| ----------------------------------------- | ------------------- | -------------------- |
| Network error, Connection lost, timeout   | Connectivity        | Network diagnostics  |
| Memory, OOM, swap, disk full              | Resource Exhaustion | Instance metrics     |
| CDCLatency, falling behind                | Performance/Latency | CDC metrics analysis |
| Data truncation, type mismatch            | Data Mismatch       | Table statistics     |
| Table error, suspended, DDL               | Table-Level Failure | Table reload         |
| Credential, authentication, access denied | Auth/Permissions    | Endpoint test        |
| SSL, certificate, handshake               | SSL/TLS             | Certificate check    |
| Task stops without clear error            | Silent Failure      | Comprehensive check  |

### Phase 2: Targeted Diagnostics

Follow the appropriate diagnostic path using AWS CLI commands to gather evidence.

### Phase 3: Log Analysis

Query CloudWatch Logs with engine-specific filter patterns (Oracle/PostgreSQL/MySQL/SQL Server).

## Step 6: Migration Cutover Guidance (When Applicable)

When the user is planning or executing a cutover:

### Pre-Cutover Checklist (T-7 to T-1 days)

- CDC latency at zero
- No tables in error
- Validation passing
- No pending maintenance
- Instance resources healthy
- Recovery checkpoint exists
- Target schema matches source
- Application connection strings prepared
- Rollback plan documented

### Cutover Execution (T-0)

1. Final latency check
2. Stop application writes to source
3. Wait for CDC to drain (zero latency)
4. Run final validation
5. Stop DMS task
6. Switch application to target
7. Validate application
8. Monitor (T+0 to T+24h)

### Rollback Procedure

Documented steps to revert to source if cutover fails.

### Post-Cutover Cleanup (T+3 to T+7 days)

Resource deletion and documentation updates.

## Step 7: Generate Report

**Generate a separate shareable report artifact for EACH environment reviewed.**

Artifact naming: `dms-review-<instance-name>-<YYYY-MM-DD>.md`
Example: `dms-review-prod-replication-2026-07-22.md`

For each environment, create the artifact as a Markdown document with these sections:

### Report Header

```
# DMS Operational Review — <instance-name>
Account: <account-id> | Region: <region> | Date: <YYYY-MM-DD> | Engine Version: <version>
```

### Executive Summary

- Environment health: ✅ HEALTHY / ⚠️ WARNINGS / ❌ CRITICAL
- Health Score: XX/100 [Rating]
- Finding counts by severity
- Top 3 critical/high items

### Health Score Breakdown

| Category          | Score | Key Issues    |
| ----------------- | ----- | ------------- |
| Instance Health   | XX/25 | [list issues] |
| Task Health       | XX/25 | [list issues] |
| Endpoint Security | XX/20 | [list issues] |
| Performance       | XX/15 | [list issues] |
| Cost Efficiency   | XX/15 | [list issues] |

### Resource Inventory

| Resource Type | Count | Status Summary |
| ------------- | ----- | -------------- |

### Findings by Category

For each of the 5 categories above, present:

| #   | Finding | Severity | Current State | Recommendation |
| --- | ------- | -------- | ------------- | -------------- |

### CloudWatch Metrics (7-Day)

| Metric | Category | 7-Day Avg | 7-Day Max | Status | Finding |
| ------ | -------- | --------- | --------- | ------ | ------- |

### CloudWatch Logs Analysis (7-Day)

| Pattern | Occurrences | Severity | Finding |
| ------- | ----------- | -------- | ------- |

### Version & Deprecation Status

All instances with version, EOL status, upgrade recommendations.

### Cost Optimization Opportunities

| #   | Opportunity | Resource | Estimated Savings | Risk Level |
| --- | ----------- | -------- | ----------------- | ---------- |

### Priority Matrix

| #                                | Finding | Severity | Category | Effort | Impact |
| -------------------------------- | ------- | -------- | -------- | ------ | ------ |
| All findings sorted by severity. |

### Next Steps

- Immediate (CRITICAL/HIGH — 7 days)
- Short-term (MEDIUM — 30 days)
- Long-term (LOW — 90 days)

### Appendix

Refer to the AWS DMS documentation for detailed guidance on best practices, monitoring, troubleshooting, release notes, serverless, and data validation.

## Severity Definitions

| Severity | Definition                                                           | SLA                     |
| -------- | -------------------------------------------------------------------- | ----------------------- |
| CRITICAL | Immediate risk to migration integrity, data loss, or security breach | Fix within 24-48 hours  |
| HIGH     | Significant gap that could lead to task failures or data issues      | Fix within 1 week       |
| MEDIUM   | Notable improvement opportunity for performance or cost              | Plan within 30 days     |
| LOW      | Minor optimization or hardening                                      | Address when convenient |
| INFO     | Observation, no action required                                      | N/A                     |

## Health Score Formula

### Scoring Categories (100 points total)

| Category          | Weight | Scope                                                         |
| ----------------- | ------ | ------------------------------------------------------------- |
| Instance Health   | 25 pts | Status, version, Multi-AZ, public access, storage, encryption |
| Task Health       | 25 pts | Task status, table errors, CDC latency, logging               |
| Endpoint Security | 20 pts | SSL mode, Secrets Manager, connectivity, SG rules             |
| Performance       | 15 pts | CPU, memory, swap, disk queue, CDC throughput                 |
| Cost Efficiency   | 15 pts | Right-sizing, idle resources, Multi-AZ justification          |

### Score Interpretation

| Score  | Rating             | Action                                      |
| ------ | ------------------ | ------------------------------------------- |
| 90-100 | 🟢 Excellent       | Minor optimizations only                    |
| 75-89  | 🟡 Good            | Address warnings at next opportunity        |
| 60-74  | 🟠 Needs Attention | Plan remediation within 1-2 weeks           |
| 40-59  | 🔴 Poor            | Immediate action required on critical items |
| 0-39   | ⚫ Critical        | Migration at risk — escalate immediately    |
