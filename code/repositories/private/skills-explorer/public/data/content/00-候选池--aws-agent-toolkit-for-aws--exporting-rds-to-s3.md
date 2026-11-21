---
name: exporting-rds-to-s3
description: Exports Amazon RDS or Aurora database snapshots to Amazon S3 in Apache Parquet format for analytics, backup, or data migration. Handles snapshot selection or creation, IAM role setup, KMS encryption, S3 bucket preparation, export task execution, progress monitoring, and data verification. Use when exporting RDS/Aurora data to S3 for Athena, Glue, or Redshift Spectrum consumption.
version: 1
---

# Exporting RDS/Aurora to S3

## Overview

Domain expertise for exporting Amazon RDS and Aurora database snapshots to Amazon S3
in Apache Parquet format. Covers the full workflow: snapshot identification or creation,
IAM role and KMS encryption setup, S3 bucket preparation, export task initiation,
progress monitoring, data verification, and post-export access guidance for analytics
services like Athena, Glue, and Redshift Spectrum.

## Export an RDS or Aurora snapshot to S3

To export a database snapshot to S3 with proper IAM roles, encryption, and monitoring,
follow the procedure exactly.
See [RDS to S3 export procedure](references/export-rds-to-s3.md).

## Troubleshooting

### Database not found

Verify the database identifier spelling, case, and region. For Aurora, use `describe-db-clusters` instead of `describe-db-instances`.

### Export not supported

Snapshot export supports MySQL, PostgreSQL, MariaDB, Aurora MySQL, and Aurora PostgreSQL only. Oracle and SQL Server are not supported.

### IAM role permission errors

Ensure the role trust policy allows `export.rds.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` conditions for confused deputy protection, and has S3 PutObject and KMS permissions. Wait 10–15 seconds after role creation for propagation.

### Export stuck or failed

Check the export task status for failure reasons. Common causes: S3 bucket deleted, IAM role modified, or KMS key disabled during export. See the [full procedure](references/export-rds-to-s3.md) for detailed troubleshooting.
