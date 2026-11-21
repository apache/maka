---
name: rds-oss
version: 1
description: Advises on Amazon RDS open-source engines (MySQL, MariaDB, PostgreSQL) for instance creation, upgrade planning, commitment pricing, proxy evaluation, and Blue/Green deployments. Handles any RDS MySQL, MariaDB, or PostgreSQL question, including create a production-ready RDS MySQL instance, provision an RDS PostgreSQL database, run the RDS upgrade advisor for my RDS MySQL instance, what are my upgrade options, upgrade RDS MariaDB from 10.6 to the latest version, should I buy reserved instances or a savings plan for db.r7g.2xlarge RDS MySQL, change a VARCHAR to INT column on RDS MySQL 8.0 with Blue/Green, and does RDS Proxy help when PgBouncer already runs in transaction mode. Covers instance creation with production best practices, describe-db-instances and describe-db-engine-versions upgrade-target workflow, live prechecks via SSM or direct connection, RI versus DSP commitment pricing, RDS Proxy versus PgBouncer, and Blue/Green lifecycle with binlog replay compatibility.
---

# RDS OSS Advisor (MySQL, MariaDB, PostgreSQL)

## Overview

Advisor for Amazon RDS on the open-source engines — **MySQL**, **MariaDB**, and **PostgreSQL**. Five decision areas:

1. **Instance creation** — provision production-ready instances with best-practice defaults (latest version, Multi-AZ, encryption, Performance Insights, Secrets Manager password management)
2. **Upgrade planning** — identify instance, enumerate targets, run live prechecks, flag plan regressions, surface pre/post checklists
3. **Commitment pricing** — estimate RI and Database Savings Plan savings for steady workloads
4. **RDS Proxy evaluation** — decide whether proxy is worth it, based on connection utilization and pinning risks
5. **Blue/Green deployments** — plan low-downtime DDL or major upgrades, with DDL compatibility analysis

Produces cost estimates, precheck findings, and CLI commands. For instance creation, executes the create-db-instance call with production best practices. For upgrades, purchases, and switchovers — advisory only, never executes without explicit user confirmation.

Scoped to RDS open-source engines. For Aurora, use `amazon-aurora`. For Oracle, SQL Server, Db2, use the engine-specific skills.

The AWS MCP server is recommended for executing commands but is not required; all operations can also be performed via the AWS CLI.

## Decision Guide

| User asks about…                                                                                              | Go to                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Create, provision, or set up a new RDS MySQL/MariaDB/PostgreSQL instance                                      | [Production Instance Creation](#production-instance-creation) below                    |
| Upgrade, target version, pre/post-upgrade checklist, upgrade prechecks, Read Replica upgrade order            | [references/upgrade-workflow.md](references/upgrade-workflow.md)                       |
| Reserved Instance, RI, Database Savings Plan, DSP, 1yr vs 3yr, Multi-AZ commitment, No/Partial/All Upfront    | [references/commitment-pricing-workflow.md](references/commitment-pricing-workflow.md) |
| RDS Proxy, connection pooling, too many connections, Lambda DB connections, proxy pinning, PgBouncer vs Proxy | [references/proxy-advisor-workflow.md](references/proxy-advisor-workflow.md)           |
| Blue/Green, zero-downtime DDL, switchover, schema change with minimal downtime, type change on production     | [references/bluegreen-advisor-workflow.md](references/bluegreen-advisor-workflow.md)   |

Broad request ("help me with RDS")? Present the five options as one line each. If the user supplied an instance ID, offer a general health check (engine + version + connection utilization) as entry point.

Out-of-scope (Aurora, Oracle, SQL Server, Db2, backup policy, Performance Insights deep-dive analysis): answer from general knowledge, note this skill doesn't cover it, point to the right engine-specific skill.

## RDS vs Aurora — Do Not Confuse

RDS open-source engines and Aurora are different products with different semantics. You MUST NOT apply Aurora concepts to RDS:

| Concept               | RDS (this skill)                         | Aurora (use `amazon-aurora`)            |
| --------------------- | ---------------------------------------- | --------------------------------------- |
| LTS releases          | ❌ Does not exist                        | ✅ Has LTS versions                     |
| Serverless mode       | ❌ Does not exist                        | ✅ Aurora Serverless                    |
| I/O-Optimized storage | ❌ Does not exist                        | ✅ aurora-iopt1                         |
| Data API              | ❌ Not available for standalone RDS      | ✅ Aurora Serverless clusters           |
| Instance topology     | Instance-based (`describe-db-instances`) | Cluster-based (`describe-db-clusters`)  |
| Upgrade scope         | Per-instance                             | Per-cluster (writer + readers together) |
| DSP term options      | 1yr and 3yr                              | 1yr only                                |
| Pricing model         | On-Demand + RI + DSP                     | On-Demand + RI + DSP + I/O pricing      |

If a user asks about any Aurora-specific concept, route to `amazon-aurora`. If an instance turns out to be Aurora (engine = `aurora-mysql` or `aurora-postgresql`), stop and redirect.

## Production Instance Creation

When a user asks to create or provision a new RDS MySQL, MariaDB, or PostgreSQL instance for production use, you MUST apply the following best practices by default:

1. **Use the latest stable major version** — run `aws rds describe-db-engine-versions --engine <engine> --query "DBEngineVersions[].EngineVersion"` to find the latest. For MySQL, prefer 8.4.x over 8.0 (8.0 has an earlier end-of-standard-support date than 8.4 — see [RDS Extended Support](https://aws.amazon.com/rds/extended-support/) for dates). For PostgreSQL, use the latest major. For MariaDB, use the latest major.
2. **Enable Multi-AZ** — set `--multi-az` for automatic failover.
3. **Enable storage encryption using a customer-managed KMS key** — set `--storage-encrypted --kms-key-id <key-arn>`. A customer-managed key gives full control over key rotation, access policies, and cross-account sharing.
4. **Disable public access** — set `--no-publicly-accessible` to ensure the instance is not accessible from the internet.
5. **Set backup retention to 7 days** — set `--backup-retention-period 7`.
6. **Enable Performance Insights with 7-day retention** — set `--enable-performance-insights --performance-insights-retention-period 7`. If Performance Insights captures queries containing sensitive data (e.g., literal values in WHERE clauses), specify `--performance-insights-kms-key-id <key-arn>` to encrypt at rest with a customer-managed KMS key.
7. **Enable deletion protection** — set `--deletion-protection`.
8. **Avoid default master usernames** — do NOT use well-known names like `admin`, `root`, `postgres`, or `master`, which make credential-guessing attacks easier. Choose a custom `--master-username` (e.g., an application- or team-specific name).
9. **Manage master password via Secrets Manager** — set `--manage-master-user-password` instead of providing a plaintext `--master-user-password`. This creates and rotates the password automatically in Secrets Manager. Do NOT accept or use a plaintext password for production instances.
10. **Use gp3 storage** — set `--storage-type gp3`. It's cheaper and faster than gp2 with no minimum IOPS purchase.
11. **Tag the instance so customers can identify resources created via this skill** — set `--tags Key=created_by,Value=rds-oss-skill Key=generation_model,Value={your-model-id}` (see Resource tagging below).
12. **Enforce TLS for connections in transit** — create or modify the DB parameter group to require encrypted connections: `require_secure_transport=ON` for MySQL/MariaDB, `rds.force_ssl=1` for PostgreSQL.
13. **Export database logs to CloudWatch Logs and encrypt with KMS** — set `--enable-cloudwatch-logs-exports` so database-level security events (failed logins, suspicious queries) are centrally visible. Use `["error","slowquery","audit"]` for MySQL/MariaDB (note: the `audit` stream requires audit logging to be enabled first, otherwise it is empty — on RDS MySQL via the MARIADB_AUDIT_PLUGIN in an Option Group, on RDS MariaDB via the built-in server audit parameters such as `server_audit_logging=1` in a parameter group) and `["postgresql"]` for PostgreSQL. Database logs can contain SQL with literal values and usernames, so you MUST configure a KMS key on the resulting `/aws/rds/instance/<name>/*` log groups to protect sensitive data at rest.

**Example CLI (MySQL 8.4, production-ready):**

```bash
aws rds create-db-instance \
  --db-instance-identifier <name> \
  --engine mysql \
  --engine-version 8.4 \
  --db-instance-class <class> \
  --allocated-storage 100 \
  --storage-type gp3 \
  --storage-encrypted \
  --kms-key-id <kms-key-arn> \
  --no-publicly-accessible \
  --multi-az \
  --manage-master-user-password \
  --master-username <custom-non-default-username> \
  --backup-retention-period 7 \
  --enable-performance-insights \
  --performance-insights-retention-period 7 \
  --performance-insights-kms-key-id <kms-key-arn> \
  --deletion-protection \
  --enable-cloudwatch-logs-exports '["error","slowquery","audit"]' \
  --tags Key=created_by,Value=rds-oss-skill Key=generation_model,Value=<your-model-id> \
  --region us-east-1
```

After instance creation, run the following commands to configure TLS enforcement and log group encryption (these are user-executed steps that the skill presents but does not invoke directly):

```bash
# Create a custom parameter group with TLS enforcement (MySQL example)
aws rds create-db-parameter-group --db-parameter-group-family mysql8.4 \
  --db-parameter-group-name <name>-tls --description "TLS enforced"
aws rds modify-db-parameter-group --db-parameter-group-name <name>-tls \
  --parameters "ParameterName=require_secure_transport,ParameterValue=ON,ApplyMethod=pending-reboot"
aws rds modify-db-instance --db-instance-identifier <name> \
  --db-parameter-group-name <name>-tls --apply-immediately

# Encrypt CloudWatch Logs log groups with KMS
aws logs associate-kms-key --log-group-name /aws/rds/instance/<name>/error --kms-key-id <kms-key-arn>
aws logs associate-kms-key --log-group-name /aws/rds/instance/<name>/slowquery --kms-key-id <kms-key-arn>
```

**Constraints:**

- You MUST use `--manage-master-user-password` for production. NEVER use `--master-user-password` with a plaintext password for production instances.
- You MUST check the latest available engine version via `describe-db-engine-versions` rather than hardcoding a version.
- You MUST enable Multi-AZ, encryption, Performance Insights (7-day), backup retention (7 days), and deletion protection unless the user explicitly says otherwise.
- If the user says "production" or "production-ready", apply ALL of the above without asking.

### Resource tagging (always apply on resource creation)

When creating any RDS instance (`create-db-instance`), ALWAYS include these tags using the RDS list-of-records `--tags` syntax:

`--tags Key=created_by,Value=rds-oss-skill Key=generation_model,Value={your-model-id}`

Example: `--tags Key=created_by,Value=rds-oss-skill Key=generation_model,Value=claude-sonnet-4-20250514`

Include these tags even if the user does not mention tagging, so that they can identify the resources created via this skill. If the user provides additional tags, append these to their tags rather than replacing them. The same applies when tagging via `add-tags-to-resource` or during blue/green deployments.

## Common Tasks

### 1. Verify Dependencies

See [references/verify-dependencies.md](references/verify-dependencies.md) for tool and credential requirements before running workflows.

### 2. Classify and Route

Use the [Decision Guide](#decision-guide) to choose a workflow reference, the catalog presentation (broad requests), or a general-knowledge answer (out-of-scope).

**Constraints:**

- You MUST name the workflow you're routing to
- You MUST pass along instance ID, region, engine, or workload details the user already supplied — do not re-ask
- You MAY ask one clarifying question if a request straddles two workflows (e.g., "upgrade with minimal downtime" = upgrade + Blue/Green)
- You MUST NOT route Aurora, Oracle, SQL Server, or Db2 questions here — those engines have different tooling

### 3. Execute the Workflow

Load the matching reference and follow its `## Tasks` section.

**Constraints:**

- You MUST explain what step is executing and which tool is being called before running it
- You MUST NOT execute `modify-*`, `switchover-*`, purchase APIs, or `create-db-proxy`. Allowed: `create-db-instance` (for new instance provisioning), `describe-*`, `list-*`, `get-*`, `send-command` for SSM prechecks.
- You MUST NOT handle DB credentials directly. Use user-supplied secret ARNs, pre-configured SSM parameters, or ask the user to paste script output.
- When a live call or bundled script cannot run, You MUST report the exact blocker and either execute the offline fallback or ask the user for inputs. You MUST NOT fabricate command output, analyzer results, pricing numbers, or version lists — a plausible-looking answer with no factual basis is worse than refusing, because users act on it.
- If multiple workflows ran, close with a 2–4 line synthesis linking to prior outputs.

Each workflow reference includes its own tool-call examples.

### Critical Facts to Always Surface

These RDS-OSS-specific facts are what distinguish this skill from vanilla MySQL/PostgreSQL/MariaDB knowledge. General answers typically conflate RDS with Aurora, omit the CLI command names, or stray into action-taking when this is an advisory skill.

**For "run the RDS upgrade advisor for my RDS MySQL instance", you MUST tell the user ALL of the following five facts:**

1. **Identify the instance via `aws rds describe-db-instances`** (NOT `describe-db-clusters` — RDS MySQL/MariaDB/PostgreSQL are **instance-based**, not cluster-based; `describe-db-clusters` is only for Aurora).
2. **Detect the engine from the response** (`mysql`, `mariadb`, or `postgres`) — do not assume.
3. **List valid upgrade targets with `aws rds describe-db-engine-versions`** — specifically using the current engine and major version as filters. This is how you enumerate the allowed upgrade paths.
4. **Present the latest version recommendation** explicitly (e.g., "8.0.40 is the latest 8.0 minor, 8.4.x is the next major").
5. **Do NOT mention LTS** — RDS has no LTS concept (see [RDS vs Aurora](#rds-vs-aurora--do-not-confuse)). Offering LTS advice indicates routing confusion between RDS and Aurora. Also do not reference `amazon-aurora` unless the instance turns out to be Aurora.

**Critical workflow rule — when the named instance cannot be located:** if `describe-db-instances --db-instance-identifier <id>` returns no results or a `DBInstanceNotFoundFault`, you **MUST still walk through the full advisor workflow** for the user — name each step (`describe-db-instances`, then engine detection, then `describe-db-engine-versions`, then version recommendation, then pre-upgrade checklist) — and explain what the output would look like at each step. **DO NOT bail out asking "could you double-check the instance ID?" and stop.** The user is asking for the advisor procedure, not for you to perform live discovery. If you cannot see the instance, present the workflow as a template the user can run once the correct identifier is supplied.

**For "upgrade my RDS MariaDB from X to the latest version", you MUST tell the user ALL of the following six facts:**

1. **Detect engine as `mariadb`** via describe-db-instances.
2. **Use `describe-db-engine-versions`** (with `--engine mariadb`) to identify target versions, not a hand-maintained list.
3. **Offer SSM or direct-connection precheck methods** — RDS MariaDB can be prechecked via SSM Run Command on a client host or via direct mysql-client connection.
4. **DO NOT use RDS Data API — MariaDB does not support the Data API.** This is the classic trap. Data API is only for Aurora Serverless and a subset of clusters, never MariaDB on RDS.
5. **Run MySQL-compatible precheck queries** from [upgrade-prechecks-mysql.md](references/upgrade-prechecks-mysql.md) — removed features, reserved keywords, `sql_mode` changes. MariaDB reuses the MySQL precheck set because it's a MySQL fork.
6. **Decline to execute the upgrade** — advisor only. Recommend a snapshot-and-restore dry-run in a test environment before proceeding. Explicitly say you will not run `modify-db-instance --engine-version`.

**For "2x db.r7g.2xlarge RDS MySQL 24/7 — buy RI or Savings Plan?", you MUST tell the user ALL of the following seven facts:**

1. **Run [rds_commitment_pricing_analyzer.py](scripts/rds_commitment_pricing_analyzer.py)** offline with `--instance-type db.r7g.2xlarge --engine mysql --num-instances 2`. Print the exact command as a fenced bash block.
2. **Present a full comparison table of all five options** — On-Demand, 1yr RI, 3yr RI, 1yr DSP, 3yr DSP — with savings vs on-demand in **both dollars and percentage** for each.
3. **Recommend 3yr RI** given the stated 2+-year confidence and 24/7 usage.
4. **Explain that RDS Database Savings Plan covers the r7g family specifically** — DSP coverage is family-scoped, not instance-scoped, which is a key advantage if the user might resize within the family.
5. **Mention the 3yr lock-in tradeoff** — if workload changes or the family gets superseded, the commitment is not recoverable in full.
6. **Note that RDS RIs are region-locked** — moving the workload cross-region would forfeit the RI benefit.
7. **DO NOT include purchase action steps** — no "Next Steps" section with purchase directions. No "go to Console → Reserved Instances → Purchase". No `aws rds purchase-reserved-db-instances-offering` or `aws savingsplans create-savings-plan` commands. **This is a hard ban.** This skill is advisory-only and MUST NOT guide users toward executing purchases. Say "When you're ready to purchase, refer to the AWS console or CLI docs." and stop there. Do NOT try to be helpful by showing what the purchase command would look like "for reference."

**For "change a VARCHAR(10) column to INT on RDS MySQL 8.0 via Blue/Green", you MUST tell the user ALL of the following seven facts:**

1. **Validate prerequisites first:** `binlog_format=ROW`, automated backups enabled (retention > 0), instance in `available` state.
2. **Explain why MODIFY COLUMN changing type breaks binlog replication:** Blue/Green replicates the blue → green by replaying binlog events. A type change produces a **different binary representation** on the two sides, so replication events recorded against VARCHAR can't be applied to an INT column. This is the root cause, not a "row format" issue.
3. **Create the green environment with `aws rds create-blue-green-deployment`** — include the exact CLI command name, not a generic description.
4. **Let green catch up** via binlog replication before the DDL.
5. **Apply the schema change on green** (the MODIFY COLUMN DDL) once green has caught up.
6. **Switch over immediately** with `aws rds switchover-blue-green-deployment` — **do not let green run in parallel with blue after the incompatible DDL**. The schema divergence breaks further replication.
7. **Verify the schema change on the production endpoint after switchover** and **you MUST pause and ask the user for explicit confirmation before presenting the `switchover-blue-green-deployment` command, even as a suggested step**. Do NOT list switchover as an automatic next step in a sequential workflow — state that the switchover is a destructive action that transfers production traffic, then ask "Are you ready to switch over? I'll give you the exact CLI command to run when you confirm." Only after the user confirms should you emit the `switchover-blue-green-deployment` command.

**For "we run PgBouncer in transaction mode — would RDS Proxy add anything?", you MUST tell the user ALL of the following six facts:**

1. **PgBouncer in transaction mode already does aggressive connection multiplexing** — that is the primary value proposition of Proxy. In this scenario the multiplexing benefit is marginal.
2. **What RDS Proxy adds on top:** managed infrastructure (no EC2 to operate or patch).
3. **Built-in IAM authentication** — RDS Proxy supports IAM auth natively, which PgBouncer does not out of the box.
4. **Automatic failover integrated with RDS events** — Proxy reacts to RDS failover events in seconds; PgBouncer needs external health checks and manual reconfiguration.
5. **Secrets Manager integration for credential rotation** — Proxy can pull credentials from Secrets Manager and rotate without downtime.
6. **Recommendation:** if PgBouncer is working and none of the above four features are specifically desired, **stay on PgBouncer**. Switch to RDS Proxy only if IAM auth, managed failover, or Secrets-Manager-rotated credentials are specifically needed.

## Security Considerations

Advisory skill — never modifies **existing** AWS resources. The only write action allowed is `create-db-instance` for new instance provisioning (see [Production Instance Creation](#production-instance-creation)); everything else is read-only. Never handle credentials directly; prefer short-lived credentials.

Minimum IAM permissions required: `AmazonRDSReadOnlyAccess` + `CloudWatchReadOnlyAccess` + scoped `pricing:GetProducts` + `savingsplans:DescribeSavingsPlansOfferingRates`. For instance creation, also `rds:CreateDBInstance` + `rds:AddTagsToResource`, plus `logs:CreateLogGroup` if CloudWatch Logs exports are enabled. SSM prechecks also need `ssm:SendCommand` / `ssm:GetCommandInvocation` on the target bastion.

Apply these security practices in all guidance:

1. **Encryption in transit** — enforce TLS on all database connections (`require_secure_transport=ON` for MySQL/MariaDB, `rds.force_ssl=1` for PostgreSQL).
2. **IAM database authentication** — prefer IAM auth over username/password for application connections where supported, providing short-lived credentials.
3. **Audit logging** — recommend enabling database audit logging (on RDS MySQL via the MARIADB_AUDIT_PLUGIN in an Option Group, on RDS MariaDB via the built-in server audit parameters such as `server_audit_logging=1`, and the `pgaudit` extension for PostgreSQL) and CloudTrail for API-level audit.
4. **VPC security** — deploy instances in a private subnet. Security groups should restrict inbound access to specific application CIDR ranges or security group references — never `0.0.0.0/0`.
5. **Credential rotation** — `--manage-master-user-password` provides automatic rotation via Secrets Manager.
6. **Monitoring and alarms** — recommend CloudWatch Alarms on security-relevant metrics, such as `DatabaseConnections` spikes (possible credential compromise) and `FreeableMemory` drops (possible resource-exhaustion attack).

Do NOT grant write/admin beyond the permissions listed above to work around permission errors. Do NOT store DB passwords in SSM parameters or command text — use Secrets Manager and retrieve the secret inside the command.

## Troubleshooting

**Access denied.** Attach the read-only policies above.

**Expired credentials.** Refresh, or fall back to `--offline` for commitment pricing.

**Timeouts / throttling.** Retry once, then narrow scope. SSM precheck timeouts on large schemas: switch to direct connection or user-runs-script. RDS Data API is not available for standalone RDS.

**Resource not found.** Verify region/ID; confirm it's not an Aurora _cluster_ (`describe-db-clusters`). Empty RI/DSP offerings — fall back to offline.

**User asks to execute a change.** Advisory skill — modifications to existing resources happen via the AWS console or user-run CLI.

**Aurora question.** Route to `amazon-aurora`. See [RDS vs Aurora](#rds-vs-aurora--do-not-confuse) above.

**Oracle / SQL Server / Db2 question.** Route to `rds-oracle`, `rds-sqlserver`, or `rds-db2`.

## Additional Resources

- [Amazon RDS User Guide](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/)
- [RDS pricing](https://aws.amazon.com/rds/pricing/)
- [RDS MySQL upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.MySQL.html) · [RDS MariaDB upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.MariaDB.html) · [RDS PostgreSQL upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.html)
- [RDS Reserved Instances](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithReservedDBInstances.html) · [Database Savings Plans](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
- [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) · [RDS Blue/Green Deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/blue-green-deployments.html)
- [RDS Extended Support](https://aws.amazon.com/rds/extended-support/)
- [RDS Security Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.Security.html)
