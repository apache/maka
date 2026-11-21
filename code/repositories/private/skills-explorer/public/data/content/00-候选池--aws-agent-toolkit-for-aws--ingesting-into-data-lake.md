---
name: ingesting-into-data-lake
description: >-
  Import data into the AWS data lake from S3 files, local uploads, JDBC databases
  (Oracle, SQL Server, PostgreSQL, MySQL, RDS, Aurora), Amazon Redshift, Snowflake,
  BigQuery, DynamoDB, or existing Glue catalog tables (migration). Default target
  is S3 Tables; standard Iceberg on a general purpose bucket is supported where S3
  Tables is not adopted. Handles one-time loads, recurring pipelines, migrations.
  Triggers on: import data, load data, ingest, sync database, migrate table, move
  data to AWS, set up pipeline, ETL, pull from Snowflake, query BigQuery into S3,
  export DynamoDB, CTAS, convert to Iceberg. Do NOT use for setting up or troubleshooting
  Glue connections (use connecting-to-data-source), creating empty tables (use creating-data-lake-table),
  running queries (use querying-data-lake), finding tables by fuzzy name (use finding-data-lake-assets),
  catalog audit (use exploring-data-catalog), or SaaS platforms like Salesforce, ServiceNow,
  SAP, MongoDB, Kafka.
metadata:
  version: "1"
  argument-hint: "'[source-path|connection-name|table-name] [--target s3-tables|iceberg|parquet]'"
---

# Ingest into Data Lake

Move data from a source into a queryable table in the data lake. This skill assumes the source connection (if one is needed) already exists. For Glue connection setup or troubleshooting, delegate to `connecting-to-data-source`.

## Philosophy

**Default to S3 Tables unless the environment says otherwise.** S3 Tables is the recommended target for new data lake work. If the user's catalog inventory shows they haven't adopted S3 Tables, recommend standard Iceberg on their existing general-purpose bucket instead of forcing them to change posture.

## Common Tasks

You MUST execute commands using AWS MCP server tools when connected -- they provide validation, sandboxed execution, and audit logging. Fall back to AWS CLI only if MCP is unavailable. You MUST explain each step before executing.

## Workflow

### 1. Verify Dependencies and Context

- You MUST check whether AWS MCP tools or AWS CLI are available and inform the user if missing
- You MUST confirm target AWS region and verify credentials with `aws sts get-caller-identity`
- For SageMaker Unified Studio project roles, note that target tables and connections may be scoped to the project. See the caller ARN detection pattern in `querying-data-lake`.

### 2. Classify the Source

| User says...                                                       | Source type       | Reference                                               |
| ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------- |
| "upload my file", "local CSV", "move to S3"                        | Local file        | [local-upload.md](references/local-upload.md)           |
| "load from S3", "import CSV/JSON/Parquet from s3://"               | S3 files          | [s3-files.md](references/s3-files.md)                   |
| "import from Oracle/Postgres/MySQL/SQL Server/Redshift/RDS/Aurora" | JDBC              | [jdbc-ingest.md](references/jdbc-ingest.md)             |
| "pull from Snowflake", "Snowflake table to S3"                     | Snowflake         | [snowflake-ingest.md](references/snowflake-ingest.md)   |
| "import from BigQuery", "GCP analytics to S3"                      | BigQuery          | [bigquery-ingest.md](references/bigquery-ingest.md)     |
| "export DynamoDB", "DynamoDB to data lake"                         | DynamoDB          | [dynamodb-ingest.md](references/dynamodb-ingest.md)     |
| "migrate Glue table", "convert Hive to Iceberg"                    | Catalog migration | [catalog-migration.md](references/catalog-migration.md) |

If the user names Salesforce, ServiceNow, SAP, MongoDB, Kafka, or another SaaS/streaming source, decline -- these are not supported in this release.

If the source table is referenced by a fuzzy or business name ("migrate our orders table", "pull from the sales warehouse"), delegate to `finding-data-lake-assets` to resolve before proceeding.

### 3. Confirm Connection Exists (if applicable)

For JDBC, Snowflake, and BigQuery sources, a Glue connection is required. Check:

```bash
aws glue get-connection --name <CONNECTION_NAME> --region <REGION>
```

If the connection does not exist, stop and delegate to `connecting-to-data-source` to create and test it. Do not proceed with ingest until the connection is verified.

Local files, S3 files, DynamoDB, and catalog migration do not need a Glue connection.

### 4. Clarify the Target

You MUST ask the user (or suggest based on catalog inventory) before creating or writing to any table:

- **Database/namespace**: Does a specific target database exist? Or should one be created?
- **Table**: Existing table (append/merge) or new table (delegate to `creating-data-lake-table`)?
- **Format**: S3 Tables (default), standard Iceberg, or raw Parquet?

**Inventory-aware defaults:**

If you have already run `exploring-data-catalog` or can quickly check, use what exists:

- Account has an `s3tablescatalog` federated catalog and active table buckets: recommend S3 Tables
- Account has general-purpose buckets with Iceberg tables and no S3 Tables usage: recommend standard Iceberg on their existing bucket
- Account uses Parquet/ORC on S3 without Iceberg metadata: ask whether to adopt Iceberg now (recommend yes) or continue with raw files

Do not force S3 Tables on customers who haven't adopted it. See [iceberg-catalog-config-and-usage.md](references/iceberg-catalog-config-and-usage.md).

**Delegations from this step:**

- Target table doesn't exist -> `creating-data-lake-table`
- Target database named by fuzzy term -> `finding-data-lake-assets`
- User doesn't know what exists -> `exploring-data-catalog`

### 5. Execute Source Workflow

Read the source-specific reference and follow its phases. Each is self-contained with job templates, gotchas, and troubleshooting:

- Local / S3 / JDBC / Snowflake / BigQuery / DynamoDB / catalog migration -- one reference per source

Common Glue 5.1 or higher job configuration and PySpark templates are shared in [glue-job-config.md](references/glue-job-config.md) and [glue-job-scripts.md](references/glue-job-scripts.md).

### 6. Validate

Run all three, do not skip:

1. Row count matches expected (source vs target)
2. Null check on critical columns
3. Spot-check 3-5 sample rows

See [data-quality-validation.md](references/data-quality-validation.md).

### 7. Schedule (if recurring)

For recurring pipelines, create a Glue Trigger with a cron schedule. See [testing-and-scheduling.md](references/testing-and-scheduling.md). Simple single-step pipelines use Glue Triggers; multi-step with branching uses MWAA.

## Argument Routing

- S3 path only: Infer one-time load, start Step 2 with S3 files
- Connection name: Start Step 3 with the named connection
- Table name: Start Step 4, ask whether this is source or target
- `--target` flag: Pre-fill the target format in Step 4
- No args: Walk through interactively

## Gotchas

- S3 Tables requires Glue 5.1 or higher and `--datalake-formats iceberg` job argument
- All `spark.sql.catalog.*` config MUST go in `--conf` job arguments, never in `spark.conf.set()`. Glue 5.x throws `AnalysisException: Cannot modify the value of a static config` otherwise. See [iceberg-catalog-config-and-usage.md](references/iceberg-catalog-config-and-usage.md) for correct catalog configs.
- The `warehouse` parameter is required in S3 Tables catalog config. Without it Spark fails with "Cannot derive default warehouse location".
- Table and column names in S3 Tables MUST be all lowercase
- `overwritePartitions()` only replaces partitions present in the DataFrame -- for full refresh with deletes, use `createOrReplace()`
- Standard Iceberg targets MUST include a LOCATION clause; S3 Tables MUST NOT
- DynamoDB does not need a Glue connection -- do not attempt to create one
- Connection failures during ingest delegate back to `connecting-to-data-source`; do not debug network/credentials in this skill
- For target tables in SageMaker Unified Studio projects, ensure the project role has write access to the target namespace before the Glue job runs

## Troubleshooting

| Error                                | Likely cause                   | Action                                         |
| ------------------------------------ | ------------------------------ | ---------------------------------------------- |
| Access Denied on S3                  | Missing IAM permissions        | Check Glue role has s3:GetObject, s3:PutObject |
| Access Denied on S3 Tables           | Missing s3tables:* permissions | Add S3 Tables inline policy to Glue role       |
| CTAS timeout                         | Dataset too large for Athena   | Switch to Glue ETL or batch with WHERE filters |
| JDBC connection timeout/auth failure | Connection-level issue         | Delegate to `connecting-to-data-source`        |
| Throughput exceeded (DynamoDB)       | Read percent too high          | Lower `read.percent` or use native export      |

See [error-handling.md](references/error-handling.md) for the full catalog.

## References

### Source-specific

- [local-upload.md](references/local-upload.md) -- Local files
- [s3-files.md](references/s3-files.md) -- S3 files (CSV, JSON, Parquet, Avro, ORC)
- [jdbc-ingest.md](references/jdbc-ingest.md) -- Oracle, SQL Server, PostgreSQL, MySQL, RDS, Aurora, Redshift
- [snowflake-ingest.md](references/snowflake-ingest.md) -- Snowflake
- [bigquery-ingest.md](references/bigquery-ingest.md) -- BigQuery
- [dynamodb-ingest.md](references/dynamodb-ingest.md) -- DynamoDB (export and Glue direct read)
- [catalog-migration.md](references/catalog-migration.md) -- Existing Glue catalog tables (Hive, self-managed Iceberg)

### Cross-cutting

- [iceberg-catalog-config-and-usage.md](references/iceberg-catalog-config-and-usage.md) -- S3 Tables, standard Iceberg, raw files: catalog config, engine access patterns
- [glue-job-config.md](references/glue-job-config.md) -- Job sizing, monitoring, retry
- [glue-job-scripts.md](references/glue-job-scripts.md) -- PySpark templates (append, upsert, custom SQL, full refresh)
- [incremental-loading.md](references/incremental-loading.md) -- Watermark strategies
- [testing-and-scheduling.md](references/testing-and-scheduling.md) -- Glue Triggers, MWAA
- [data-quality-validation.md](references/data-quality-validation.md) -- Row counts, null checks, Glue Data Quality
- [schema-evolution.md](references/schema-evolution.md) -- ALTER TABLE ADD COLUMNS, nested JSON
- [type-transformations.md](references/type-transformations.md) -- Type conflict resolution
- [format-specific-loading.md](references/format-specific-loading.md) -- CSV/JSON/Parquet/Avro/ORC specifics
- [athena-loading.md](references/athena-loading.md) -- Athena INSERT INTO as simple-load fallback
- [error-handling.md](references/error-handling.md) -- Ingest errors (connection errors delegate to connecting-to-data-source)
- [upload-options.md](references/upload-options.md) -- aws s3 cp vs sync, multipart

### Migration-specific

- [ctas-patterns.md](references/ctas-patterns.md) -- Athena CTAS syntax and partition transforms
- [glue-etl-migration.md](references/glue-etl-migration.md) -- Large-table migration via Glue 5.1 or higher PySpark
- [migration-validation.md](references/migration-validation.md) -- Full validation checklist
- [migration-troubleshooting.md](references/migration-troubleshooting.md) -- CTAS failures, visibility, partitions

### JDBC-specific

- [jdbc-schema-discovery.md](references/jdbc-schema-discovery.md) -- Crawler, direct inspection, custom SQL
- [jdbc-performance.md](references/jdbc-performance.md) -- Parallel reads, partitioning
