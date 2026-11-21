---
name: managing-amazon-kinesis-data-streams
description: >-
  Operates Amazon Kinesis Data Streams (KDS). Covers streaming tables and Amazon S3
  delivery - serverless, fully managed delivery from a KDS stream to Apache Iceberg
  tables on S3 Tables or to general-purpose S3 buckets. Includes channel setup, IAM,
  schemas, output key templates, CloudWatch metrics and alarms, DLQ handling, quotas,
  and troubleshooting. For all other KDS topics and questions, search AWS documentation
  and blogs instead. Triggers: Kinesis Data Streams, KDS, streaming tables, stream
  to S3, stream to Iceberg, stream to S3 Tables, KDS delivery, KDS channel, CreateChannel,
  data channel, data freshness, dead-letter queue, KDS lakehouse, serverless Kinesis
  delivery, Firehose alternative for KDS, zero-ops Kinesis to S3. DO NOT USE for Kinesis
  Data Firehose, Kinesis Video Streams, or Managed Service for Apache Flink — use
  dedicated skills or search documentation instead.
version: 1
---

# Amazon Kinesis Data Streams

## Overview

Domain expertise for Amazon Kinesis Data Streams. This skill covers **streaming tables and Amazon S3 delivery**, which provide serverless, fully managed delivery from a KDS stream directly to Apache Iceberg tables on S3 Tables or to general-purpose S3 buckets — no consumers, no Firehose, no Flink required for append-only delivery.

Delivery is configured as a **channel** on a stream via `CreateChannel`. Channels consume no shard capacity and no enhanced fan-out slots, so they do not compete with existing consumers.

The AWS MCP server is recommended for executing AWS operations. When the MCP server is not available, use the AWS CLI or shell commands instead.

## Which Workflow Do You Need?

| Customer Intent                                                                                                                                 | Reference                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deliver stream data to Apache Iceberg tables on S3 Tables — setup, IAM, Glue schema, type mapping, partitioning, channel lifecycle              | [references/streaming-tables.md](references/streaming-tables.md)                                                                                             |
| Deliver stream data to a general-purpose S3 bucket as objects — setup, IAM, compression, storage class, output key templates, channel lifecycle | [references/general-purpose-delivery-to-s3.md](references/general-purpose-delivery-to-s3.md)                                                                 |
| Build a lakehouse / data lake from Kinesis; make streaming data queryable in Athena                                                             | [references/streaming-tables.md](references/streaming-tables.md)                                                                                             |
| Zero-ops, serverless alternative to Firehose or Kinesis consumers for KDS → S3 delivery                                                         | [references/general-purpose-delivery-to-s3.md](references/general-purpose-delivery-to-s3.md)                                                                 |
| CloudWatch metrics and alarms, delivery logging, CloudTrail, encryption, channel states, quotas, naming rules, what can be updated              | [references/monitoring-security-and-limits.md](references/monitoring-security-and-limits.md)                                                                 |
| Channel is ACTIVE but no data arrives; records landing in the DLQ; rising data freshness                                                        | Start with [references/monitoring-security-and-limits.md](references/monitoring-security-and-limits.md), then the destination-specific troubleshooting table |
| Deliver to both S3 and S3 Tables from one stream                                                                                                | Supported — create one channel per destination                                                                                                               |

## Prerequisites

Both destinations require an **ON_DEMAND stream** — provisioned-mode streams are not supported. Each channel also needs an IAM service execution role trusted by `kinesis.amazonaws.com`, and a destination in the **same Region** as the stream.

## Hard Limits to Check First

These rule out the feature entirely, so confirm them before designing a solution:

- **Append-only** — no CDC, upserts, or deletes
- **No schema evolution** — a schema change means deleting and recreating the channel
- **No backfill** — only records produced after the channel is `ACTIVE` are delivered
- **No transformations** — records are delivered as-is
- **New table per channel** — cannot deliver into an existing Iceberg table
- **Data freshness is 300–900 seconds** — not sub-minute
- **Same Region only** — cross-account is supported, cross-Region is not

If any of these block the customer, recommend **Managed Service for Apache Flink** instead.

## Additional Resources

- [KDS Developer Guide](https://docs.aws.amazon.com/streams/latest/dev/introduction.html)
- [KDS API Reference](https://docs.aws.amazon.com/kinesis/latest/APIReference/)
- [S3 Tables Developer Guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables.html)
- [Glue Schema Registry](https://docs.aws.amazon.com/glue/latest/dg/schema-registry.html)
