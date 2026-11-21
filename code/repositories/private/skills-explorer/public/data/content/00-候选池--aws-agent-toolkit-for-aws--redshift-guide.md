---
name: redshift-guide
description: "Amazon Redshift is NOT PostgreSQL — corrects PostgreSQL-derived LLM mistakes; covers Redshift-specific SQL, DDL, COPY/UNLOAD, system views, metadata discovery, and operational patterns. Applies ONLY when the task is about Redshift itself (cluster, Serverless workgroup, or Redshift SQL). Pushes back on: CREATE INDEX, string_agg, pg_catalog, text type, SERIAL, stl_query, LATERAL, RETURNING. Triggers on: Redshift SQL, Redshift CREATE TABLE, Redshift COPY/UNLOAD, slow Redshift query, Redshift permission denied, Redshift disk full, Redshift system views, QUALIFY, PIVOT, MERGE, Redshift Data API, Redshift WLM, concurrency scaling, Redshift resize, Redshift Spectrum external tables. Does NOT apply to (defer to that service's own skill): Amazon S3 storage/bucket policies, Athena or Glue queries/catalogs, data-lake or Iceberg work outside Redshift, Aurora, RDS, or DynamoDB — but S3/Glue ARE in scope for Redshift COPY, UNLOAD, or data-lake queries (external schemas/tables on S3)."
metadata:
  version: "1"
---

# Amazon Redshift Guide

## Redshift is NOT PostgreSQL (read first)

Redshift speaks PostgreSQL's wire protocol and shares much of its surface syntax, so
LLMs assume PostgreSQL behavior carries over — it frequently does not. Divergences span
system tables (`pg_catalog` is incomplete), DDL (no indexes, no sequences), functions
(`string_agg`, `SUBSTR` on tables, leader-node-only functions), types (a `text` column
becomes VARCHAR(256)), and comparison semantics (trailing blanks, unenforced constraints). **Assume
divergence and verify against the reference below — do not answer from PostgreSQL habit.**
Common PostgreSQL→Redshift divergences are in `references/redshift-sql-syntax.md`.

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) — it runs the
AWS CLI and Redshift Data API calls below in a sandboxed, audit-logged environment. All
guidance here is plain AWS CLI and SQL and works without it.

## STEP 0: Serverless or Provisioned?

Establish this before answering — APIs, system tables, and capabilities differ. Take it
from the question when it says which one; **ask** when it does not. `SELECT version()`
does not identify it.

- **Serverless** — identified by a _workgroup_ (and namespace). Data API calls take
  `--workgroup-name`; the user says "workgroup"/"Serverless".
- **Provisioned** — identified by a _cluster_. Data API calls take
  `--cluster-identifier`; the user says "cluster".

| Target          | System Views                                                                                 | Credentials API                      |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Provisioned** | `SYS_`, all `SVV_` + `STL_`, `STV_`, `SVL_`, `SVCS_` (single-AZ only — disabled on Multi-AZ) | `redshift:GetClusterCredentials`     |
| **Serverless**  | `SYS_` + a subset of `SVV_` ONLY (no `STL`/`STV`/`SVL`/`SVCS`)                               | `redshift-serverless:GetCredentials` |

## Critical Facts

- **SHOW commands are the primary metadata interface** — SHOW DATABASES, SHOW SCHEMAS, SHOW TABLES, SHOW COLUMNS, SHOW TABLE, SHOW VIEW. Do NOT default to pg_catalog or information_schema. → **Load `references/redshift-sql-metadata.md` for metadata/discovery questions and any "relation does not exist" report** — it has the diagnostic flow.
- **`SYS_` views are the preferred system views** — they work everywhere. `STL_`, `STV_`, `SVL_`, and `SVCS_` are provisioned single-AZ only, and some `SVV_` views are unsupported on Serverless. → **Load `references/redshift-sql-metadata.md` for any system-view or monitoring question.**
- **`sys_load_error_detail`** for COPY debugging (not `stl_load_errors`, which is provisioned single-AZ only).
- **DATEADD/DATEDIFF** — unit-first argument order: `DATEADD(day, -30, GETDATE())`, `DATEDIFF(day, start, end)`.
- **APPROXIMATE COUNT(DISTINCT col)** — Redshift-specific, ~2% error, much faster than exact COUNT(DISTINCT) on large datasets.
- **MERGE ... REMOVE DUPLICATES** — simplified dedup when source and target have identical schemas.
- **COPY should use IAM_ROLE** (the namespace role, not the caller role) + supports MANIFEST for explicit file lists + MAXERROR for error tolerance.
- **`SUBSTR()` is leader-node-only** — works on literals but errors on table columns (`SUBSTR() function is not supported (Hint: use SUBSTRING instead)`). Use `SUBSTRING()` on columns.
- **UNIQUE / PRIMARY KEY / FOREIGN KEY are informational only** — NOT enforced (duplicate rows are accepted with no error). Optimizer hints; enforce integrity in the application or via MERGE. `NOT NULL` IS enforced.
- **`SHOW VIEW <schema.name>`** returns the definition of a regular view, materialized view, or late-binding view. MV freshness: `SVV_MV_INFO` (`is_stale`).
- **`TOP N` and `LIMIT N` both work** (`TOP N PERCENT` does not). A `text` column becomes `VARCHAR(256)` — use `VARCHAR(max)` or explicit length.
- **Iceberg tables use `CREATE TABLE ... USING ICEBERG`** (not `STORED AS ICEBERG`, not `TABLE_FORMAT=ICEBERG`).
- **Datashares support read and write operations** — consumers can write once the producer grants write privileges. Treat "permission denied" on a datashare write as a **missing grant**, not an unsupported operation. → **Load `references/redshift-sql-metadata.md` for requirements and limits.**

## Safety Guardrails

**BLOCK:** DROP DATABASE, DELETE without WHERE, publicly-accessible=true, GRANT ALL ON ALL
**WARN then confirm:** RESIZE, RESTORE, VACUUM on large tables, ALTER PASSWORD, WLM config change
**Confirm:** CREATE, GRANT specific, COPY, UNLOAD

## Security Considerations

Apply these defaults when generating anything that connects, loads, or exports. Details
are in the reference files noted.

- **In transit:** the Data API is HTTPS-only. For JDBC/ODBC set the `require_ssl`
  parameter and connect with `sslmode=verify-full` so the server certificate is checked.
- **At rest:** keep cluster/namespace encryption enabled, and add
  `ENCRYPTED KMS_KEY_ID '<arn>'` to `UNLOAD` — it writes query results to S3, outside
  Redshift's own encryption. → `references/redshift-sql-ddl-copy.md`
- **Credentials:** prefer `SecretArn` (Secrets Manager) or IAM Identity Center; `DbUser`
  is acceptable because it issues temporary credentials. Never place database passwords in
  code, environment variables, or SQL text. → `references/redshift-sql-recipes-load-api.md`
- **Least privilege:** scope the namespace `IAM_ROLE` to the specific bucket and prefix
  (`s3:GetObject` on `arn:aws:s3:::<bucket>/<prefix>/*`), not `s3:*` or a managed
  full-access policy, and condition its trust policy on both `aws:SourceArn` (the
  cluster/namespace ARN) and `aws:SourceAccount` — `SourceArn` alone still allows another
  resource in the account to assume it. Grant per-object privileges rather than
  `GRANT ALL ON ALL`.
- **Audit:** CloudTrail records `redshift-data:*` API calls but not the SQL executed;
  enable Redshift audit logging (`useractivitylog`, `connectionlog`, `userlog`) for that.
  Both capture query text and user activity, so encrypt every destination in use:
  the CloudWatch Logs group (`aws logs associate-kms-key`), the CloudTrail trail
  (SSE-KMS), and the audit-log S3 bucket (SSE-S3 — audit logging to S3 supports only
  S3-managed keys, not KMS). Serverless only supports sending audit logs to CloudWatch.
- **Network:** keep `PubliclyAccessible=false` and connect over a VPC
  endpoint. Do not open port 5439 to `0.0.0.0/0` or `::/0` — scope inbound rules to
  specific CIDRs or to a referencing security group.
- **Sensitive data:** Data API results persist for 24h and `sys_load_error_detail` can
  echo fragments of rejected rows, so treat statement IDs and load-error output as
  sensitive.
- **Further reading:**
  [Security in Amazon Redshift](https://docs.aws.amazon.com/redshift/latest/dg/db-security.html)
  for the full guidance behind these defaults.

## Routing Table

**MANDATORY:** When a question matches a row below, you MUST load and read the referenced file BEFORE answering.

**Ask whether the target is provisioned or Serverless before giving troubleshooting steps —
unless the question already says which one, in which case use that and do not re-confirm.**

| User Intent                                                                                                                                                                                                                    | Route To                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| "CREATE TABLE", "DISTKEY/SORTKEY", "ENCODE", "IDENTITY", "COPY", "UNLOAD", "IAM_ROLE", "Iceberg table"                                                                                                                         | `references/redshift-sql-ddl-copy.md`                                                                          |
| "LISTAGG", "DATEADD/DATEDIFF", "NVL/DECODE", "type mapping", "text type", "VARBYTE", "recursive CTE"                                                                                                                           | `references/redshift-sql-functions-types.md`                                                                   |
| "QUALIFY", "PIVOT/UNPIVOT", "MERGE", "TOP N", "SUBSTR error", "UNIQUE/PK not enforced", "trailing blanks", "leader-node function", "JSON", "SUPER", "PartiQL", "nested/semi-structured data"                                   | `references/redshift-sql-extensions-semantics.md`                                                              |
| "system view", "SVV_/SYS_", "SHOW commands", "STL vs SYS", "list tables", "distkey/sortkey lookup", "datashare discovery", "2-part vs 3-part", "permission denied", "GRANT", "privileges", **"relation/table does not exist"** | `references/redshift-sql-metadata.md`                                                                          |
| "how do I write SQL", "PostgreSQL vs Redshift", "which SQL reference", general dialect question                                                                                                                                | `references/redshift-sql-syntax.md` (index of the 6 SQL references + PostgreSQL-vs-Redshift failure table)     |
| "COPY failed", "load error", "Data API poll", "async query", "Data API throttle"                                                                                                                                               | `references/redshift-sql-recipes-load-api.md`                                                                  |
| "materialized view", "MV refresh", "AUTO REFRESH", "stale view"                                                                                                                                                                | `references/redshift-sql-materialized-views.md`                                                                |
| General Redshift question not matching above                                                                                                                                                                                   | Answer directly from general knowledge                                                                         |
| Aurora, RDS, DynamoDB, Athena (non-Redshift)                                                                                                                                                                                   | **REFUSE.** State this skill is for Amazon Redshift only. Do not provide guidance for other database services. |

## Data API Quick Reference

→ **Load `references/redshift-sql-recipes-load-api.md` before answering ANY Data API, COPY-error, or async-query question.** It carries the bounded poll loop, the `HasResultSet` and `ResourceNotFoundException` handling, the per-target parameters, and the auth options.

Data API calls are **async by default** — use long polling (`--wait-time-seconds`, 1–30)
rather than blind sleeps, and keep a bounded loop for work that can exceed 30s.
Serverless takes `--workgroup-name`, provisioned takes `--cluster-identifier`.
