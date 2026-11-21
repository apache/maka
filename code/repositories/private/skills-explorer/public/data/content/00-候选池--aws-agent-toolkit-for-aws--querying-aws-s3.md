---
name: querying-aws-s3
description: >-
  Queries S3 object metadata, tracks bucket activity, audits object changes, searches
  annotations, and analyzes storage metrics using S3 Metadata system tables (journal,
  inventory, annotation) and S3 Storage Lens tables via Athena SQL. Applies when counting
  objects, finding recent uploads or deletions, identifying who wrote to a prefix, breaking
  down storage classes, finding objects by tag, searching annotation content, analyzing
  storage lens metrics, or enabling S3 Metadata tracking. Prefers system tables over raw S3
  APIs (list-objects-v2, head-object) at scale. Trigger phrases: bucket activity, object
  count, who uploaded, track deletions, storage class breakdown, find by tag, search
  annotations, storage lens metrics, audit bucket changes.
version: 1
argument-hint: "[bucket-name|query|'configure BUCKET'|'status BUCKET']"
---

# Query AWS S3 System Tables

## Overview

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html) for sandboxed execution and audit logging. All commands below use the AWS CLI and work in any environment with configured AWS credentials. Use IAM roles or temporary credentials; avoid long-lived access keys.

Amazon S3 Metadata provides continuously-updated Apache Iceberg tables that capture
object-level metadata for general-purpose buckets. S3 Storage Lens exports aggregated
storage and activity metrics as Iceberg tables. Both are read-only, stored in the
AWS-managed `aws-s3` table bucket, and queryable via Amazon Athena.

System tables are preferred over raw S3 APIs (`list-objects-v2`, `head-object`) because:

- `list-objects-v2` paginates at 1000 objects/page — inefficient for large buckets (millions or billions of objects). The inventory table answers `SELECT COUNT(*)` in seconds at any scale.
- `list-objects-v2` cannot identify who uploaded an object, from which IP, or when something was deleted. Only the journal table has `requester`, `source_ip_address`, and delete event tracking.
- Filtering by tag requires `get-object-tagging` per object. The inventory table has `object_tags` as a queryable map column.

## Decision Tree

| User intent                          | Use this skill? | Table                          | Alternative                                                |
| ------------------------------------ | --------------- | ------------------------------ | ---------------------------------------------------------- |
| How many objects in my bucket        | **Yes**         | inventory                      | —                                                          |
| What was recently uploaded/deleted   | **Yes**         | journal                        | —                                                          |
| Who wrote/deleted objects (audit)    | **Yes**         | journal (requester, source_ip) | —                                                          |
| Storage class breakdown              | **Yes**         | inventory                      | —                                                          |
| Find objects by tag or user metadata | **Yes**         | inventory                      | —                                                          |
| Search annotation content            | **Yes**         | annotation                     | Single object → direct API `get-object-annotation`         |
| Write/update an annotation           | **No**          | —                              | Direct API: `put-object-annotation` (tables are read-only) |
| Query data _inside_ objects          | **No**          | —                              | `querying-data-lake`                                       |
| Bucket-level storage metrics/trends  | **Yes**         | Storage Lens tables            | —                                                          |
| Enable metadata tracking             | **Yes**         | see Enable section             | —                                                          |

## Common Tasks

### 1. Check If Configured

Before querying, confirm S3 Metadata is enabled on the target bucket.

```bash
aws s3api get-bucket-metadata-configuration --bucket <BUCKET> --region <REGION>
```

**Interpret the response:**

- `MetadataConfigurationNotFound` error → not enabled. See Enable section below.
- `TableStatus: ACTIVE` → ready to query.
- `TableStatus: BACKFILLING` → queryable but inventory may be incomplete.
- `TableStatus: FAILED` → check error field (usually IAM).

**For Storage Lens:**

```bash
aws s3control get-storage-lens-configuration --account-id <ACCOUNT> --config-id <CONFIG_ID> --region <REGION>
```

Look for `DataExport.StorageLensTableDestination.IsEnabled: true`.

### 2. Enable (if not configured)

**Enable S3 Metadata on a bucket:**

```bash
aws s3api create-bucket-metadata-configuration \
  --bucket <BUCKET> \
  --region <REGION> \
  --metadata-configuration '{
    "JournalTableConfiguration": {"RecordExpiration": {"Expiration": "DISABLED"}},
    "InventoryTableConfiguration": {"ConfigurationState": "ENABLED"}
  }'
```

To also enable annotations (requires a service role):

```bash
aws s3api create-bucket-metadata-configuration \
  --bucket <BUCKET> \
  --region <REGION> \
  --metadata-configuration '{
    "JournalTableConfiguration": {"RecordExpiration": {"Expiration": "ENABLED", "Days": 90}},
    "InventoryTableConfiguration": {"ConfigurationState": "ENABLED"},
    "AnnotationTableConfiguration": {"ConfigurationState": "ENABLED", "Role": "<ROLE_ARN>"}
  }'
```

**Enable Storage Lens S3 Tables export:**

```bash
aws s3control put-storage-lens-configuration \
  --account-id <ACCOUNT> \
  --config-id <CONFIG_ID> \
  --region <REGION> \
  --storage-lens-configuration '{
    "Id": "<CONFIG_ID>",
    "IsEnabled": true,
    "AccountLevel": {"BucketLevel": {}},
    "DataExport": {
      "StorageLensTableDestination": {"IsEnabled": true}
    }
  }'
```

**Register S3 Tables federated catalog in Glue** (required for Athena access):

```bash
aws glue create-catalog --region <REGION> --cli-input-json '{
  "Name": "s3tablescatalog",
  "CatalogInput": {
    "FederatedCatalog": {
      "Identifier": "arn:aws:s3tables:<REGION>:<ACCOUNT>:bucket/*",
      "ConnectionName": "aws:s3tables"
    }
  }
}'
```

For setup permissions and IAM role requirements, see [Security Considerations](#security-considerations) below.

### 3. Verify Permissions

Querying requires:

- Athena execution permissions
- S3 Tables read permissions (see least-privilege policy in Security Considerations)
- The S3 Tables federated catalog registered in Glue (`s3tablescatalog`)
- Athena workgroup with SSE-KMS encryption configured on the output location

If `CATALOG_NOT_FOUND` errors occur, the Glue integration may not be enabled. See:
[Integrating S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html)

### 4. Identify the Target Table

**S3 Metadata tables** — namespace is `b_<bucket-name>`:

| Table        | What it captures                                                                          |
| ------------ | ----------------------------------------------------------------------------------------- |
| `journal`    | Event log — every CREATE, DELETE, UPDATE_METADATA, and annotation events. Near real-time. |
| `inventory`  | Current state — one row per object (latest version). Updates within 1 hour.               |
| `annotation` | Annotation payloads — `text_value` column holds the full content. Near real-time.         |

**Storage Lens tables** — namespace is `lens_<config-id>_exp`:

| Table                      | What it captures                                                       |
| -------------------------- | ---------------------------------------------------------------------- |
| `default_storage_metrics`  | Per-bucket/prefix: object count, size, storage class breakdown. Daily. |
| `default_activity_metrics` | Per-bucket/prefix: GET/PUT/DELETE request counts. Daily.               |
| `bucket_property_metrics`  | Bucket config: versioning, encryption, lifecycle settings. Daily.      |

### 5. Query

**Query syntax:**

```sql
"s3tablescatalog/aws-s3"."<namespace>"."<table>"
```

**Constraints:**

- You MUST confirm workgroup and output location before executing
- You MUST ensure the Athena workgroup enforces SSE-KMS encryption on query results
- You MUST warn user that tables are read-only — no INSERT/UPDATE/DELETE
- You SHOULD use the key columns documented in this skill to build queries. If you need the full schema (e.g., AWS has added new columns), run `get-tables` once on any single namespace — schemas are identical across all instances of the same table type:

  ```
  aws glue get-tables --catalog-id "<ACCOUNT>:s3tablescatalog/aws-s3" --database-name "<namespace>" --region <REGION>
  ```

**Journal — audit who changed what:**

```sql
SELECT key, record_type, record_timestamp, requester, source_ip_address
FROM "s3tablescatalog/aws-s3"."b_<bucket>"."journal"
WHERE record_type = 'DELETE'
  AND record_timestamp > current_timestamp - interval '24' hour
ORDER BY record_timestamp DESC;
```

**Journal — track annotation events:**

```sql
SELECT key, record_type, annotation.name, record_timestamp
FROM "s3tablescatalog/aws-s3"."b_<bucket>"."journal"
WHERE record_type IN ('CREATE_ANNOTATION', 'DELETE_ANNOTATION', 'UPDATE_ANNOTATION_METADATA')
ORDER BY record_timestamp DESC LIMIT 20;
```

**Inventory — find objects by storage class:**

```sql
SELECT key, size, storage_class, last_modified_date
FROM "s3tablescatalog/aws-s3"."b_<bucket>"."inventory"
WHERE storage_class = 'GLACIER'
ORDER BY size DESC LIMIT 50;
```

**Inventory — find objects by tag:**

```sql
SELECT key, size, object_tags
FROM "s3tablescatalog/aws-s3"."b_<bucket>"."inventory"
WHERE object_tags['environment'] = 'staging';
```

**Annotation — search across payloads:**

```sql
SELECT object_key, name, text_value
FROM "s3tablescatalog/aws-s3"."b_<bucket>"."annotation"
WHERE text_value LIKE '%error%';
```

**Annotation — extract JSON fields:**

```sql
SELECT object_key, json_extract_scalar(text_value, '$.status') as status
FROM "s3tablescatalog/aws-s3"."b_<bucket>"."annotation"
WHERE name = 'pipeline_status'
  AND json_extract_scalar(text_value, '$.status') = 'FAILED';
```

**Storage Lens — storage distribution:**

```sql
SELECT *
FROM "s3tablescatalog/aws-s3"."lens_<config-id>_exp"."default_storage_metrics"
LIMIT 20;
```

### Routing: Athena vs Direct API

| Scenario                                    | Use                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Single known object + annotation name       | Direct API: `get-object-annotation`                                               |
| Aggregate/count across many objects         | Athena on annotation or inventory table                                           |
| Full-text search across annotation payloads | Athena with `LIKE` or `json_extract_scalar`                                       |
| Write/update an annotation                  | Direct API: `put-object-annotation` (table is read-only)                          |
| Feature not configured on bucket            | Direct API loop (`list-objects-v2` + `head-object`); suggest enabling S3 Metadata |

## Troubleshooting

| Error                         | Cause                                                     | Fix                                                                            |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CATALOG_NOT_FOUND`           | S3 Tables not registered in Glue                          | Enable integration: S3 console > Table buckets > Enable integration            |
| Empty results from journal    | Feature just enabled; no events recorded yet              | Upload/delete an object and wait ~1 minute                                     |
| Empty results from inventory  | Table still `BACKFILLING`                                 | Check status; wait for ACTIVE (minutes to hours depending on object count)     |
| `AccessDenied` querying table | Missing `s3tables:GetTable` or `GetTableMetadataLocation` | See Security Considerations below                                              |
| Wrong namespace               | Bucket name has periods                                   | Periods are converted to underscores in namespace: `my.bucket` → `b_my_bucket` |
| No Storage Lens data          | First delivery takes up to 48 hours                       | Wait; no historical backfill                                                   |

## Security Considerations

### Least-Privilege IAM Policy

Scope permissions to specific table bucket ARNs rather than using wildcards:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3tables:GetTable",
        "s3tables:GetTableMetadataLocation",
        "s3tables:GetTableData",
        "s3tables:GetNamespace",
        "s3tables:ListTables",
        "s3tables:ListNamespaces",
        "s3tables:GetTableBucket"
      ],
      "Resource": [
        "arn:aws:s3tables:<REGION>:<ACCOUNT>:bucket/aws-s3",
        "arn:aws:s3tables:<REGION>:<ACCOUNT>:bucket/aws-s3/*"
      ]
    }
  ]
}
```

### Data Sensitivity

Journal query results may contain sensitive fields:

- `requester` — AWS account ID or service principal that made the request
- `source_ip_address` — IP address of the requester

Query results containing these fields should be stored in encrypted, access-controlled locations. Avoid logging or sharing raw query output that contains IP addresses or principal identifiers.

### Encryption for Query Results

Configure the Athena workgroup with `EncryptionConfiguration` to encrypt query results at rest:

```json
{
  "ResultConfiguration": {
    "EncryptionConfiguration": {
      "EncryptionOption": "SSE_KMS",
      "KmsKey": "arn:aws:kms:<REGION>:<ACCOUNT>:key/<KEY_ID>"
    }
  }
}
```

### Audit Trail

Enable CloudTrail logging for Athena (`StartQueryExecution`, `GetQueryResults`) and S3 Tables (`s3tables:GetTableData`) API calls to maintain an audit trail of who queried what metadata. Ensure CloudTrail logs are encrypted with SSE-KMS and stored in a bucket with access logging enabled.

## Additional Resources

- [S3 Metadata overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-overview.html)
- [Journal table schema](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-schema.html)
- [Inventory table schema](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-inventory-schema.html)
- [Example metadata queries](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-example-queries.html)
- [S3 Annotations overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/annotations-overview.html)
- [Storage Lens S3 Tables export](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-lens-s3-tables-naming.html)
- [Setting up permissions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metadata-tables-permissions.html)
- [Integrating S3 Tables with AWS analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html)
