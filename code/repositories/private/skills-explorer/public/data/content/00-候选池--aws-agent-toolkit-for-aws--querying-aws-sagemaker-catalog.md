---
name: querying-aws-sagemaker-catalog
description: >-
  Runs SQL analytics on SageMaker Catalog asset metadata tables exported as Apache Iceberg in
  S3 Tables. Covers governance queries, asset growth tracking, ownership audits, time-travel
  over catalog state, and metadata quality analysis. Applies when querying catalog inventory,
  finding assets without descriptions, comparing catalog snapshots, or auditing data
  ownership. Trigger phrases: catalog inventory SQL, how many assets, assets without
  descriptions, asset growth over time, who owns this data, catalog governance, data quality
  audit, catalog analytics.
version: 1
argument-hint: "[query|domain-id|'configure'|'status']"
---

# Query AWS SageMaker Catalog System Tables

## Overview

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) for sandboxed execution and audit logging. All commands below use the AWS CLI and work in any environment with configured AWS credentials.

Amazon SageMaker Unified Studio (whose catalog feature is referred to below as SageMaker Catalog) exports asset metadata as a daily-snapshot
Apache Iceberg table in the AWS-managed `aws-sagemaker-catalog` table bucket. This
enables SQL queries over your entire data catalog inventory — asset counts, governance
gaps, ownership audits, and historical comparisons — without building custom ETL.

Data is partitioned by `snapshot_time` and exported once daily (around midnight per
region). The table is read-only.

## Decision Tree

| User intent                                                 | Use this skill?                           | Alternative                                                 |
| ----------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| SQL analytics on catalog state (counts, governance, trends) | **Yes**                                   | —                                                           |
| Historical comparison ("what changed in catalog last week") | **Yes** — time travel via `snapshot_time` | —                                                           |
| Find assets without owners or descriptions                  | **Yes**                                   | —                                                           |
| Find a specific table by name or concept                    | **No**                                    | `finding-data-lake-assets` or Glue Discovery `search`       |
| Browse/enumerate catalog interactively                      | **No**                                    | `exploring-data-catalog`                                    |
| Run a query _on_ a table's data                             | **No**                                    | `querying-data-lake`                                        |
| Manage catalog metadata (add descriptions, tags)            | **No**                                    | Glue Discovery `put-form-type` / `associate-glossary-terms` |

## Common Tasks

### 1. Check If Configured

```bash
aws datazone get-data-export-configuration \
  --domain-identifier <DOMAIN_ID> \
  --region <REGION>
```

- If no domain exists: `aws datazone list-domains --region <REGION>`
- If export not enabled: guide user to enable.
- One domain per account per region.

Verify table bucket exists:

```bash
aws s3tables list-table-buckets --region <REGION> \
  --query "tableBuckets[?name=='aws-sagemaker-catalog']"
```

### 2. Enable

**With KMS encryption (recommended for production):**

```bash
aws datazone put-data-export-configuration \
  --domain-identifier <DOMAIN_ID> \
  --region <REGION> \
  --enable-export \
  --encryption-configuration kmsKeyArn=<KMS_KEY_ARN>,sseAlgorithm=aws:kms
```

> **Note**: Encryption cannot be changed after creation. Always specify KMS for sensitive catalog data.

Without encryption (for quick testing only):

```bash
aws datazone put-data-export-configuration \
  --domain-identifier <DOMAIN_ID> \
  --region <REGION> \
  --enable-export
```

First data available within 24 hours. See:
[Exporting asset metadata](https://docs.aws.amazon.com/sagemaker-unified-studio/latest/userguide/export-asset-metadata.html)

### 3. Verify Permissions for Querying

Requires:

- S3 Tables federated catalog registered in Glue (`s3tablescatalog`)
- Lake Formation SELECT + DESCRIBE grants on the table

Grant access:

```bash
aws lakeformation grant-permissions \
  --principal DataLakePrincipalIdentifier=<ROLE_ARN> \
  --resource '{"Table": {"CatalogId": "<ACCOUNT>:s3tablescatalog/aws-sagemaker-catalog", "DatabaseName": "asset_metadata", "Name": "asset"}}' \
  --permissions DESCRIBE SELECT \
  --region <REGION>
```

### 4. Query

**Query syntax:**

```sql
"s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset"
```

**Constraints:**

- You MUST always filter by `snapshot_time` — without it, the query scans all historical snapshots and returns duplicates
- You MUST confirm workgroup and output location before executing
- Default to `DATE(snapshot_time) = CURRENT_DATE` for current state
- You SHOULD use the key columns documented in this skill to build queries. If you need the full schema, run `get-tables` once:

  ```
  aws glue get-tables --catalog-id "<ACCOUNT>:s3tablescatalog/aws-sagemaker-catalog" --database-name "asset_metadata" --region <REGION>
  ```

**Key columns:**

| Column                 | What it holds                                        | Usage                                                       |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `snapshot_time`        | Partition key — daily snapshot timestamp             | **Always filter on this**                                   |
| `asset_id`             | Unique catalog asset identifier                      | Primary key for lookups                                     |
| `resource_type_enum`   | GlueTable, RedshiftTable, S3Collection, etc.         | Filter by asset type                                        |
| `resource_id`          | ARN or native identifier                             | Cross-reference with source systems                         |
| `asset_name`           | Business-friendly name                               | Display, search                                             |
| `resource_name`        | Technical name (table name, prefix)                  | Filtering                                                   |
| `business_description` | Business context (NULL if not provided)              | Governance gaps                                             |
| `extended_metadata`    | `map<string,string>` — flexible key-value attributes | Use bracket notation: `extended_metadata['owningEntityId']` |
| `asset_created_time`   | When asset first appeared in catalog                 | Growth analysis                                             |
| `asset_updated_time`   | Last modification time                               | Freshness checks                                            |

**Current catalog state:**

```sql
SELECT resource_type_enum, COUNT(*) as count
FROM "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset"
WHERE DATE(snapshot_time) = CURRENT_DATE
GROUP BY resource_type_enum
ORDER BY count DESC;
```

**Assets without business descriptions:**

```sql
SELECT asset_name, resource_name, resource_type_enum, account_id
FROM "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset"
WHERE DATE(snapshot_time) = CURRENT_DATE
  AND business_description IS NULL;
```

**Asset growth over last 30 days:**

```sql
SELECT DATE(snapshot_time) as date, COUNT(*) as total_assets
FROM "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset"
WHERE DATE(snapshot_time) >= CURRENT_DATE - INTERVAL '30' DAY
GROUP BY DATE(snapshot_time)
ORDER BY date DESC;
```

**Time travel — compare current vs 7 days ago (new descriptions added):**

```sql
SELECT t.asset_id, t.resource_name,
       p.business_description as before,
       t.business_description as now
FROM "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset" t
JOIN "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset" p
  ON t.asset_id = p.asset_id
WHERE DATE(t.snapshot_time) = CURRENT_DATE
  AND DATE(p.snapshot_time) = CURRENT_DATE - INTERVAL '7' DAY
  AND p.business_description IS NULL
  AND t.business_description IS NOT NULL;
```

**Assets by owner:**

```sql
SELECT extended_metadata['owningEntityId'] as owner, COUNT(*) as count
FROM "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset"
WHERE DATE(snapshot_time) = CURRENT_DATE
  AND extended_metadata['owningEntityId'] IS NOT NULL
GROUP BY extended_metadata['owningEntityId']
ORDER BY count DESC;
```

**Filter by metadata form field:**

```sql
SELECT *
FROM "s3tablescatalog/aws-sagemaker-catalog"."asset_metadata"."asset"
WHERE DATE(snapshot_time) = CURRENT_DATE
  AND extended_metadata['<metadata-form-name>.<field-name>'] = '<field-value>';
```

## Key Behaviors

- **Daily snapshots** — exported around midnight per region
- **Always filter by `snapshot_time`** — without it you get all history (duplicates, slow)
- **One domain per account per region** — to switch domains, delete config first
- **No additional charge** beyond S3 Tables storage + Athena queries
- **Read-only** — to update asset metadata, use Glue Discovery APIs or SageMaker Unified Studio

## Troubleshooting

| Error                                    | Cause                                         | Fix                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aws-sagemaker-catalog` bucket not found | Export not enabled                            | Run `put-data-export-configuration --enable-export`                                                                                                    |
| Empty results with `CURRENT_DATE`        | First export hasn't run yet (takes up to 24h) | Wait; try yesterday's date                                                                                                                             |
| `AccessDenied` on query                  | Missing Lake Formation grants                 | Grant SELECT + DESCRIBE on the table                                                                                                                   |
| `CATALOG_NOT_FOUND`                      | S3 Tables not registered in Glue              | Enable integration: S3 console > Table buckets > Enable integration                                                                                    |
| Duplicate rows in results                | Missing `snapshot_time` filter                | Add `WHERE DATE(snapshot_time) = CURRENT_DATE`                                                                                                         |
| `extended_metadata` key returns NULL     | Key doesn't exist for that asset              | Check available keys: `SELECT DISTINCT key FROM ... CROSS JOIN UNNEST(map_keys(extended_metadata)) AS t(key) WHERE DATE(snapshot_time) = CURRENT_DATE` |
| Cannot update export encryption          | Encryption set at creation time only          | Delete and recreate export config                                                                                                                      |

## Security Considerations

**Data sensitivity**: Catalog metadata exposes organizational structure including asset names, ownership, account IDs, naming conventions, and internal resource identifiers. Treat query results as sensitive by default.

**Encryption at rest**: Always enable KMS encryption when creating the export configuration. Encryption cannot be changed after creation. Additionally, configure SSE-KMS on your Athena workgroup output bucket.

**Least-privilege access**: Grant Lake Formation SELECT + DESCRIBE only on the specific `asset_metadata.asset` table to roles that need catalog analytics. Avoid granting access to the entire `aws-sagemaker-catalog` bucket.

**Audit trail**: Enable CloudTrail logging for DataZone (`PutDataExportConfiguration`, `GetDataExportConfiguration`), Athena (`StartQueryExecution`, `GetQueryResults`), and S3 Tables API calls to track who queries catalog metadata.

**Credential hygiene**: Use IAM roles with temporary credentials for querying. Avoid long-lived access keys for users accessing catalog metadata. Scope down or rotate principals when access is no longer needed.

## Additional Resources

- [Exporting asset metadata](https://docs.aws.amazon.com/sagemaker-unified-studio/latest/userguide/export-asset-metadata.html)
- [Asset table schema](https://docs.aws.amazon.com/sagemaker-unified-studio/latest/userguide/export-asset-metadata.html#asset-table-schema)
- [Integrating S3 Tables with analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html)
- [Lake Formation permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/granting-catalog-permissions.html)
