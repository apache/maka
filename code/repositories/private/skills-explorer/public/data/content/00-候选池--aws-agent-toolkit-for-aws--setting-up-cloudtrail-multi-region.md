---
name: setting-up-cloudtrail-multi-region
description: Enables a multi-region AWS CloudTrail trail with S3 log storage, CloudWatch Logs integration, and CloudWatch Logs Insights queries for security monitoring and compliance auditing. Use when setting up centralized API activity logging across all AWS regions.
version: 1
---

# Setting Up CloudTrail Multi-Region

## Overview

Domain expertise for enabling AWS CloudTrail across all regions to capture
comprehensive API activity logs and configuring CloudWatch Logs Insights for
security monitoring, compliance auditing, and operational analysis.

## Set up a multi-region trail

To create a centralized multi-region CloudTrail trail with S3 storage, CloudWatch
Logs integration, and log analysis, follow the procedure exactly.
See [CloudTrail multi-region setup procedure](references/cloudtrail-multi-region-setup.md).

## Troubleshooting

### S3 bucket already exists

Choose a different globally unique name, or add a timestamp or organization identifier.

### Permission denied errors

Verify your identity with `aws sts get-caller-identity`. Ensure your user/role has required actions attached. Do NOT use `*FullAccess` managed policies.

### Trail not logging

Verify IAM role permissions, check S3 bucket policy allows CloudTrail access, and ensure the trail is started with `start-logging`.

### Missing events in CloudWatch

Allow 5-15 minutes for initial log delivery. Verify the CloudWatch Logs role ARN is correct and the log group exists in the same region as the trail.

### Opt-in region events not appearing

This is normal — events from opt-in regions may take several hours. Wait up to 24 hours before investigating further.
