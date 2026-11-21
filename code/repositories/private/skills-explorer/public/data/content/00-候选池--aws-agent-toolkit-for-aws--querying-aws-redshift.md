---
name: querying-aws-redshift
description: >-
  Enables Redshift system-table (SYS_*) log publishing to S3 Tables in Apache
  Iceberg format for both Provisioned clusters and Serverless namespaces,
  verifies publishing status, and queries the published logs via any
  Iceberg-compatible engine including Redshift and Athena. Covers system tables
  such as sys_query_history, sys_query_text, sys_connection_log,
  sys_query_detail, and sys_session_history. Applies when turning on S3 Tables
  log publishing for a cluster or namespace, confirming publishing status and
  locating the S3 Tables namespace, querying non-realtime data from Redshift
  system tables off-cluster at scale, or building dashboards for Redshift
  monitoring and auditing, especially for historical or high-volume system-table data
  beyond the in-cluster SYS_ view retention window. Trigger phrases: publish
  redshift system table log to s3 tables, enable-logging s3 tables, describe
  redshift logging status, query redshift system tables in athena or redshift,
  redshift log exports to iceberg.
version: 1
argument-hint: "['enable CLUSTER'|'status CLUSTER'|'query SQL'|'configure']"
---

# Query AWS Redshift System Tables

## Overview

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) for sandboxed execution and audit logging. All commands below use the AWS CLI and work in any environment with configured AWS credentials. Use IAM roles or temporary credentials; avoid long-lived access keys.

Redshift can publish **system tables** — the `SYS_*` monitoring data such as `sys_query_history`, `sys_query_detail`, and `sys_connection_log` — to **S3 Tables** as continuously-updated Apache Iceberg tables.

Terminology used throughout: **system table** refers to a `SYS_*` dataset generally, and each one maps 1:1 to a published Iceberg table. Where this skill says **`SYS_` view**, it means specifically the live in-cluster object you query on the cluster itself — that is a view, and it is a different thing from the published S3 Tables copy. This applies to both **Provisioned clusters** and **Serverless namespaces**. It is an opt-in extension of the existing logging APIs. Published tables are read-only, stored in the AWS-managed `aws-redshift` table bucket, and queryable via any Iceberg-compatible engine including Amazon Athena and Amazon Redshift itself.

Querying the S3 Tables copy is preferred over the live in-cluster `SYS_` views when analyzing historical or high-volume system-table data because:

- The in-cluster `SYS_` views have a limited retention window; S3 Tables retains history well beyond it.
- Querying S3 Tables adds **no load** to the running Redshift cluster.
- The logs are Iceberg tables, so they can be queried at scale from any Iceberg-compatible engine and joined with other lake data.

## Decision Tree

| User intent                                                               | Use this skill? | Alternative                                   |
| ------------------------------------------------------------------------- | --------------- | --------------------------------------------- |
| Turn on S3 Tables log publishing for a cluster or namespace               | **Yes**         | —                                             |
| Confirm a cluster/namespace is publishing / find its S3 Tables namespace  | **Yes**         | —                                             |
| Querying non-realtime data from Redshift system tables                    | **Yes**         | —                                             |
| Build daily/weekly/monthly dashboard for Redshift monitoring and auditing | **Yes**         | —                                             |
| Selectively stop S3 Tables publishing                                     | **Yes**         | —                                             |
| Query published system tables from Redshift (cross-database)              | **Yes**         | —                                             |
| Query published system tables from Athena                                 | **Yes**         | —                                             |
| Inspect the _current, real-time_ `SYS_` state on a live cluster           | **No**          | Query the `SYS_` view on the cluster directly |
| Query data _inside_ customer tables                                       | **No**          | Direct Redshift SQL on the cluster            |

## Supported Data Sources

| Compute type                  | Enable / disable API                                                             | Status API                          | Granularity options              |
| ----------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| Redshift Provisioned cluster  | `redshift enable-logging` / `redshift disable-logging`                           | `redshift describe-logging-status`  | `cluster` (default), `account`   |
| Redshift Serverless namespace | `redshift-serverless update-namespace` with `--s3-table-action Enable`/`Disable` | `redshift-serverless get-namespace` | `namespace` (default), `account` |

Both compute types publish into the same AWS-managed `aws-redshift` table bucket and are queried identically once published. They differ only in the enable/disable API surface and in the casing of the status response — see the flag and field tables in [Common Tasks](#common-tasks).

Not covered by this skill: Redshift audit logs delivered to S3 or CloudWatch (`useractivitylog`, `userlog`, `connectionlog`), which use the separate `--log-exports` mechanism on Serverless and are not `SYS_*` system tables.

## Common Tasks

### 1. Check If Configured

Before querying, confirm the cluster or namespace is publishing to S3 Tables.

```bash
# Provisioned
aws redshift describe-logging-status --region <REGION> --cluster-identifier <CLUSTER_ID>
# Serverless
aws redshift-serverless get-namespace --region <REGION> --namespace-name <NAMESPACE_NAME>
```

**Interpret the response.** The two compute types return the _same_ information under **different field names and casing** — Provisioned uses PascalCase under `S3Tables`, Serverless uses camelCase under `namespace.s3TablePublishStatus`:

| Meaning                                                   | Provisioned (`describe-logging-status`)             | Serverless (`get-namespace`)                                                |
| --------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| Not enabled                                               | `LoggingEnabled: false` or no `S3Tables` block      | no `s3TablePublishStatus` block                                             |
| Destination includes S3 Tables                            | `LogDestinationType` contains `s3table`             | `logDestinationType` contains `s3table`                                     |
| List of published `SYS_*` tables                          | `S3Tables.S3Tables`                                 | `namespace.s3TablePublishStatus.s3Tables`                                   |
| **The exact S3 Tables namespace** (required for querying) | `S3Tables.S3TableNamespace`                         | `namespace.s3TablePublishStatus.s3TableNamespace`                           |
| Granularity                                               | `S3Tables.S3TableGranularity` (`cluster`/`account`) | `namespace.s3TablePublishStatus.s3TableGranularity` (`namespace`/`account`) |
| Per-table last ingest time                                | `S3Tables.LastIngestionTimes`                       | `namespace.s3TablePublishStatus.lastIngestionTimes`                         |
| All available system tables published                     | `S3Tables.EnabledAll`                               | `namespace.s3TablePublishStatus.enabledAll`                                 |

Notes:

- `LogDestinationType` is a **comma-joined list** when more than one destination is active — e.g. `"cloudwatch,s3table"`. Test with a substring/contains check, not equality against `s3table`.
- An empty `LastIngestionTimes` / `lastIngestionTimes` map, or a table listed as published but absent from the map, means data for that table may still be in flight. Compare successive values to confirm new data is landing.
- On Serverless, do **not** read the top-level `logExports` field for this feature — that field carries the CloudWatch/S3 audit logs (`useractivitylog`, `userlog`, `connectionlog`) and is unrelated to `SYS_*` S3 Tables publishing.

### 2. Enable (if not configured)

```bash
# Provisioned
aws redshift enable-logging --region <REGION> --cluster-identifier <CLUSTER_ID> --log-destination-type s3table --log-exports <SYS_TABLE>... --s3-table-granularity <cluster|account> --s3-table-kms-key-id <KMS_KEY_ARN>
# Serverless
aws redshift-serverless update-namespace --region <REGION> --namespace-name <NAMESPACE_NAME> --log-destination-type s3table --s3-table-names <SYS_TABLE>... --s3-table-action Enable --s3-table-granularity <namespace|account> --s3-table-kms-key-id <KMS_KEY_ARN>
```

`--s3-table-kms-key-id` is part of both commands deliberately, not an optional add-on. Omitting it does not fail — the tables fall back to an AWS-owned key you cannot audit, restrict by policy, or revoke. Because `SYS_*` tables carry `query_text`, `user_name`, and `remote_host`, treat the customer-managed key as the default and drop the flag only for throwaway environments.

Enable from AWS console Amazon Redshift Console > Clusters > select your cluster > Tabs > Integrations / System table integration

**The two compute types take different flags for the same feature.** Do not carry Provisioned flag names over to Serverless:

| Purpose                        | Provisioned (`enable-logging`)                           | Serverless (`update-namespace`)                   |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------- |
| Which system tables to publish | `--log-exports`                                          | `--s3-table-names`                                |
| Enable vs disable              | separate `enable-logging` / `disable-logging` operations | `--s3-table-action Enable` \| `Disable`           |
| Granularity                    | `--s3-table-granularity` `cluster` \| `account`          | `--s3-table-granularity` `namespace` \| `account` |
| Customer-managed KMS key       | `--s3-table-kms-key-id`                                  | `--s3-table-kms-key-id`                           |
| Validate without applying      | `--dry-run`                                              | `--dry-run`                                       |

Notes:

- Granularity: Provisioned supports `cluster` (default) or `account`; Serverless supports `namespace` (default) or `account`.
- `cluster`/`namespace` granularity → one S3 table per cluster/namespace; `account` → one shared table for all clusters/namespaces per account per region.
- Use `all` to publish all available `SYS_*` tables — `--log-exports all` on Provisioned, `--s3-table-names all` on Serverless.
- **Encryption at rest is strongly recommended for production.** Without `--s3-table-kms-key-id` the published tables are encrypted with an AWS-owned key, which you cannot audit, restrict by policy, or revoke. `SYS_*` tables carry `query_text`, `user_name`, and `remote_host` (see [Security Considerations](#security-considerations)), so pass a customer-managed key. Grant key access using the complete key policy in `${SKILL_DIR}/references/security.md` rather than an abbreviated action list — it needs **two** service principals (`systemtables.redshift.amazonaws.com` for publishing and `maintenance.s3tables.amazonaws.com` for table maintenance/compaction). Provisioning only the publishing principal lets writes succeed while compaction silently fails.
- Both operations accept `--dry-run` to validate the request without changing anything. Provisioned returns a `DryRunOperation` error on success ("Request would have succeeded, but DryRun flag is set"); Serverless returns an empty body and exit code 0. Note that the Serverless dry-run validates request _shape_ only, not parameter values, so a successful dry-run there does not guarantee the values are accepted.

**Disable selectively:**

```bash
# Provisioned
aws redshift disable-logging --region <REGION> --cluster-identifier <CLUSTER_ID> --log-destination-type s3table --log-exports <SYS_TABLE>...
# Serverless
aws redshift-serverless update-namespace --region <REGION> --namespace-name <NAMESPACE_NAME> --log-destination-type s3table --s3-table-names <SYS_TABLE>... --s3-table-action Disable
```

### 3. Verify Permissions

Full setup commands for both paths: **`${SKILL_DIR}/references/permissions-setup.md`**. Load it before creating roles or registering resources.

**Athena path** — needs the `s3tablescatalog/aws-redshift` catalog registered in Glue, a workgroup with an output location, and S3 Tables read permissions. Confirm the catalog is queryable:

```bash
aws glue get-databases --region <REGION> \
  --catalog-id "<ACCOUNT>:s3tablescatalog/aws-redshift"
```

Namespaces returned → registered and queryable. `EntityNotFoundException` / `CATALOG_NOT_FOUND` → the S3 Tables integration is not enabled (S3 console > Table buckets > Enable integration). **Encrypt the workgroup output location** — Athena writes full result sets, including `query_text` and `user_name`, to S3.

**Redshift auto-mount path** — needs a Provisioned RA3 cluster and a four-step setup: create the `query_s3_tables` role (trust policy must name _both_ `redshift.amazonaws.com` and `lakeformation.amazonaws.com`, the latter with all four of `sts:AssumeRole`, `sts:SetContext`, `sts:SetSourceIdentity`, `sts:TagSession`), attach it to the cluster, register the table bucket with Lake Formation, and add the Redshift service-linked roles to `ReadOnlyAdmins`. Constraints that cause most failures:

- **Condition both trust statements on `aws:SourceAccount`** — a bare service principal is a confused-deputy risk.
- **Do not attach `AWSLakeFormationDataAdmin` to the cluster's query role.** It is needed only by the principal performing setup, and only during setup. The cluster's role needs read access alone.
- **Auto-mount is a poll, not a callback** — the catalog can take up to 300 seconds to appear in `pg_database`. A cluster reboot forces immediate discovery.

### 4. Identify the Target Table

**Namespace** — resolve it from the API, do not construct it:

- Read `S3Tables.S3TableNamespace` from `describe-logging-status` (Provisioned) or `s3TablePublishStatus.s3TableNamespace` from `get-namespace` (Serverless) and use it verbatim.
- Optional sanity check only: the API value typically follows `<namespace_arn_id>_sys` for `cluster`/`namespace` granularity and `<account>_sys` for `account` granularity. Use this only to _verify_ the value looks right — never to generate the namespace when the API response is unavailable.

**Table** — each publishable system table maps 1:1 to a table in the `aws-redshift` table bucket. Do **not** work from a memorized list — resolve it at runtime, in this order:

1. **The published set for this cluster/namespace** — `S3Tables.S3Tables` (Provisioned) or `s3TablePublishStatus.s3Tables` (Serverless) from the status call above, e.g. `sys_query_history`. This is the only authoritative answer to "what can I query right now".
2. **The set this API accepts** — `aws redshift enable-logging help` (accepted `--log-exports` values) or `aws redshift-serverless update-namespace help` (accepted `--s3-table-names` values).
3. **What each table contains** — the public [Redshift SYS monitoring views reference](https://docs.aws.amazon.com/redshift/latest/dg/cm_chap_system-tables.html), which documents every `SYS_*` view and its columns. AWS adds views over time, so treat the docs as the current list rather than hardcoding one.

Column names and types come from the same public reference, or from the live table:

```bash
aws glue get-table --region <REGION> \
  --catalog-id "<ACCOUNT>:s3tablescatalog/aws-redshift" \
  --database-name "<NAMESPACE>" --name "<SYS_TABLE>"
```

Two caveats when reading the public docs against a published table: enum-valued columns (`query_type`, `status`, `event`) gain values over time, so confirm with `SELECT DISTINCT` rather than filtering on an assumed set; and the published Iceberg table prepends warehouse-identity columns (`warehouse_name`, `warehouse_namespace_arn`, and peers) that the in-cluster `SYS_` view does not have — they are how you tell apart multiple clusters publishing at `account` granularity.

### 5. Query

#### Query from Athena

**Query syntax:**

```sql
"s3tablescatalog/aws-redshift"."<NAMESPACE>"."<SYS_TABLE>"
```

#### Query from Redshift (Auto-Mounted Catalog)

Once the auto-mounted catalog is set up (see `${SKILL_DIR}/references/permissions-setup.md`), query using cross-database notation:

```sql
"aws-redshift@s3tablescatalog"."<NAMESPACE>".<SYS_TABLE>
```

#### Query from Redshift (External Schema)

Alternatively, create an external schema pointing to the S3 Tables catalog:

```sql
CREATE EXTERNAL SCHEMA <schema_name>
FROM DATA CATALOG
DATABASE '<NAMESPACE>'
CATALOG_ID '<ACCOUNT>:s3tablescatalog/aws-redshift'
IAM_ROLE 'arn:aws:iam::<ACCOUNT>:role/query_s3_tables'
REGION '<REGION>';

SELECT * FROM <schema_name>.<SYS_TABLE> LIMIT 10;
```

#### Constraints

- You MUST run `describe-logging-status` or `get-namespace` to get the namespace before writing any SQL query — never construct it manually
- For Athena queries, you MUST confirm workgroup and output location before executing
- **Timing columns are in microseconds.** Divide by `1000000.0` for seconds
- Tables are **read-only** — no `INSERT`/`UPDATE`/`DELETE`
- Always add a `LIMIT` when the user doesn't specify one; filter on `start_time`/`record_time` where possible

#### Examples

Worked SQL for the common asks — longest-running queries, error analysis, connection auditing, queue-time trends, cross-table joins — is in **`${SKILL_DIR}/references/example-queries.md`**. Two rules that apply to every one of them:

- **Timing columns are microseconds.** Divide by 1,000,000 for seconds. Reporting `elapsed_time` as-is overstates durations by 10^6.
- **Filter on the Iceberg partition columns** (`year`/`month`/`day` or the table's own partitioning) in addition to any timestamp predicate, or the engine scans the full history.

### Routing: Athena vs Redshift vs Direct SYS_ Access

| Scenario                                                              | Use                                        |
| --------------------------------------------------------------------- | ------------------------------------------ |
| Historical/high-volume log analysis, no cluster load                  | Athena or Redshift on S3 Tables            |
| Already connected to a Redshift cluster, want to query S3 Tables logs | Redshift cross-database or external schema |
| Join system table logs with other lake data                           | Athena or Redshift Spectrum                |
| Real-time current state of the cluster                                | Direct `SYS_` view on the cluster          |
| Quick ad-hoc query without Redshift cluster access                    | Athena                                     |

## Key Behaviors

- **No backfill** — only events recorded after enabling are delivered to S3 Tables
- **Namespace from the API** — always read the namespace from `describe-logging-status` (`S3Tables.S3TableNamespace`) or `get-namespace` (`s3TablePublishStatus.s3TableNamespace`); never construct it manually
- **Microsecond timing** — all duration columns are in microseconds; divide by 1000000.0 for seconds
- **Read-only** — published tables cannot be written to
- **Both Provisioned and Serverless** — same table bucket (`aws-redshift`), different enable APIs
- **Any Iceberg-compatible engine** — query from Athena, Redshift, or any engine that reads Iceberg

## Troubleshooting

| Error                                                                                                 | Cause                                                                                                                                         | Fix                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws-redshift` bucket not found                                                                       | S3 Tables integration not enabled or logging not started                                                                                      | Run `enable-logging` (Provisioned) or `update-namespace` (Serverless) with `--log-destination-type s3table`                                                                                                  |
| `CATALOG_NOT_FOUND` in Athena                                                                         | S3 Tables not registered in Glue                                                                                                              | Enable integration: S3 console > Table buckets > Enable integration                                                                                                                                          |
| Athena table empty after enabling                                                                     | Ingestion still in flight                                                                                                                     | Check `LastIngestionTimes` (Provisioned) / `lastIngestionTimes` (Serverless); wait and re-query                                                                                                              |
| `SYS_*` table missing from the namespace                                                              | System table not included when enabling                                                                                                       | Re-run enable with that table included, or use `all` — `--log-exports` (Provisioned), `--s3-table-names` (Serverless)                                                                                        |
| Wrong / empty namespace                                                                               | Namespace constructed instead of read from API                                                                                                | Use the namespace from the describe/get response — `S3Tables.S3TableNamespace` (Provisioned) or `s3TablePublishStatus.s3TableNamespace` (Serverless)                                                         |
| Status response has no `S3Tables` / `s3TablePublishStatus` field at all, even though publishing is on | Outdated AWS CLI / SDK. The field is **silently omitted** rather than raising an error, so this looks identical to the feature being disabled | Upgrade the CLI/SDK, then re-run. Confirm publishing is actually off before acting on the absence — check the `aws-redshift` table bucket for the namespace, or that `LogDestinationType` includes `s3table` |
| `Unknown options: --log-exports, --log-export-action` on Serverless                                   | Provisioned flag names used against `update-namespace`                                                                                        | Use `--s3-table-names` and `--s3-table-action` — see the flag table in the Enable section                                                                                                                    |
| `AccessDenied` querying the table                                                                     | Missing `s3tables:GetTable` or `GetTableData`                                                                                                 | See `references/security.md`                                                                                                                                                                                 |
| Empty results from `sys_connection_log`                                                               | Querying identity lacks visibility                                                                                                            | Use an identity with superuser-level access                                                                                                                                                                  |
| Catalog doesn't appear in `pg_database`                                                               | LF resource not registered, or SLRs not ReadOnlyAdmins                                                                                        | Complete the Lake Formation steps in `references/permissions-setup.md`, wait 5 min or reboot                                                                                                                 |
| "Unable to assume role" from Glue                                                                     | Missing `sts:SetContext`/`sts:SetSourceIdentity` in trust policy, or missing `AWSLakeFormationDataAdmin`                                      | Fix trust policy and attach `AWSLakeFormationDataAdmin`                                                                                                                                                      |
| `VerificationStatus: NOT_VERIFIED`                                                                    | Normal after Lake Formation registration                                                                                                      | No action needed if queries work                                                                                                                                                                             |
| Query fails with "does not exist" in Redshift                                                         | Catalog not yet auto-mounted (poll delay)                                                                                                     | Wait up to 300s or reboot cluster                                                                                                                                                                            |

## Security Considerations

Full policies, key policy, and detection setup: **`${SKILL_DIR}/references/security.md`**. Read it before granting access. The non-negotiables:

- **Scope IAM to the S3 Tables catalog**, not wildcards. Glue database/table ARNs nest under `s3tablescatalog/aws-redshift` — the bare `database/*` form grants metadata read on the whole account. `lakeformation:GetDataAccess` is the one action that must use `"Resource": "*"`; constrain it with an `aws:ResourceAccount` `StringEquals` condition.
- **The KMS key policy needs two principals**, not one: `systemtables.redshift.amazonaws.com` (publisher) and `maintenance.s3tables.amazonaws.com` (compaction). Granting only the publisher lets writes succeed while compaction silently fails.
- **`query_text` can contain credentials**, not just schema — interpolated SQL and `CREATE USER ... PASSWORD` land verbatim in `sys_query_history`. Treat broad access to that table as a secrets-exposure decision; restrict the column with Lake Formation.
- **Publishing is itself auditable and worth alarming on.** `s3tables.amazonaws.com` `AccessDenied` spikes and `sys_connection_log` failed-auth counts are the two signals to alert on; encrypt the alarm topic with a customer-managed key.

## Reference Files

`${SKILL_DIR}` is the absolute path of the directory containing this SKILL.md. Load these on demand; do not read them all up front.

| File                                           | What it covers                                                                                                                                                                                                                               | When to load                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `${SKILL_DIR}/references/permissions-setup.md` | Athena prerequisites and workgroup encryption; the full Redshift auto-mount path — IAM role trust/inline policies, Lake Formation `register-resource`, `put-data-lake-settings`, the SLR `ReadOnlyAdmins` step, and the 300s auto-mount poll | Before running any IAM or Lake Formation setup              |
| `${SKILL_DIR}/references/example-queries.md`   | Worked SQL for longest-running queries, error analysis, connection auditing, queue-time trends, and joins across `sys_*` tables                                                                                                              | When writing queries against the published tables           |
| `${SKILL_DIR}/references/security.md`          | Full least-privilege policy, KMS key policy with both service principals, `query_text` sensitivity, CloudTrail/metric-filter detection                                                                                                       | Before granting access, or when hardening an existing setup |

## Additional Resources

- [Integrating S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html)
- [Redshift System Tables](https://docs.aws.amazon.com/redshift/latest/dg/serverless_views-monitoring.html)
- [Lake Formation permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/granting-catalog-permissions.html)

Security best practices:

- [Amazon Redshift security best practices](https://docs.aws.amazon.com/redshift/latest/mgmt/security-best-practices.html)
- [S3 Tables security](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-security.html) and [access management for S3 Tables](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-permissions.html)
- [IAM security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [Lake Formation underlying data access control](https://docs.aws.amazon.com/lake-formation/latest/dg/access-control-underlying-data.html) — why `lakeformation:GetDataAccess` requires `"Resource": "*"`
