---
name: creating-data-lake-table
description: >-
  Create managed Iceberg tables using Amazon S3 Tables (s3tables API namespace) with
  automatic compaction and snapshot management. Sets up table bucket, namespace, table,
  schema, Glue catalog registration, partitioning, IAM access control. Triggers on:
  create table, data lake table, analytics table, structured data storage, S3 Tables,
  Iceberg, Athena table, partitioning strategy, access permissions. Do NOT use  for:
  importing files (use ingesting-into-data-lake), vector storage (use storing-and-querying-vectors),
  querying existing tables (use querying-data-lake), or locating existing table (use
  finding-data-lake-assets).
metadata:
  version: "1"
  argument-hint: "'[table-description|schema-spec]'"
---

# Create Data Lake Tables with Amazon S3 Tables

## Overview

Amazon S3 Tables provides managed Iceberg tables with automatic compaction and snapshot management. Queryable via Athena and Iceberg-compatible engines.

## Common Tasks

You MUST use AWS MCP server tools when connected, they provide command validation, sandboxed execution, and audit logging. Fall back to AWS CLI if MCP unavailable.

## Decision Guide

**Before creating, You MUST check what exists:**

You MUST run `aws glue get-tables --database-name <NAME>` when user mentions a database.

| What you find                                | Action                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Fuzzy database name ("our analytics db")     | You MUST STOP. Delegate to `finding-data-lake-assets` to resolve.                               |
| Non-S3-Tables table with matching name       | You MUST STOP. Delegate to `finding-data-lake-assets`. You MUST NOT create until user confirms. |
| Existing S3 Tables table with matching name  | You MUST check schema match. Reuse if compatible, recreate only if user confirms.               |
| No matching tables                           | Proceed with creation (Steps 1-8).                                                              |
| User explicitly requests new S3 Tables table | Skip checks, proceed with creation.                                                             |

**Creation paths:**

- **Existing data in S3**: Create empty table (Steps 1-8), then use `ingesting-into-data-lake` skill.
- **Glue ETL pipeline**: Read `references/table-creation-glue-etl.md` first, then Steps 1-6.
- **Lake Formation access control**: Search AWS docs for `"S3 Tables integration with Lake Formation"`.

### 1. Verify Dependencies

**Constraints:**

- You MUST check whether AWS MCP server tools or AWS CLI are available and inform user if missing
- You MUST confirm target AWS region and verify credentials with `aws sts get-caller-identity`

### 2. Understand the Schema

- **Explicit schema**: Validate Iceberg types.
- **Loose description**: Ask columns, types, grain. Propose and confirm.
- **Existing S3 data**: Infer schema from file headers only. Create empty table first, then use `ingesting-into-data-lake` skill.

**Constraints:**

- You MUST read `references/best-practices.md` for Iceberg type mapping, partitions, and naming.
- You MUST ask for all required parameters upfront: table name, columns, types, partition strategy. For schema evolution, see `references/athena-ddl-path.md`.
- You MUST use all lowercase names -- Glue rejects mixed case with `GENERIC_INTERNAL_ERROR`. Namespace and table names MUST NOT contain hyphens.
- You SHOULD suggest partition columns based on access patterns.

### 3. Create Table Bucket

Names: 3-63 chars, lowercase, numbers, hyphens.

```bash
aws s3tables create-table-bucket --name <BUCKET_NAME> --region <REGION>
```

Capture `table-bucket-arn`. Encryption (SSE-S3 default, SSE-KMS) and storage class (STANDARD, INTELLIGENT_TIERING) set at creation. See `references/best-practices.md`.

**Constraints:**

- You MUST check existing buckets with `aws s3tables list-table-buckets` and ask user to select or create new.
- If using SSE-KMS, KMS key policy MUST allow S3 Tables maintenance service principal to read data. Search AWS docs for `"S3 Tables KMS key policy"` for required policy.
- If bucket creation fails, see `references/best-practices.md` for common errors.

### 4. Create Namespace

```bash
aws s3tables create-namespace --table-bucket-arn <ARN> --namespace <NAMESPACE>
```

**Constraints:**

- You MUST list existing namespaces first and suggest reusing if relevant
- You MUST use lowercase names with no hyphens

### 5. Create Glue Data Catalog Integration

Check if `s3tablescatalog` exists (create once per region per account):

```bash
aws glue get-catalog --catalog-id s3tablescatalog
```

If not found, create (requires `glue:CreateCatalog`, `glue:passConnection`):

```bash
aws glue create-catalog --name "s3tablescatalog" --catalog-input '{
  "FederatedCatalog": {
    "Identifier": "arn:aws:s3tables:<REGION>:<ACCOUNT_ID>:bucket/*",
    "ConnectionName": "aws:s3tables"
  },
  "CreateDatabaseDefaultPermissions": [{"Principal": {"DataLakePrincipalIdentifier": "IAM_ALLOWED_PRINCIPALS"}, "Permissions": ["ALL"]}],
  "CreateTableDefaultPermissions": [{"Principal": {"DataLakePrincipalIdentifier": "IAM_ALLOWED_PRINCIPALS"}, "Permissions": ["ALL"]}],
  "AllowFullTableExternalDataAccess": "True"
}'
```

Verify with `aws glue get-catalogs --parent-catalog-id s3tablescatalog`.

### 6. Configure Access Control

S3 Tables uses `s3tables:*` IAM namespace (not `s3:*`).

**Querying principal permissions (bucket policy):**

- `s3tables:GetTableBucket`, `s3tables:GetNamespace`, `s3tables:GetTable`, `s3tables:GetTableMetadataLocation`, `s3tables:GetTableData`

**Querying principal permissions (IAM policy):**

- `glue:GetCatalog`, `glue:GetDatabase`, `glue:GetTable`

You MUST scope to correct ARN patterns. You MUST read `references/access-control.md` for exact resource ARNs.

**Constraints:**

- You MUST ask user for querying principal ARN
- You MUST NOT grant broader permissions than necessary
- You MUST NOT create IAM roles automatically, verify existing and guide user

### 7. Create the Table

| Context                         | Path                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (any user)              | **S3 Tables API** (below)                                                                                                                    |
| User specifically wants SQL DDL | **Athena DDL** (see `references/athena-ddl-path.md`)                                                                                         |
| Glue ETL pipeline               | **Spark DDL** via `--conf` job args (not `spark.conf.set()`). You MUST read `references/table-creation-glue-etl.md` for the `--conf` string. |

**Default: S3 Tables API:**

```bash
aws s3tables create-table \
  --table-bucket-arn <ARN> \
  --namespace <NAMESPACE> \
  --name <TABLE_NAME> \
  --format ICEBERG \
  --metadata '<METADATA_JSON>'
```

Metadata JSON MUST nest under `"iceberg"` key:

```json
{
  "iceberg": {
    "schema": {
      "fields": [
        { "name": "order_date", "type": "date", "required": true },
        { "name": "customer_id", "type": "string", "required": true },
        { "name": "amount", "type": "double", "required": false }
      ]
    },
    "partitionSpec": {
      "fields": [
        { "sourceId": 1, "fieldId": 1000, "transform": "month", "name": "order_date_month" }
      ]
    }
  }
}
```

**Constraints:**

- `partitionSpec.sourceId` MUST reference a valid schema field ID
- For schema evolution after creation, use Athena DDL. See `references/athena-ddl-path.md`
- You MUST use `schemaV2` for complex types (list, map, struct) with explicit field IDs. See `references/best-practices.md`.
- You SHOULD search AWS docs for `"IcebergPartitionField S3 Tables"` for supported partition transforms

### 8. Verify and Confirm

You MUST verify with `aws s3tables get-table` and confirm queryability with `DESCRIBE <table_name>` via Athena using `--query-execution-context '{"Catalog":"s3tablescatalog/<BUCKET_NAME>","Database":"<NAMESPACE>"}'`. Do NOT put catalog in SQL. Present summary: bucket ARN, namespace, table, schema, partitions.

## Troubleshooting

| Error                                      | Cause                         | Fix                                                              |
| ------------------------------------------ | ----------------------------- | ---------------------------------------------------------------- |
| "Table location can not be specified"      | LOCATION in CREATE TABLE      | Remove LOCATION clause. S3 Tables manages storage automatically. |
| `AccessDeniedException` with `s3:*` policy | Using `s3:*` not `s3tables:*` | S3 Tables uses `s3tables:*` namespace. Update IAM policy.        |

## Additional Resources

- [access-control.md](references/access-control.md) -- IAM permissions, ARN patterns, permission errors
- [best-practices.md](references/best-practices.md) -- Iceberg types, partitions, naming, common errors
- [athena-ddl-path.md](references/athena-ddl-path.md) -- Athena DDL, schema evolution
- [table-creation-glue-etl.md](references/table-creation-glue-etl.md) -- Spark DDL via Glue ETL
- Loading data: `ingesting-into-data-lake` skill
