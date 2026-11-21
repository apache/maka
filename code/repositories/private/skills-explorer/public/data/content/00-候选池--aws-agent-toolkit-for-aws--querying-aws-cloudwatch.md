---
name: querying-aws-cloudwatch
description: >-
  Runs SQL queries on CloudWatch Logs data exported as Apache Iceberg tables in S3 Tables.
  Covers VPC Flow Logs, WAF logs, CloudFront access logs, Route 53 resolver logs, Network
  Firewall logs, EKS audit logs, Verified Access logs, SES logs, VPC Lattice logs, Step
  Functions logs, NLB access logs, and 20+ other AWS vended data sources. Applies when
  analyzing network traffic, investigating security incidents, querying exported logs with
  SQL, enabling S3 Tables integration, configuring log export, correlating logs with other
  data, or running Athena queries on the aws-cloudwatch table bucket. Trigger phrases: query
  logs with SQL, analyze logs in Athena, SQL on VPC flow logs, investigate network traffic,
  run SQL on exported logs, enable S3 Tables for CloudWatch, correlate logs, historical log
  analysis, set up log querying.
version: 1
argument-hint: "[query|data-source-name|'configure'|'status']"
---

# Query AWS CloudWatch System Tables

## Overview

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) for sandboxed execution and audit logging. All commands below use the AWS CLI and work in any environment with configured AWS credentials.

The CloudWatch Logs S3 Tables integration exports log data as Apache Iceberg tables in the AWS-managed `aws-cloudwatch` table bucket. This enables SQL analysis via Amazon Athena and correlation of log data with non-CloudWatch data (S3 metadata, business tables, etc.). Available at no additional storage charge beyond CloudWatch ingestion pricing.

## Decision Tree

| User intent                                          | Use this skill?                | Alternative                                         |
| ---------------------------------------------------- | ------------------------------ | --------------------------------------------------- |
| Run SQL across large volumes of log data             | **Yes**                        | —                                                   |
| Correlate logs with S3 metadata or other tables      | **Yes** — join across catalogs | —                                                   |
| Quick log search / pattern matching                  | **No**                         | CloudWatch Logs Insights (faster for ad-hoc)        |
| Real-time log streaming/tailing                      | **No**                         | CloudWatch Logs console or `logs filter-log-events` |
| Set up alarms on log patterns                        | **No**                         | CloudWatch Metric Filters / Alarms                  |
| Query historical logs before integration was enabled | **No**                         | CloudWatch Logs (no backfill in S3 Tables)          |

## Supported Data Sources

The following data sources are available through the S3 Tables integration. Each data source has a namespace pattern used in SQL queries. Not all AWS vended data sources may be available in all Regions; check the CloudWatch console Data Sources tab for current availability.

| Data Source                  | Namespace pattern                    | Common use case                                |
| ---------------------------- | ------------------------------------ | ---------------------------------------------- |
| VPC Flow Logs                | `amazon_vpc__flow`                   | Network traffic analysis, rejected connections |
| WAF Logs                     | `aws_waf__logs`                      | Blocked requests, rule hit analysis            |
| CloudFront Access Logs       | `amazon_cloudfront__access`          | CDN traffic patterns, error rates              |
| Route 53 Resolver Query Logs | `amazon_route53resolver__query`      | DNS query analysis                             |
| Network Firewall Logs        | `aws_networkfirewall__logs`          | Firewall rule hits, dropped traffic            |
| EKS Audit Logs               | `amazon_eks__audit`                  | Kubernetes API audit trail                     |
| Verified Access Logs         | `amazon_verifiedaccess__logs`        | Zero-trust access decisions                    |
| SES Mail Logs                | `amazon_ses__mail`                   | Email delivery/bounce tracking                 |
| VPC Lattice Access Logs      | `amazon_vpclattice__access`          | Service-to-service access patterns             |
| Step Functions Logs          | `aws_stepfunctions__logs`            | Workflow execution debugging                   |
| Global Accelerator Flow Logs | `aws_globalaccelerator__flow`        | Global network traffic                         |
| NLB Access Logs              | `elastic_load_balancing__nlb_access` | Load balancer request tracing                  |
| Shield Logs                  | `aws_shield__logs`                   | DDoS mitigation events                         |
| Cognito Logs                 | `amazon_cognito__logs`               | Auth/identity operations                       |
| ElastiCache Logs             | `amazon_elasticache__logs`           | Redis slow log, engine log                     |
| SageMaker Logs               | `amazon_sagemaker__logs`             | ML training/inference events                   |
| WorkMail Audit Logs          | `amazon_workmail__audit`             | Email security/compliance                      |
| Bedrock Agent Logs           | `aws_bedrock_agent_core__logs`       | AI agent invocations                           |
| Client VPN Logs              | `aws_client_vpn__connections`        | VPN connection tracking                        |
| Entity Resolution Logs       | `aws_entity_resolution__logs`        | Record matching operations                     |
| MediaPackage Access Logs     | `aws_elemental_mediapackage__access` | Streaming delivery metrics                     |
| MediaTailor Logs             | `aws_elemental_mediatailor__logs`    | Ad insertion events                            |
| Transfer Family Logs         | `aws_transfer_family__logs`          | SFTP/FTPS file transfer tracking               |
| Site-to-Site VPN Logs        | `aws_site_to_site_vpn__logs`         | VPN tunnel diagnostics                         |

> **Note**: This table lists the 24 most commonly queried data sources. The integration supports 43+ AWS vended data sources in total. Use `list-namespaces` on the `aws-cloudwatch` bucket to discover all available data sources in your account. Namespace patterns follow the convention `<service>__<type>`.

## Common Tasks

### 1. Check If Configured

```bash
# Check if the aws-cloudwatch table bucket exists
aws s3tables list-table-buckets --region <REGION> \
  --query "tableBuckets[?name=='aws-cloudwatch']"
```

- Empty result → integration not enabled. Guide user through setup.
- Bucket exists but no namespaces → integration enabled but no log data yet (only captures events _after_ association).

List available tables:

```bash
aws s3tables list-namespaces --table-bucket-arn arn:aws:s3tables:<REGION>:<ACCOUNT>:bucket/aws-cloudwatch --region <REGION>

aws s3tables list-tables --table-bucket-arn arn:aws:s3tables:<REGION>:<ACCOUNT>:bucket/aws-cloudwatch --namespace <NAMESPACE> --region <REGION>
```

### 2. Enable / Configure

**Create integration:**

```bash
aws observabilityadmin create-s3-table-integration \
  --region <REGION> \
  --encryption '{"SseAlgorithm": "aws:kms", "KmsKeyArn": "<KMS_KEY_ARN>"}' \
  --role-arn <SERVICE_ROLE_ARN>
```

**Associate a specific data source (recommended):**

```bash
aws logs associate-source-to-s3-table-integration \
  --region <REGION> \
  --integration-arn <INTEGRATION_ARN> \
  --data-source '{"name": "<source-name>", "type": "<source-type>"}'
```

**Associate all data sources (wildcard):**

> ⚠️ **Warning**: Wildcard association delivers all current and future data sources to S3 Tables. Use specific associations for tighter control over what log data lands in queryable tables.

```bash
aws logs associate-source-to-s3-table-integration \
  --region <REGION> \
  --integration-arn <INTEGRATION_ARN> \
  --data-source '{"name": "*", "type": "*"}'
```

For IAM requirements (service role trust policy, permissions policy, condition keys), see [Security Considerations](#security-considerations) below.

### 3. Verify Permissions for Querying

Requires:

- S3 Tables federated catalog registered in Glue (`s3tablescatalog`)
- Lake Formation SELECT + DESCRIBE grants on the table (or IAM-only mode in supported regions)
- Athena execution permissions

Grant access:

```bash
aws lakeformation grant-permissions \
  --principal DataLakePrincipalIdentifier=<ROLE_ARN> \
  --resource '{"Table": {"CatalogId": "<ACCOUNT>:s3tablescatalog/aws-cloudwatch", "DatabaseName": "<NAMESPACE>", "Name": "<TABLE>"}}' \
  --permissions DESCRIBE SELECT \
  --region <REGION>
```

### 4. Query

**Query syntax:**

```sql
"s3tablescatalog/aws-cloudwatch"."<namespace>"."<table>"
```

**Constraints:**

- You MUST ALWAYS run get-tables on the target namespace and include the command in your response before writing any SQL query — schemas vary by data source. Never skip this step even if you already know the likely schema. Run `get-tables` once on the target namespace (one call returns all tables + columns + types + descriptions):

  ```
  aws glue get-tables --catalog-id "<ACCOUNT>:s3tablescatalog/aws-cloudwatch" --database-name "<namespace>" --region <REGION>
  ```

- You MUST confirm workgroup and output location before executing
- You MUST inform user that only logs received _after_ association are available (no backfill)

**Example — VPC Flow Logs rejected traffic:**

```sql
SELECT srcaddr, dstaddr, dstport, protocol, packets, bytes
FROM "s3tablescatalog/aws-cloudwatch"."amazon_vpc__flow"."<table>"
WHERE action = 'REJECT'
ORDER BY bytes DESC
LIMIT 50;
```

**Example — WAF blocked requests:**

```sql
SELECT timestamp, action, terminatingRuleId, httpSourceId
FROM "s3tablescatalog/aws-cloudwatch"."aws_waf__logs"."<table>"
WHERE action = 'BLOCK'
ORDER BY timestamp DESC
LIMIT 50;
```

**Example — correlate VPC Flow Logs with S3 object metadata:**

```sql
SELECT f.srcaddr, f.dstaddr, f.bytes, j.key, j.record_type
FROM "s3tablescatalog/aws-cloudwatch"."amazon_vpc__flow"."<table>" f
JOIN "s3tablescatalog/aws-s3"."b_<bucket>"."journal" j
  ON f.srcaddr = j.source_ip_address
WHERE j.record_type = 'CREATE'
  AND f.action = 'ACCEPT';
```

## Key Behaviors

- **No backfill** — only new log events after association are delivered to S3 Tables
- **Retention follows log group** — when log group retention expires, data is removed from the table
- **Deleting a log group** removes its data from the S3 table
- **No additional storage charge** — included in CloudWatch pricing
- **Schemas are per-data-source** — always run `get-tables` on the target namespace before building complex queries

## Troubleshooting

| Error                              | Cause                                                           | Fix                                                                   |
| ---------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `aws-cloudwatch` bucket not found  | Integration not created                                         | Run `create-s3-table-integration`                                     |
| Bucket exists but no namespaces    | No data sources associated, or no log traffic since association | Associate sources; generate traffic                                   |
| `CATALOG_NOT_FOUND` in Athena      | S3 Tables not registered in Glue                                | Enable integration: S3 console > Table buckets > Enable integration   |
| `AccessDenied` on query            | Missing Lake Formation grants or IAM permissions                | See Security Considerations below                                     |
| Empty results                      | Logs only flow after association; no backfill                   | Confirm association exists and log source is actively generating data |
| Schema mismatch / column not found | Log type schema updated by AWS                                  | Run `get-tables` on the namespace to get current columns              |

## Security Considerations

### Service Role Trust Policy

The service role must allow `logs.amazonaws.com` to assume it. Always include `aws:SourceAccount` and `aws:SourceArn` condition keys to prevent confused deputy attacks:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "logs.amazonaws.com"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "aws:SourceAccount": "<ACCOUNT>"
        },
        "ArnLike": {
          "aws:SourceArn": ["arn:aws:logs:<REGION>:<ACCOUNT>:log-group:<LOG_GROUP_NAME>"]
        }
      }
    }
  ]
}
```

### Service Role Permissions Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:integrateWithS3Table"],
      "Resource": ["arn:aws:logs:<REGION>:<ACCOUNT>:log-group:<LOG_GROUP_NAME>"],
      "Condition": {
        "StringEquals": {
          "aws:ResourceAccount": "<ACCOUNT>"
        }
      }
    }
  ]
}
```

### KMS Key Policy (for encrypted data)

If using a customer managed KMS key, grant both service principals access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnableSystemTablesKeyUsage",
      "Effect": "Allow",
      "Principal": { "Service": "systemtables.cloudwatch.amazonaws.com" },
      "Action": ["kms:DescribeKey", "kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT>:key/<KEY_ID>",
      "Condition": { "StringEquals": { "aws:SourceAccount": "<ACCOUNT>" } }
    },
    {
      "Sid": "EnableS3TablesMaintenanceKeyUsage",
      "Effect": "Allow",
      "Principal": { "Service": "maintenance.s3tables.amazonaws.com" },
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT>:key/<KEY_ID>",
      "Condition": {
        "StringLike": { "kms:EncryptionContext:aws:s3:arn": "<TABLE_OR_TABLE_BUCKET_ARN>/*" }
      }
    }
  ]
}
```

### Data Sensitivity

Log data may contain PII including IP addresses, user agents, request parameters, and authentication tokens. Treat all exported log tables as sensitive by default.

### Access Control Best Practices

- Use Lake Formation column-level security to restrict access to sensitive columns (e.g., `srcaddr`, `source_ip_address`, `httpRequest`). Grant permissions to specific tables and columns rather than wildcards.
- Configure SSE-KMS encryption on the Athena workgroup output bucket to protect query results at rest.
- Prefer specific data source associations over wildcard (`*/*`) to limit which data sources are exported to queryable tables.

### Audit Trail

Enable CloudTrail logging for Athena (`StartQueryExecution`, `GetQueryResults`) and Lake Formation (`GrantPermissions`, `RevokePermissions`) API calls to maintain an audit trail of who queried what data.

## Additional Resources

- [CloudWatch Logs S3 Tables integration](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/s3-tables-integration.html)
- [Supported AWS vended data sources](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AWS-logs-and-resource-types.html)
- [IAM permissions for integration](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/s3-tables-integration.html#s3-tables-integration-iam-permissions)
- [Integrating S3 Tables with analytics services](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-aws.html)
- [Lake Formation permissions](https://docs.aws.amazon.com/lake-formation/latest/dg/granting-catalog-permissions.html)
